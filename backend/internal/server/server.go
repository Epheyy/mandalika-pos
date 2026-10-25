package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	"github.com/mandalika/pos-backend/internal/handlers"
	"github.com/mandalika/pos-backend/internal/httpx"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/observability"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/redact"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/uploads"
	"github.com/mandalika/pos-backend/internal/write"
)

// healthRetryAfterSeconds is the Retry-After on the 503 "db down" health answer.
const healthRetryAfterSeconds = 5

type pinger interface {
	Ping(ctx context.Context) error
}

// healthHandler is the deep check: the database is required (503 when down);
// Redis is an optional cache, so a down or disabled Redis is reported as
// "degraded" with HTTP 200.
func healthHandler(database pinger, c *cache.Cache) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if err := database.Ping(req.Context()); err != nil {
			w.Header().Set("Retry-After", strconv.Itoa(healthRetryAfterSeconds))
			httpx.Err(w, http.StatusServiceUnavailable, "db down")
			return
		}
		redis := c.Status()
		status := "ok"
		if redis != "ok" {
			status = "degraded"
		}
		httpx.JSON(w, http.StatusOK, map[string]string{"status": status, "db": "ok", "redis": redis})
	}
}

func New(cfg *config.Config, database *db.DB, c *cache.Cache, sentry *observability.Sentry) http.Handler {
	r := chi.NewRouter()
	// Built early: the panic recoverer persists backend errors to error_logs.
	wr := write.New(database.Pool)
	r.Use(chimw.RequestID)
	r.Use(mw.ClientIP(cfg.TrustedProxyHops))
	r.Use(mw.RequestLogger)
	r.Use(sentryRecoverer(sentry, wr))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "X-Outlet-Id", "Idempotency-Key"},
		AllowCredentials: true,
		MaxAge:           300,
	}))
	// Global per-IP rate limit; a POS device bursts on sync but stays modest.
	r.Use(mw.RateLimit(c, "api", cfg.RateLimitRPS*60, time.Minute))
	// Global request-body cap (1 MiB) with a documented exception table.
	r.Use(mw.BodyLimit(bodyLimitFor))
	// Server-side context deadline (15 s default, 28 s for long routes, exempt imports);
	// documented per path in deadlineExceptions.
	r.Use(mw.Deadline(deadlineFor))

	store := auth.NewStore(database.Pool)
	ah := auth.NewHandler(cfg, store, c)
	rd := read.New(database.Pool)
	os := service.NewOrderService(database.Pool)
	signer := &uploads.Signer{
		CloudName: cfg.CloudinaryName,
		APIKey:    cfg.CloudinaryKey,
		APISecret: cfg.CloudinarySecret,
	}
	syncEngine := syncpkg.New(database.Pool, rd, os, wr)
	syncEngine.LegacyEnvelopeUntil = cfg.SyncLegacyEnvelopeUntil
	syncEngine.StockSeqOff = cfg.SyncStockSeqOff
	syncEngine.ContactKey = syncpkg.DeriveContactKey(cfg.AccessSecret)
	h := handlers.New(rd, c, store, wr, os, syncEngine, signer)
	// ERP outbox relay (plan step 5)
	eo := handlers.NewErpOutbox(database.Pool, config.LoadERPRelay(cfg), cfg.IsProd())
	h.SetErpCatalogRunner(handlers.NewErpCatalogRunner(cfg, database.Pool, slog.Default()))

	// Cloud Run reserves /healthz (Google answers 404 before the app sees it), so
	// the same deep check is also served at /livez. No auth, no secrets, no PII.
	health := healthHandler(database.Pool, c)
	r.Get("/healthz", health)
	r.Get("/livez", health)

	// Liveness: process is up. Used by the platform health check; must not
	// touch dependencies so a transient DB blip doesn't kill the instance.
	r.Get("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	r.Route("/api/v1", func(r chi.Router) {
		// ERP outbox relay (plan step 5): Cloud Scheduler trigger, shared secret
		// (X-Scheduler-Secret), no JWT. Step 4's /internal/erp/* convention.
		r.With(mw.RateLimit(c, "erp-relay", 30, time.Minute), mw.RequireSchedulerSecret(cfg)).Post("/internal/erp/relay", eo.SchedulerRelay)

		// Credential endpoints get a strict per-IP limit to blunt
		// brute-force and token-spray; the global limit still applies.
		r.Group(func(r chi.Router) {
			r.Use(mw.RateLimit(c, "auth", 10, time.Minute))
			r.Post("/auth/login", ah.Login)
			r.Post("/auth/refresh", ah.Refresh)
			r.Post("/auth/logout", ah.Logout)
		})

		// Public Capgo self-hosted OTA update check (no auth; bare JSON). Its own
		// generous per-IP limit (NOT the strict "auth" bucket) so a whole outlet
		// of tablets polling on app-open behind one NAT can't starve cashier logins.
		r.Group(func(r chi.Router) {
			r.Use(mw.RateLimit(c, "ota", 120, time.Minute))
			r.Post("/ota/check", h.OtaCheck)
		})

		// ERP catalog pull trigger for Cloud Scheduler (plan §4.4, D15): outside RequireAuth,
		// guarded by the X-Scheduler-Secret shared secret and its own small rate-limit bucket.
		r.Group(func(r chi.Router) {
			r.Use(mw.RateLimit(c, "erp-catalog", 10, time.Minute))
			r.Use(mw.RequireSchedulerSecret(cfg))
			r.Post("/internal/erp/catalog-pull", h.ErpCatalogPullScheduler)
		})

		r.Group(func(r chi.Router) {
			r.Use(mw.RequireAuth(cfg))
			r.Get("/auth/me", ah.Me)

			// Catalog / reference (any authenticated user; cashier sells).
			r.Get("/products", h.Products)
			r.Get("/products/{id}", h.Product)
			r.Get("/categories", h.Categories)
			r.Get("/bundles", h.Bundles)
			r.Get("/outlets", h.Outlets)
			r.Get("/warehouses", h.Warehouses)
			r.Get("/warehouses/{id}/stock", h.WarehouseStock)
			r.Get("/promotions", h.Promotions)
			r.Get("/discount-codes", h.DiscountCodes)
			r.Get("/loyalty-conditions", h.LoyaltyConditions)
			r.Get("/settings/app", h.AppSettings)
			r.Get("/settings/loyalty", h.LoyaltySettings)

			// Sales (outlet-scoped in repo via resolved Scope).
			r.Get("/orders", h.Orders)
			r.Get("/orders/{id}", h.Order)
			r.Get("/shifts", h.Shifts)
			r.Get("/shifts/current", h.CurrentShift)
			r.Get("/shifts/{id}", h.Shift)
			r.Get("/stock-counts", h.StockCounts)
			r.Get("/stock-counts/{id}", h.StockCount)
			// Permintaan Barang reads: request_stock (own outlet) or manage_inventory, checked in the handler.
			r.Get("/requisitions", h.Requisitions)
			r.Get("/requisitions/{id}", h.Requisition)
			r.Get("/cash-flows", h.CashFlows)

			// ── Sales writes (POS; cashier authenticated, outlet from JWT) ──
			r.Post("/orders", h.CreateOrder)
			r.With(mw.RequirePermission("process_refund")).
				Post("/orders/{id}/refund", h.RefundOrder)
			r.Post("/shifts", h.OpenShift)
			r.Post("/shifts/{id}/close", h.CloseShift)
			r.Post("/cash-flows", h.CreateCashFlow)
			// Client error reporting (sync/runtime/print) — any authenticated device.
			r.Post("/error-logs", h.CreateErrorLogs)

			// ── Offline sync (plan §5) ──
			r.Get("/sync/version", h.SyncVersion)
			r.Get("/sync/pull", h.SyncPull)
			r.Post("/sync/batch", h.SyncBatch)
			r.Post("/sync/review-items", h.ReportSyncReviewItems)
			// Receipt-number device code (one per install per outlet; see write/device.go).
			r.Post("/pos/devices/register", h.RegisterPOSDevice)
			r.Get("/sync/inbound-transfers", h.GetInboundTransfers)
			r.Get("/sync/outlet-transfers", h.GetOutletTransfers)
			r.Get("/sync/customers/lookup", h.CustomersLookup)
			r.Post("/sync/loyalty-preview", h.LoyaltyPreview)
			// A08 online step-up for transfer receive. The mint has its own coarse per-IP
			// bucket (each call costs an argon2 hash); the real brake is the server-side
			// per-user lockout in Postgres.
			r.Get("/sync/receive-approvers", h.ListReceiveApprovers)
			r.With(mw.RateLimit(c, "pinstep", 20, time.Minute)).
				Post("/sync/transfer-receive-approvals", h.CreateTransferReceiveApproval)

			// ── Reference-data writes (Backoffice; permission-gated, bump
			// content_version → POS sync wall) ──
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_products"))
				r.Post("/products/import", h.ImportProducts) // static path before /products/{id}
				r.Post("/products", h.CreateProduct)
				r.Put("/products/{id}", h.UpdateProduct)
				r.Delete("/products/{id}", h.DeleteProduct)
				r.Get("/products/{id}/outlet-config", h.GetProductOutletConfig)
				r.Put("/products/{id}/outlet-config", h.PutProductOutletConfig)
				r.Post("/categories", h.CreateCategory)
				r.Put("/categories/{id}", h.UpdateCategory)
				r.Delete("/categories/{id}", h.DeleteCategory)
				r.Post("/uploads/sign", h.SignUpload)
			})
			r.Group(func(r chi.Router) {
				// A30: customer data beyond an exact phone lookup. Admin, or manage_customers for a
				// non-cashier; cashiers use /sync/customers/lookup (phone-only) instead.
				r.Use(handlers.RequireCustomerReader())
				r.Get("/customers", h.Customers)
				r.Get("/customers/{id}", h.Customer)
				r.Get("/customers/by-phone", h.CustomersByPhone)
				r.Post("/customers/import", h.ImportCustomers)
				r.Post("/customers", h.CreateCustomer)
				r.Put("/customers/{id}", h.UpdateCustomer)
				r.Delete("/customers/{id}", h.DeleteCustomer)
				r.Get("/tags", h.Tags)
				r.Post("/tags", h.CreateTag)
				r.Put("/tags/{id}", h.UpdateTag)
				r.Delete("/tags/{id}", h.DeleteTag)
				r.Put("/customers/{id}/tags", h.SetCustomerTags)
				r.Get("/segments", h.Segments)
				r.Post("/segments", h.CreateSegment)
				r.Put("/segments/reorder", h.ReorderSegments)
				r.Put("/segments/{id}", h.UpdateSegment)
				r.Delete("/segments/{id}", h.DeleteSegment)
				r.Get("/customers/reminders", h.Reminders)
				r.Get("/customers/dup-candidates", h.DupCandidates)
				r.Get("/customers/dup-candidates/{id}", h.DupCandidate)
				r.Post("/customers/dup-candidates/{id}/dismiss", h.DismissDupCandidate)
				r.Get("/customers/{id}/interactions", h.Interactions)
				r.Post("/customers/{id}/interactions", h.CreateInteraction)
				r.Delete("/customers/{id}/interactions/{iid}", h.DeleteInteraction)
				r.Get("/customers/{id}/points", h.PointTransactions)
				r.Get("/customers/{id}/reward-grants", h.RewardGrants)
			})

			// Head-office review of refused tablet items (no content-version bump).
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("resolve_sync_review"))
				r.Get("/sync-review-items", h.ListSyncReviewItems)
				r.Post("/sync-review-items/{key}/resolve", h.ResolveSyncReviewItem)
			})
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_promotions"))
				r.Post("/promotions", h.CreatePromotion)
				r.Put("/promotions/{id}", h.UpdatePromotion)
				r.Delete("/promotions/{id}", h.DeletePromotion)
				r.Post("/discount-codes", h.CreateDiscountCode)
				r.Post("/discount-codes/batch", h.CreateDiscountCodeBatch)
				r.Put("/discount-codes/{id}", h.UpdateDiscountCode)
				r.Delete("/discount-codes/{id}", h.DeleteDiscountCode)
			})
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_outlets"))
				r.Post("/outlets", h.CreateOutlet)
				r.Put("/outlets/{id}", h.UpdateOutlet)
			})
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_inventory"))
				r.Post("/warehouses", h.CreateWarehouse)
				r.Put("/warehouses/{id}", h.UpdateWarehouse)
				r.Delete("/warehouses/{id}", h.DeleteWarehouse)
				// inventory location stock ops (polymorphic: outlet OR warehouse)
				r.Post("/inventory/goods-receipt", h.CreateLocationGoodsReceipt)
				r.Post("/inventory/adjust", h.AdjustLocationStock)
				r.Put("/inventory/outlet-par", h.SetOutletPar)
				r.Get("/inventory/overview", h.InventoryOverview)
				r.Get("/inventory/ingredient-overview", h.IngredientOverview)
				r.Get("/inventory/movement-summary", h.MovementSummary)
				// transfers (mesh; static path registered before /{id})
				r.Get("/transfers", h.Transfers)
				r.Get("/transfers/location-stock", h.TransferLocationStock)
				r.Get("/transfers/{id}", h.Transfer)
				r.Post("/transfers", h.CreateTransfer)
				r.Put("/transfers/{id}", h.UpdateTransfer)
				r.Post("/transfers/{id}/send", h.SendTransfer)
				r.Post("/transfers/{id}/receive", h.ReceiveTransfer)
				r.Post("/transfers/{id}/cancel", h.CancelTransfer)
				// ingredients (recipe module; flag-gated)
				r.Group(func(r chi.Router) {
					r.Use(mw.RequireRecipesEnabled(rd))
					r.Get("/ingredients", h.Ingredients)
					r.Post("/ingredients/import", h.ImportIngredients)
					r.Post("/ingredients", h.CreateIngredient)
					r.Put("/ingredients/{id}", h.UpdateIngredient)
					r.Delete("/ingredients/{id}", h.DeleteIngredient)
					r.Get("/ingredients/{id}/usage", h.IngredientUsage)
					// polymorphic ingredient stock ops (outlet OR warehouse)
					r.Get("/inventory/ingredient-location-stock", h.IngredientLocationStock)
					r.Post("/inventory/ingredient-goods-receipt", h.CreateIngredientLocationGoodsReceipt)
					r.Post("/inventory/ingredient-adjust", h.AdjustIngredientLocationStock)
					r.Get("/ingredient-categories", h.IngredientCategories)
					r.Post("/ingredient-categories", h.CreateIngredientCategory)
					r.Put("/ingredient-categories/{id}", h.UpdateIngredientCategory)
					r.Delete("/ingredient-categories/{id}", h.DeleteIngredientCategory)
					r.Get("/ingredient-transfers", h.IngredientTransfers)
					r.Get("/ingredient-transfers/{id}", h.IngredientTransfer)
					r.Post("/ingredient-transfers", h.CreateIngredientTransfer)
					r.Post("/ingredient-transfers/{id}/send", h.SendIngredientTransfer)
					r.Post("/ingredient-transfers/{id}/receive", h.ReceiveIngredientTransfer)
					r.Post("/ingredient-transfers/{id}/cancel", h.CancelIngredientTransfer)
					r.Get("/ingredient-stock-counts", h.IngredientStockCounts)
					r.Get("/ingredient-stock-counts/{id}", h.IngredientStockCount)
					r.Post("/ingredient-stock-counts", h.CreateIngredientStockCount)
					r.Post("/ingredient-stock-counts/{id}/start", h.StartIngredientStockCount)
					r.Put("/ingredient-stock-counts/{id}/save", h.SaveIngredientStockCount)
					r.Post("/ingredient-stock-counts/{id}/complete", h.CompleteIngredientStockCount)
					// recipes (SP-Recipe-2; per-variant, reuse manage_inventory + recipes flag)
					r.Get("/products/{productId}/recipe-variant-ids", h.RecipeVariantIDs)
					r.Get("/products/{productId}/variants/{variantId}/recipe", h.VariantRecipe)
					r.Post("/products/{productId}/variants/{variantId}/recipe", h.SaveVariantRecipe)
					r.Get("/products/{productId}/variants/{variantId}/recipe/versions", h.RecipeVersions)
					r.Get("/products/{productId}/variants/{variantId}/recipe/versions/{versionId}", h.RecipeVersion)
					r.Post("/products/{productId}/variants/{variantId}/recipe/versions/{versionId}/restore", h.RestoreRecipeVersion)
				})
			})
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_settings"))
				r.Put("/settings/app", h.UpdateAppSettings)
				r.Put("/settings/loyalty", h.UpdateLoyaltySettings)
				r.Post("/customers/{id}/points/adjust", h.AdjustPoints)
				r.Post("/customers/dup-candidates/{id}/merge", h.MergeDupCandidate)
				r.Post("/loyalty-conditions", h.CreateLoyaltyCondition)
				r.Put("/loyalty-conditions/{id}", h.UpdateLoyaltyCondition)
				r.Delete("/loyalty-conditions/{id}", h.DeleteLoyaltyCondition)
				r.Post("/ota/publish", h.OtaPublish)
			})
			// Permintaan Barang, outlet side (request_stock; own outlet from the request context).
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("request_stock"))
				r.Post("/requisitions", h.CreateRequisition)
				r.Put("/requisitions/{id}", h.UpdateRequisition)
				r.Post("/requisitions/{id}/submit", h.SubmitRequisition)
				r.Post("/requisitions/{id}/cancel", h.CancelRequisition)
			})
			// Permintaan Barang, warehouse side (manage_inventory).
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_inventory"))
				r.Post("/requisitions/{id}/approve", h.ApproveRequisition)
				r.Post("/requisitions/{id}/reject", h.RejectRequisition)
				r.Post("/requisitions/{id}/fulfil", h.FulfilRequisition)
			})
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_stock_count"))
				r.Post("/stock-counts", h.CreateStockCount)
				r.Put("/stock-counts/{id}", h.UpdateStockCount)
				r.Post("/stock-counts/{id}/complete", h.CompleteStockCount)
				r.Post("/oversell-records/acknowledge", h.AcknowledgeOversell)
			})

			// Reports — permission-gated.
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("view_reports"))
				r.Get("/reports/summary", h.ReportSummary)
				r.Get("/promo-reward-grants", h.PromoRewardGrants)
				r.Get("/discount-code-report", h.DiscountCodeReport)
				r.Get("/oversell-report", h.OversellReport)
				r.Get("/oversell-report/open-count", h.OversellOpenCount)
			})

			// Users / roles — admin only.
			r.Group(func(r chi.Router) {
				r.Use(mw.RequireRole("admin"))
				r.Post("/auth/register", h.CreateUser)
				r.Get("/users", h.ListUsers)
				r.Post("/users", h.CreateUser)
				r.Get("/users/{id}", h.GetUser)
				r.Put("/users/{id}", h.UpdateUser)
				r.Put("/users/{id}/receive-pin", h.SetUserReceivePin)
				r.Delete("/users/{id}/receive-pin-lockout", h.ClearUserReceivePinLockout)
				r.Post("/users/{id}/reset-password", ah.AdminResetPassword)
				r.Delete("/users/{id}", h.DeleteUser)
				r.Get("/custom-roles", h.CustomRoles)
				r.Post("/custom-roles", h.CreateCustomRole)
				r.Put("/custom-roles/{id}", h.UpdateCustomRole)
				r.Delete("/custom-roles/{id}", h.DeleteCustomRole)
				r.Get("/error-logs", h.ErrorLogs)

				// ERP outbox relay (plan step 5)
				r.Post("/admin/erp/relay", eo.RunRelay)
				r.Get("/admin/erp/outbox", eo.ListOutbox)
				r.Get("/admin/erp/outbox/{id}", eo.GetOutbox)
				r.Post("/admin/erp/outbox/{id}/retry", eo.RetryOutbox)
			})

			// ERP integration (step 4): admin only.
			r.Group(func(r chi.Router) {
				r.Use(mw.RequireRole("admin"))
				r.Get("/admin/erp/sku-mapping/export", h.ExportSkuMapping)
				r.Post("/admin/erp/sku-mapping/import", h.ImportSkuMapping)
				r.Post("/admin/erp/catalog-pull", h.ErpCatalogPullAdmin)
				r.Get("/admin/erp/sync-runs", h.ErpSyncRuns)
			})
		})
	})

	return r
}

