# A29 client half: deadlines, Retry-After, "no internet" vs "server problem"

Status: PLAN (Opus, 2026-11-24). Base: `origin/prod-hardening` fc6985a8. Branch `a29-tablet-half`.
Server half is live since 2026-10-22 (`00126-seh`): sanitised errors, Retry-After on 429/503, request
deadline 25 s (28 s sync/ERP, imports and movement exports exempt), WriteTimeout 30 s, batch cap 200 / 8 MiB.

## Facts found while planning (they shape the plan)

1. `packages/api/src/client.ts` `execute()` only arms an AbortController when `timeoutMs` is passed. Most
   calls (sync pull, version poll, every Backoffice call) can hang forever.
2. Nothing in `packages/` reads `Retry-After`. Worse: the backend CORS config (`backend/internal/server/server.go`
   ~line 75) has no `ExposedHeaders`, and the POS WebView (`https://localhost`) and the Backoffice are
   cross-origin. So `res.headers.get('Retry-After')` is `null` in both apps even when the server sends it.
   No CapacitorHttp is configured, so the WebView fetch is a normal CORS fetch. **A one-line backend change is
   required.** Without it, the client must fall back to the body field `retryAfterSeconds`, which only the PIN
   step-up sends, and otherwise to its normal backoff.
3. `checkVersion()` (engine) treats every non-4xx failure as `setReachable(false)`. The UI then says
   "Offline" for a 5xx, an HTML 502, a timeout and a real lost connection alike. On 2026-11-18 the database
   was down. New Cloud Run instances cannot start without the DB, so Google's front end answers a 5xx
   **without CORS headers**. The browser surfaces that as a `TypeError`, which is exactly what "no internet"
   looks like. So telling the two apart needs a probe, not only status mapping.
4. No `@capacitor/network` plugin exists. Adding one needs an APK, which is out of scope (this slice ships
   by OTA).
5. Review leftovers on the A29 parent:
   - (a) A shift_open or shift_close held on the client after an earlier retryable result shows no reason
     ("ditunda").
   - (b) The isolation path checks `r.retryable === true`, but `flush()` checks `r.retryable !== false`. The
     OpenAPI contract says `retryable` is always present on an error, and that a missing code means
     pre-contract behaviour. The safe side holds shift items, so both paths should use `!== false`.

## Scope and decisions

### 1. Default deadline (packages/api)

Always arm the AbortController in `execute()`. The deadline covers fetch and the body read. The timeout
values are named constants in client.ts:

| Call | Timeout | Why |
|---|---|---|
| Default (every call without its own budget) | 35 s | The server answers by its 25 s deadline (sanitised 503) and is cut at 30 s WriteTimeout. 5 s covers a Cloud Run cold start. The client never gives up before the server's own answer can arrive. |
| `POST .../import` (products, customers, ingredients, sku-mapping, stock-counts/{id}) | 240 s | Server-exempt. The handler allows 60 s read + 150 s write = 210 s, plus a margin. |
| `GET /inventory/movements/export`, `/inventory/movements/summary/export` | 90 s | Server-exempt. The handler has a 55 s context and a 60 s write deadline, plus streaming time. |
| Silent refresh | 15 s (unchanged) | |
| `/sync/batch` 30 s, `/sync/review-items` 20 s, stock-count save 20 s | unchanged | Already explicit. |
| `GET /sync/version` (engine) | 15 s | Polled every 12 s. A hung poll must flip the indicator within about one poll. The call is tiny. |
| `GET /sync/pull` (engine) | 60 s | Not interactive. The bundle body is read on a possibly slow link, and the hazard is "forever", not "slow". |

No opt-out: a `timeoutMs` that is missing, 0, negative or not finite uses the route default. Test this.
`RequestOptions.timeoutMs` stays the override.

Timeout message: a timed-out GET says `Server tidak menjawab tepat waktu, coba lagi`. A timed-out write
(any non-GET) may still have landed, so it must not claim failure: `Server tidak menjawab tepat waktu.
Cek dulu apakah perubahan sudah tersimpan sebelum mengulang.` Grep the tests and UI that match the old
`permintaan melebihi batas waktu` and update them.

