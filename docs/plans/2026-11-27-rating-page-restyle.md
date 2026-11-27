# Customer rating page: Backoffice look + brand logo (2026-11-27)

Owner request: "redesign the Customer rating page to add the Company Logo and uses the backoffice design token."
Owner answers 2026-11-27: logo = **brand logo only** (Pengaturan › Dokumen, `app_settings.documents_logo_url`, the one
"Ambil logo brand" uses; outlet logos are ignored here). Mock accepted without changes (before/after gallery in the
session notes folder `rating-page-restyle/mock/`). Light theme only.

## Intent

The public page a customer opens from the WhatsApp receipt link (`GET`/`POST /r/{token}`) should look like the
Backoffice (Kaca tokens, Roboto, white solid panels on the paper ground with the ambient wash) and carry the brand logo,
ahead of the COO demo. This codebase serves three brands, so the logo comes from data, never a bundled Mandalika file.

## Goals / non-goals

- Goals: restyle every state (receipt + form, form error, thank-you, gone 404, rate-limited 429, unavailable 503); show
  the brand logo; one token source with a test that fails on drift.
- Non-goals: no behaviour change (stars, tags, comment, one rating per sale, 7-day expiry, `flagFast`/`flagSameNetwork`,
  first-name-only privacy); no change to the security headers (CSP stays `img-src 'self' data:`); no JavaScript; no web
  font; no per-brand colour config (known gap, below); no OpenAPI change.
- Anti-goals: an external image request from the customer's phone; a DB read or outbound fetch on the 404/429/503 paths;
  any difference between the 404 body of an unknown token and of an expired one.

## Approaches considered

1. **Server-side fetch, cache, inline as `data:` URI (chosen).** CSP unchanged; the page stays one self-contained
   response; the customer's phone never contacts Cloudinary. Cost: an outbound fetch (SSRF surface: guarded below) and
   ~10-30 KB of base64 per page view (`no-store`).
2. Widen the CSP `img-src` to `https://res.cloudinary.com`. Simplest, but changes the security headers the brief froze
   and leaks the customer's IP to a third party.
3. Same-origin `/r/...logo` route serving cached bytes. Browser-cacheable, but adds a public route and still needs the
   same fetch; more surface for no demo benefit.

Logo source: `documents_logo_url` only (owner). The Backoffice `brand.ts` logo is a build-time Vite constant the
backend cannot see.

## Design

### Logo (`backend/internal/receiptlink/logo.go`, new)

`LogoCache` (nil-receiver safe: every method on a nil `*LogoCache` returns "" and does nothing):

- `NewLogoCache(cloudName string) *LogoCache`: allowed source prefix
  `https://res.cloudinary.com/<cloudName>/image/upload/`; empty `cloudName` = every source rejected.
- `DataURI(ctx, src string) template.URL`: "" when `src` is empty or rejected or the fetch fails. Caches the one
  current source: success for 1 h, failure for 5 min (so a broken URL never fetches on every view). A new `src` fetches
  at once. Concurrent misses for the same source share one fetch (`golang.org/x/sync/singleflight`, already in go.mod
  as indirect: make it direct) or a mutex; never hold a lock across the whole page render.
- `Peek() template.URL`: the current cached value, no I/O. Used by 404/429/503. "" on a cold instance, and "" after the
  admin clears the logo (the next receipt view with `src == ""` resets it).
- Source check (pure func, unit-tested): `url.Parse`; scheme `https`; host exactly `res.cloudinary.com`; no userinfo,
  no port, no query, no fragment; path starts with `/<cloudName>/image/upload/`; reject `..` segments.
- Fetch URL: insert `c_limit,w_360,h_112,f_png/` right after `/image/upload/` (2x of the 180x56 CSS box; `c_limit`
  never crops or upscales; PNG keeps transparency and works on every phone browser).
- HTTP: own `http.Client` with 3 s timeout, `CheckRedirect` returning `http.ErrUseLastResponse` (any non-200 = failure),
  status 200 only, body read through `io.LimitReader` with a 256 KiB cap (over cap = failure), type from
  `http.DetectContentType` must be `image/png`, `image/jpeg` or `image/webp` (never SVG/HTML). The data URI uses the
  sniffed type: `data:<type>;base64,<std base64>`, returned as `template.URL` (html/template would otherwise rewrite a
  `data:` src to `#ZgotmplZ`; safe because the bytes are a sniffed raster image and base64 has no quotes).
- Failures log `slog.Warn("receipt logo fetch failed", "reason", ...)` once per fetch attempt (no token, no customer data).
- Tests inject the HTTP client, the allowed prefix and a clock (unexported fields set by a test helper), using
  `httptest.NewTLSServer`.

### Data

- `read.ReceiptPageData` gains `LogoURL string`; `Repo.ReceiptPage` selects `COALESCE(btrim(a.documents_logo_url),'')`
  in the existing query (app_settings is already LEFT JOINed). No migration.
- `Handlers` gains `receiptLogo *receiptlink.LogoCache` + `SetReceiptLogo(*receiptlink.LogoCache)`; `server.go` wires
  `receiptlink.NewLogoCache(cfg.CloudinaryName)` next to `SetReceiptLinkBase`.
- `writeReceiptPage` sets `PageData.Logo = h.receiptLogo.DataURI(r.Context(), d.LogoURL)`.

