package server

import (
	"net/http"

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
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/uploads"
	"github.com/mandalika/pos-backend/internal/write"
)

func New(cfg *config.Config, database *db.DB, c *cache.Cache) http.Handler {
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "X-Outlet-Id", "Idempotency-Key"},
		AllowCredentials: true,
	}))

	store := auth.NewStore(database.Pool)
	ah := auth.NewHandler(cfg, store, c)
	rd := read.New(database.Pool)
	os := service.NewOrderService(database.Pool)
	signer := &uploads.Signer{
		CloudName: cfg.CloudinaryName,
		APIKey:    cfg.CloudinaryKey,
		APISecret: cfg.CloudinarySecret,
	}
	h := handlers.New(rd, c, store, write.New(database.Pool), os,
		syncpkg.New(database.Pool, rd, os), signer)

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

	r.Route("/api/v1", func(r chi.Router) {
		r.Post("/auth/login", ah.Login)
		r.Post("/auth/refresh", ah.Refresh)
		r.Post("/auth/logout", ah.Logout)

		r.Group(func(r chi.Router) {
			r.Use(mw.RequireAuth(cfg))
			r.Get("/auth/me", ah.Me)

			// Catalog / reference (any authenticated user; cashier sells).
			r.Get("/products", h.Products)
			r.Get("/products/{id}", h.Product)
			r.Get("/categories", h.Categories)
			r.Get("/bundles", h.Bundles)
			r.Get("/outlets", h.Outlets)
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

			// ── Offline sync (plan §5) ──
			r.Get("/sync/version", h.SyncVersion)
			r.Get("/sync/pull", h.SyncPull)
			r.Post("/sync/batch", h.SyncBatch)

			// ── Reference-data writes (Backoffice; permission-gated, bump
			// content_version → POS sync wall) ──
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("manage_products"))
				r.Post("/products", h.CreateProduct)
				r.Put("/products/{id}", h.UpdateProduct)
				r.Delete("/products/{id}", h.DeleteProduct)
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
				r.Use(mw.RequirePermission("manage_settings"))
				r.Put("/settings/app", h.UpdateAppSettings)
				r.Put("/settings/loyalty", h.UpdateLoyaltySettings)
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
				r.Delete("/users/{id}", h.DeleteUser)
				r.Get("/custom-roles", h.CustomRoles)
			})
		})
	})

	return r
}