### 2. Retry-After

- packages/api:
  - Export `parseRetryAfter(value: string | null, nowMs: number): number | undefined`. It accepts
    delta-seconds and HTTP-date, rejects garbage and negatives, and clamps to at most 30 min (a broken
    header must not park a tablet).
  - On a 429 or 503, `execute()` sets `ApiError.retryAfterMs` from the header, or else from the JSON body
    `retryAfterSeconds`. Add `retryAfterMs` as an optional public field; keep the constructor
    backward-compatible.
  - `trySilentRefresh()`'s 429/503 branch does the same.
- Backend: `server.go` CORS gets `ExposedHeaders: []string{"Retry-After"}`, plus a Go test (CORS response
  for an allowed origin carries `Access-Control-Expose-Headers: Retry-After`). It goes in package
  `internal/server`, not `internal/api` or `internal/codegen`, so the codegen gate test list is unaffected.
  Confirm against `scripts/ci/codegen_gate.py`.
- packages/sync engine:
  - A separate `serverHoldUntil` (epoch ms) is set from any ApiError carrying `retryAfterMs`, seen in flush,
    isolation, checkVersion, pull or review check-in. Its value is `now + ra + jitter`, where jitter is
    `random * min(0.2*ra, 10 s)` (jitter only ever adds).
  - `resetBackoff()`, `flushNow()`, `retryFailed()` and the window `online` handler must NOT clear it.
  - While the hold is active:
    - `flush()` (manual included) returns null without a request.
    - `checkVersion()` makes no request and leaves `reachable`, the connection state, the contact and the
      offline-cap accounting unchanged.
    - `autoPullRun` re-arms for after the hold.
    - Review check-in skips.
  - `nextFlushAt` from a transient failure is `max(normal backoff, serverHoldUntil)`.
  - Export a read-only `serverHoldUntil()` getter so the UI can say when it will retry.
  - AutoPull `failed(minDelayMs?)`: the backoff is at least `minDelayMs`.

### 3. "No internet" vs "server problem" (engine + POS UI)

- Engine:
  - New `ConnectionState = 'online' | 'no_internet' | 'server_problem'`, a getter `connectionState()` and an
    additive event `onConnection?(state)`.
  - The boolean `reachable` / `isReachable()` / `onReachable` keep their exact current semantics. All
    gating (ShiftBar, auto-pull, A05 contact and lock) still reads the boolean. A 5xx unblocks nothing.
  - Mapping in `checkVersion`:
    - 2xx → online.
    - 4xx → reachable true (unchanged) → online.
    - HTTP 5xx / 429 / 408 / `invalid_response` → unreachable, `server_problem` (the server or a proxy
      answered).
    - `network` / `TypeError` / `timeout` → run the probe. If the probe says the host answered →
      `server_problem`; if it fails or there is no probe → `no_internet`.
    - `navigator.onLine === false` → `no_internet` with no request (unchanged).
  - Flush `offline` keeps the current cause if the engine is already unreachable, else `no_internet`; the
    next poll refines it.
- Probe:
  - New option `SyncEngineOptions.probeHost?: () => Promise<boolean>`, called at most once per
    `checkVersion` and only on network / timeout failures.
  - packages/api exports `probeHost(baseUrl, timeoutMs = 5000)`: `fetch(baseUrl + '/healthz', { mode:
    'no-cors', cache: 'no-store', signal })`. It resolves true on any answer, including an opaque one or
    Google's own 404 (it proves the host is reachable over the network, nothing more), and false on
    rejection or timeout.
  - POS wires it where the engine is built (SyncProvider / api.ts).