### Rendering (`receiptlink`)

- `PageData` gains `Logo template.URL`.
- One shared "state" template (`state.html`) for 404/429/503: `StateData{Logo template.URL; Title, Mark, Heading, Body,
  Action string}`. Exported: `RenderGone(w, logo template.URL)` (404, copy unchanged: "Tautan tidak berlaku atau sudah
  kedaluwarsa" / "Silakan hubungi outlet tempat Anda berbelanja untuk meminta tautan baru."),
  `RenderRateLimited(w, logo)` (429, "Terlalu banyak permintaan" / "Tunggu sekitar satu menit, lalu buka lagi halaman
  ini.", action "Muat ulang" = `<a class="btn" href="">`), `RenderUnavailable(w, logo)` (503, keeps `Retry-After: 5`,
  "Halaman belum dapat ditampilkan" / "Coba lagi sebentar lagi.", action "Muat ulang"). `gone.html` is folded into
  `state.html`.
- `page.html` follows the mock: letterhead (logo, `h1.brand`, greeting) inside the top of the receipt panel, dashed cut,
  "Struk digital", `dl.meta` (Outlet / Waktu / Pesanan), lines table with qty tags, sum rows, total strip, payment line;
  rating panel (stars in tiles, tag chips with a check when selected, textarea, brand-strong button); thank-you panel.
  Every visible string, form field name, id, `required`, `maxlength="500"`, and aria label of today's page is kept.
- `style.html` = the mock CSS (session notes `rating-page-restyle/mock/after/1-form.html` is the reference; the gallery
  is the visual spec). The render-error fallback string in `render()` stays as is (the template just failed).
- Logo `<img>`: `alt=""` (decorative; the brand name follows), only when `Logo != ""`.

### Rate-limited state

- `middleware.RateLimitWith(c, prefix, max, window, limited func(http.ResponseWriter, *http.Request))`: same counting
  and `Retry-After` as today; on refusal calls `limited` (which writes status 429). `RateLimit` becomes `RateLimitWith`
  with today's JSON writer, so `/auth/login` and every other bucket answer exactly as before.
- `server.go`: the two receipt routes use `RateLimitWith(..., h.ReceiptRateLimited)`; limits and bucket names unchanged.
  `h.ReceiptRateLimited` = `receiptlink.RenderRateLimited(w, h.receiptLogo.Peek())` (no DB, no fetch).
- The 404 paths in `receiptLinkFor` and the 503 paths use `h.receiptLogo.Peek()`.

### Tokens: one source, a drift test

- `style.html` opens with one `:root{...}` block that declares only names that exist in
  `packages/ui-tokens/tokens.css`, `packages/ui-tokens/materials.css` or `apps/backoffice/src/index.css`, with the same
  values. The rest of the CSS reads them through `var()`.
- `receiptlink/tokens_test.go` (package-level test, not in `internal/api` or `internal/codegen`, so no
  `codegen_gate.py` entry) reads those three files by relative path (`../../../packages/...`; backend CI checks out the
  whole repo), strips comments, collects `--name: value;` (first occurrence per name, whitespace collapsed), and fails
  when a page variable is missing from the sources or differs. It also fails when the CSS outside `:root` contains a
  hex colour other than `#fff`/`#ffffff` (derived `rgba()` for shadows/rings is allowed).
- Contrast rules from `tokens.test.ts`: filled controls use `brand-strong` (white on `brand` fails AA); `ink-500` only on
  white/paper-0; no `color-mix()` (older Android WebViews); no `@font-face` (CSP `default-src 'none'` blocks fonts; the
  `--font-sans` stack lands on Roboto on Android).

### Known gap (follow-up, not this slice)

The backend has no brand setting, so the gold accent and the Mandalika ambient wash would also show on a Flamboyan or
Performance deployment. Fix later with a backend brand setting mapped to `--color-palette-*`.

## Tests

- Unit: source check table (accept/reject cases), fetch (200 png ok; non-200, redirect, oversize, `text/html`, SVG
  rejected), cache (two calls = one upstream hit; failure not retried inside 5 min, retried after; new src refetches;
  `src == ""` makes `Peek` ""), nil cache safe.
- Render: logo `<img ... src="data:image/png;base64,` present when set, absent when not; no `#ZgotmplZ`; no `<script`;
  every kept string still present; 404 two renders byte-identical (with and without logo); 429/503 status, public
  headers, `Retry-After` kept (503 = 5).
- Middleware: `RateLimitWith` calls the custom writer with `Retry-After` set; `RateLimit` JSON unchanged.
- Existing PG gate CR (`TestCustomerRatingPostgres`) stays green; extend it in place (no new top-level test) to assert
  a page renders with `documents_logo_url` set to a rejected host (no logo, 200).
- `TestWriteSamplePages` writes every state (with and without logo) for the side-by-side check.

## Build order

1. Tokens drift test (RED against today's `style.html`: `ink-500` drifted), then new `style.html` (GREEN).
2. `logo.go` + tests. 3. `state.html` + render funcs + tests. 4. `page.html` restyle + tests.
5. `RateLimitWith` + tests. 6. Data + handler + server wiring. 7. `gofmt`, `go vet`, `go test ./...`,
   Postgres gate CR. 8. Side-by-side compare against the mock gallery.