// sentryRecoverer recovers panics, ships them to error tracking, logs a
// structured error, and returns 500 — replacing chi's plain Recoverer so
// crashes are observable in production instead of only on stdout.
// errorLogSink is where recovered panics are persisted (write.Repo in production).
type errorLogSink interface {
	InsertErrorLogs(ctx context.Context, logs []write.ErrorLog) error
}

func sentryRecoverer(s *observability.Sentry, wr errorLogSink) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil && rec != http.ErrAbortHandler {
					err, ok := rec.(error)
					if !ok {
						err = fmt.Errorf("panic: %v", rec)
					}
					reqID := chimw.GetReqID(r.Context())
					slog.Error("panic recovered", "err", redact.String(err.Error(), redact.Logs), "path", r.URL.Path, "request_id", reqID)
					s.CaptureError(r.Context(), err, map[string]string{
						"path": r.URL.Path, "request_id": reqID,
					})
					// Persist to the central error log so it shows in Backoffice
					// (best-effort; a fresh ctx since the request ctx is dying).
					buf := make([]byte, 4096)
					n := runtime.Stack(buf, false)
					uid, _ := r.Context().Value(auth.CtxUserID).(string)
					outlet, _ := r.Context().Value(auth.CtxOutletID).(string)
					payload, _ := json.Marshal(map[string]any{"requestId": reqID, "stack": string(buf[:n])})
					_ = wr.InsertErrorLogs(context.Background(), []write.ErrorLog{{
						OutletID: outlet, UserID: uid, Source: "backend", Kind: "panic",
						Action: r.Method + " " + r.URL.Path, Message: err.Error(), Payload: payload,
					}})
					httpx.Err(w, http.StatusInternalServerError, "internal error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