- POS UI ("Kertas & Emas", `docs/plans/2026-10-27-pos-ux-direction.md` section 3.5; short, calm, plain
  Indonesian; every unreachable message says selling continues and transactions are kept):
  - `useOfflineData` exposes `connection`.
  - `ChipInput` gets `connection`; `reachable` stays.
  - The offline chip prefix becomes `Tidak ada internet` for no_internet and `Server bermasalah` for
    server_problem. The A05 cap prefixes (`Offline N jam`, `Offline terkunci`) stay because they count both.
  - SyncStatus title: `Server bermasalah sejak HH:MM · penjualan tetap bisa`. The existing `Offline sejak…`
    title stays for no_internet.
  - Sheet sentence for server_problem: `Server sedang bermasalah, bukan internet tablet ini. Penjualan tetap
    bisa; transaksi disimpan di tablet dan terkirim otomatis saat server pulih.`
  - While a server hold is active, add `Server meminta jeda · kirim ulang otomatis HH:MM`.
  - Keep the existing rule "offline is never described as a server problem" (SyncStatus.tsx ~line 216).
    It now applies only to `no_internet`.

### 4. A29 leftovers

- (b) The isolation path uses `r.retryable !== false`, the same as flush.
- (a) Held-shift reason:
  - In memory only, add `Map<idempotencyKey, string>` in the engine, filled when flush or isolation skips a
    shift item because of an earlier retryable, and cleared at the next flush start.
  - Surface it as `heldReason` on the queued-item view the SyncStatus list reads. Copy:
    `Ditunda: menunggu transaksi sebelumnya terkirim`.
  - **Do not touch `outbox.ts`, `outboxStore.ts`, `storage.ts`, `journal*.ts`.** The A35 OTA guard would
    require `OTA_JOURNAL_CHANGE_ACK`.

## Guards that must not move

- Only a deterministic 400/413/422 may ever be held against an item (`classifyFailure`). A 429/503 stays
  transient and burns no attempt.
- No refund, void, stock or shift-order guard changes.
- `reachable` false still means "keep selling on the last snapshot". The A05 12 h cap still counts from the
  last 2xx contact.

## Tests (vitest, fake timers)

- packages/api:
  - The default 35 s timeout fires on a hung fetch, and on a hung body read.
  - An explicit `timeoutMs` overrides it; 0, negative and NaN fall back to the default.
  - The import routes get 240 s and the export routes 90 s.
  - The timeout message differs for GET and POST.
  - `parseRetryAfter`: seconds, HTTP-date, past date → 0, garbage → undefined, clamp.
  - `retryAfterMs` on 429 / 503 from the header, from the body, and absent; not set on 500.
  - Silent refresh 429 / 503 carries `retryAfterMs`.
  - `probeHost`: true on resolve, false on reject or timeout.
- packages/sync:
  - Transient + Retry-After 60 s: no flush before 60 s.
  - `flushNow()` inside the hold sends nothing.
  - `resetBackoff` paths do not clear the hold.
  - `checkVersion` inside the hold sends no request and leaves reachable and contact untouched.
  - AutoPull waits at least `retryAfterMs`.
  - `checkVersion`:
    - 503 → `server_problem` and `isReachable()` false.
    - HTML 502 (`invalid_response`) → `server_problem`.
    - TypeError + probe true → `server_problem`; probe false → `no_internet`; no probe → `no_internet`.
    - `navigator.onLine` false → `no_internet` with no request.
    - 4xx → online.
    - 2xx after a `server_problem` → online.
  - The isolation path holds shift items after an item with `retryable` missing.
  - A held shift exposes `heldReason`, and it is cleared after the next successful flush.
- apps/pos:
  - `connectionChip` covers each state × pending / parked / cap level.
  - The SyncStatus title and sentence for server_problem.

## Gates and release

- Local: `corepack pnpm quality:ci`, the browser gate, `go test ./internal/server/...` for the CORS line.
- Push the head to `origin gate/a29-tablet-half`. Report quality, backend, postgres, browser and
  dependency-security with run IDs.
- Release (owner go-ahead each step):
  1. Backend deploy (CORS expose line, backward compatible, no migration).
  2. POS by OTA (no APK).
  3. Backoffice redeploys on the first non-skip push.

  The client works without step 1. It just cannot see Retry-After until then.

## Follow-ups (not in this slice)

- Backoffice `usePolledQuery` does not slow down on 429. With the default deadline it no longer hangs.
- Add `retryAfterSeconds` to the generic 429 JSON body as well, so a client behind a CORS-stripping proxy still
  sees it.
