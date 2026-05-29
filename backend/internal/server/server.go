package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
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
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/uploads"
	"github.com/mandalika/pos-backend/internal/write"
)

func New(cfg *config.Config, database *db.DB, c *cache.Cache, sentry *observability.Sentry) http.Handler {
	r := chi.NewRouter()
	// Built early: the panic recoverer persists backend errors to error_logs.
	wr := write.New(database.Pool)
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
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

	store := auth.NewStore(database.Pool)
	ah := auth.NewHandler(cfg, store, c)
	rd := read.New(database.Pool)
	os := service.NewOrderService(database.Pool)
	signer := &uploads.Signer{
		CloudName: cfg.CloudinaryName,
		APIKey:    cfg.CloudinaryKey,
		APISecret: cfg.CloudinarySecret,
	}
	h := handlers.New(rd, c, store, wr, os,
		syncpkg.New(database.Pool, rd, os, wr), signer)

	r.Get("/healthz", func(w http.ResponseWriter, req *http.Request) {
		if err := database.Pool.Ping(req.Context()); err != nil {
			httpx.Err(w, http.StatusServiceUnavailable, "db down")
			return
		}
		if err := c.R.Ping(req.Context()).Err(); err != nil {
			httpx.Err(w, http.StatusServiceUnavailable, "redis down")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Liveness: process is up. Used by the platform health check; must not
	// touch dependencies so a transient DB blip doesn't kill the instance.
	r.Get("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	r.Route("/api/v1", func(r chi.Router) {
		// Credential endpoints get a strict per-IP limit to blunt
		// brute-force and token-spray; the global limit still applies.
		r.Group(func(r chi.Router) {
			r.Use(mw.RateLimit(c, "auth", 10, time.Minute))
			r.Post("/auth/login", ah.Login)
			r.Post("/auth/refresh", ah.Refresh)
			r.Post("/auth/logout", ah.Logout)
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
			r.Get("/customers", h.Customers)
			r.Get("/customers/{id}", h.Customer)
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
			r.Get("/sync/inbound-transfers", h.GetInboundTransfers)
			r.Get("/sync/outlet-transfers", h.GetOutletTransfers)

			// ── Reference-data writes (Backoffice; permission-gated, bump
			// content_version → POS sync wall) ──
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_products"))
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
				r.Use(mw.RequirePermission("manage_customers"))
				r.Post("/customers", h.CreateCustomer)
				r.Put("/customers/{id}", h.UpdateCustomer)
				r.Delete("/customers/{id}", h.DeleteCustomer)
			})
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_promotions"))
				r.Post("/promotions", h.CreatePromotion)
				r.Put("/promotions/{id}", h.UpdatePromotion)
				r.Delete("/promotions/{id}", h.DeletePromotion)
				r.Post("/discount-codes", h.CreateDiscountCode)
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
				r.Post("/warehouses/{id}/goods-receipt", h.CreateGoodsReceipt)
				r.Post("/warehouses/{id}/adjust", h.AdjustWarehouseStock)
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
					r.Post("/ingredients", h.CreateIngredient)
					// static path before parameterised to avoid chi shadowing
					r.Get("/ingredients/stock", h.IngredientStock)
					r.Put("/ingredients/{id}", h.UpdateIngredient)
					r.Delete("/ingredients/{id}", h.DeleteIngredient)
					r.Post("/ingredients/goods-receipt", h.CreateIngredientGoodsReceipt)
					r.Post("/ingredients/adjust", h.AdjustIngredientStock)
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
			})
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_stock_count"))
				r.Post("/stock-counts", h.CreateStockCount)
				r.Put("/stock-counts/{id}", h.UpdateStockCount)
				r.Post("/stock-counts/{id}/complete", h.CompleteStockCount)
			})

			// Reports — permission-gated.
			r.With(mw.RequirePermission("view_reports")).
				Get("/reports/summary", h.ReportSummary)

			// Users / roles — admin only.
			r.Group(func(r chi.Router) {
				r.Use(mw.RequireRole("admin"))
				r.Post("/auth/register", h.CreateUser)
				r.Get("/users", h.ListUsers)
				r.Post("/users", h.CreateUser)
				r.Get("/users/{id}", h.GetUser)
				r.Put("/users/{id}", h.UpdateUser)
				r.Put("/users/{id}/receive-pin", h.SetUserReceivePin)
				r.Delete("/users/{id}", h.DeleteUser)
				r.Get("/custom-roles", h.CustomRoles)
				r.Post("/custom-roles", h.CreateCustomRole)
				r.Put("/custom-roles/{id}", h.UpdateCustomRole)
				r.Delete("/custom-roles/{id}", h.DeleteCustomRole)
				r.Get("/error-logs", h.ErrorLogs)
			})
		})
	})

	return r
}

// sentryRecoverer recovers panics, ships them to error tracking, logs a
// structured error, and returns 500 — replacing chi's plain Recoverer so
// crashes are observable in production instead of only on stdout.
func sentryRecoverer(s *observability.Sentry, wr *write.Repo) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil && rec != http.ErrAbortHandler {
					err, ok := rec.(error)
					if !ok {
						err = fmt.Errorf("panic: %v", rec)
					}
					reqID := chimw.GetReqID(r.Context())
					slog.Error("panic recovered", "err", err, "path", r.URL.Path, "request_id", reqID)
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
