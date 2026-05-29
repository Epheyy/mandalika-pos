# POS — Transfer Notifier + History + Reprints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The 6 working rules (user-required, apply to every task):** 1) Ask, don't assume. 2) Don't touch unrelated code. 3) Flag uncertainty. 4) Verify on failure (never fake success). 5) Show changes (diffs). 6) Admit gaps.

**Goal:** POS gets (F2) a combined "needs attention" hamburger dot that lights for inbound transfers, (F3) an outlet transfer-history view (incoming+outgoing, Completed/Cancelled tabs) with tanda-terima reprint, (F4) sales-receipt reprint from order history, and a shared "REPRINT" marker stamped on any reprint.

**Architecture:** One new cashier-scoped read-only endpoint (`/sync/outlet-transfers`) reusing the existing `Transfer` DTO + transfer read SQL. POS adds a history panel + two small reprint actions, both routed through the existing `@mandalika/printer` builders, which gain an optional `reprint` flag that prints the marker. No schema change.

**Tech Stack:** Go (chi, pgx v5, oapi-codegen) + Postgres; TypeScript React POS (Capacitor); `@mandalika/sync`, `@mandalika/printer`; generated `@mandalika/api`; Vitest.

**Spec:** `docs/superpowers/specs/2026-05-29-pos-transfer-history-reprints-design.md`

**Conventions (verified):** codegen `cd backend && make gen-go && make gen-ts` (commit regenerated `api.gen.go`; CI gate `make gen-check`); `gofmt -w internal/`; commit hook rejects chained `git commit && …` (own line; no `--no-verify`); POS typecheck `corepack pnpm --filter @mandalika/pos exec tsc --noEmit`; printer/sync tests `corepack pnpm --filter @mandalika/printer test` / `--filter @mandalika/sync test` (Vitest); backend deploy `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet` (Bash `dangerouslyDisableSandbox:true`), verify `/readyz`. **APK** via GitHub Actions dispatch (see SP-Recipe-1/SP4 handoff commands). On-device thermal-print verification is **user-pending** (no printer in CI). The `/api/v1/sync/inbound-transfers` endpoint + `engine.getInboundTransfers()` already exist (SP3); `TransfersForOutlet(ctx,outletID,status)` filters `dest_outlet_id` only.

---

## PHASE A — Shared REPRINT marker in the printer

### Task A1: REPRINT marker on `buildReceipt` + `buildTandaTerima` (+ tests)

**Files:** Modify `packages/printer/src/escpos.ts`; Test `packages/printer/src/escpos.test.ts` (create if absent; the package already runs Vitest from SP4).

- [ ] **Step 1: Write failing tests.** Append to (or create) `packages/printer/src/escpos.test.ts`. The marker text is `*** CETAK ULANG (REPRINT) ***`; assert it's present twice (top + bottom) only when `reprint` is true. Decode bytes back to a string for assertion.

```ts
import { describe, it, expect } from 'vitest'
import { buildReceipt, buildTandaTerima, type ReceiptData } from './escpos'

const txt = (u: Uint8Array) => String.fromCharCode(...u)
const MARK = '*** CETAK ULANG (REPRINT) ***'

const sampleReceipt: ReceiptData = {
  orderRef: 'TEST-1', pending: false, dateTime: new Date('2026-05-29T00:00:00Z'),
  lines: [{ name: 'Item', qty: 1, unitPrice: 1000, amount: 1000 }],
  subtotal: 1000, discountAmount: 0, taxAmount: 0, total: 1000,
  paymentLabel: 'Tunai', amountPaid: 1000, change: 0,
  customerName: null, customerPhone: null, cashierName: 'Kasir',
}
const settings = { headerText: 'TOKO' } as never

describe('REPRINT marker', () => {
  it('buildReceipt: no marker by default', () => {
    expect(txt(buildReceipt(sampleReceipt, settings)).includes(MARK)).toBe(false)
  })
  it('buildReceipt: marker top + bottom when reprint', () => {
    const s = txt(buildReceipt(sampleReceipt, settings, true))
    const count = s.split(MARK).length - 1
    expect(count).toBe(2)
  })
})
```
(For `buildTandaTerima`, add an analogous pair using a minimal `TandaTerimaData` — copy the shape from the existing buildTandaTerima tests already in this file.)

- [ ] **Step 2: Run — expect FAIL** (`reprint` param doesn't exist yet → TS/compile error or assertion fail).

Run: `corepack pnpm --filter @mandalika/printer test`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `escpos.ts`, add a helper and a third optional param to both builders. The `Buf` class + `ALIGN_CENTER`/`ALIGN_LEFT`/`BOLD_ON`/`BOLD_OFF` constants already exist.

Add near the other helpers (after the `center` function):
```ts
const REPRINT_MARK = '*** CETAK ULANG (REPRINT) ***'
function reprintLine(b: Buf): void {
  b.raw(ALIGN_CENTER).raw(BOLD_ON).line(REPRINT_MARK).raw(BOLD_OFF).raw(ALIGN_LEFT)
}
```
`buildReceipt`: change the signature to `(data: ReceiptData, settings: ReceiptSettings, reprint = false)`. Immediately after the header block (right after the `b.raw(ALIGN_LEFT)` that ends the centered header, before the `No`/`Tgl` rows) add: `if (reprint) reprintLine(b)`. And just before the final feed/cut (`FEED_3`/`CUT`) add another `if (reprint) reprintLine(b)`.
`buildTandaTerima`: same — add `reprint = false` as the trailing param, and the two `if (reprint) reprintLine(b)` calls at the top (after its header) and bottom (before cut). Match each function's existing header/cut structure (read the function first).

- [ ] **Step 4: Thread through `print.ts`.** In `packages/printer/src/print.ts`, `printReceipt(job)` builds via `buildReceipt(job.data, job.settings)` and `printTandaTerima(job)` via `buildTandaTerima(...)`. Add an optional `reprint?: boolean` to the respective `PrintJob` types and pass it: `buildReceipt(job.data, job.settings, job.reprint)` / `buildTandaTerima(job.data, job.settings, job.reprint)`. (Read `print.ts` for the exact job type names.)

- [ ] **Step 5: Run — expect PASS.** `corepack pnpm --filter @mandalika/printer test` → all pass (incl. the existing SP4 tanda-terima tests, unaffected since `reprint` defaults false).

- [ ] **Step 6: Commit.**

```bash
git add packages/printer/src/escpos.ts packages/printer/src/escpos.test.ts packages/printer/src/print.ts
git commit -m "feat(printer): optional REPRINT marker (top+bottom) on receipt + tanda terima"
```

---

## PHASE B — Hamburger combined dot (F2)

### Task B1: Light the hamburger dot for inbound transfers

**Files:** Modify `apps/pos/src/cashier/CashierScreen.tsx`

- [ ] **Step 1: Change the dot condition.** The hamburger button (~line 581) renders the red dot when `offlineData.pendingCount > 0`. `inboundCount`/`inbound` is already in scope (`const inbound = engine.getInboundTransfers()`; passed to MenuDrawer as `inboundCount={inbound.length}`). Change the dot condition to also fire on inbound:

```tsx
            {(offlineData.pendingCount > 0 || inbound.length > 0) && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />
            )}
```
(Use whatever the in-scope variable is — `inbound.length` or the `inboundCount` already computed near the MenuDrawer render. Confirm the name when editing.)

- [ ] **Step 2: Typecheck.** `corepack pnpm --filter @mandalika/pos exec tsc --noEmit` → clean.

- [ ] **Step 3: Commit.**

```bash
git add apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(pos): hamburger dot also lights for inbound transfers awaiting receipt"
```

---

## PHASE C — Backend outlet-transfers endpoint (F3)

### Task C1: OpenAPI — `/sync/outlet-transfers`

**Files:** Modify `backend/api/openapi.yaml`; regen.

- [ ] **Step 1: Add the path** (after `/api/v1/sync/inbound-transfers`). Reuses the existing `Transfer` schema:

```yaml
  /api/v1/sync/outlet-transfers:
    get:
      operationId: getOutletTransfers
      tags: [sync]
      summary: Completed/cancelled transfers involving the caller's outlet (incoming + outgoing)
      parameters:
        - name: status
          in: query
          required: true
          schema: { type: string, enum: [completed, cancelled] }
      responses:
        '200':
          description: outlet transfer history
          content:
            application/json:
              schema:
                type: object
                required: [data]
                properties:
                  data: { type: array, items: { $ref: '#/components/schemas/Transfer' } }
```

- [ ] **Step 2: Regen + build.** `cd backend && make gen-go && make gen-ts && go build ./...` → clean; `GetOutletTransfersParams` (with `Status`) appears in `api.gen.go`.

- [ ] **Step 3: Commit.**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(transfer): openapi — /sync/outlet-transfers (outlet history)"
```

### Task C2: Read method + handler + route

**Files:** Modify `backend/internal/read/repo.go`, `backend/internal/handlers/writes.go`, `backend/internal/server/server.go`

- [ ] **Step 1: Add read method** in `read/repo.go` next to `TransfersForOutlet` (~line 920). Reuse the existing `transferObj` + `transferFrom` SQL fragments; filter source OR dest = outlet (incoming + outgoing):

```go
// OutletTransferHistory returns transfers (incoming OR outgoing) for an outlet
// at a given status, newest first. Used by the cashier-scoped history view.
func (r *Repo) OutletTransferHistory(ctx context.Context, outletID, status string) ([]api.Transfer, error) {
	sql := `SELECT ` + transferObj + `, count(*) OVER() AS total ` + transferFrom +
		` WHERE (t.source_outlet_id=$1 OR t.dest_outlet_id=$1) AND t.status=$2 ORDER BY t.created_at DESC`
	rows, _, err := listJSON[api.Transfer](ctx, r.Pool, sql, outletID, status)
	return rows, err
}
```

- [ ] **Step 2: Add handler** in `handlers/writes.go` next to `GetInboundTransfers` (~line 958). Validate status; scope to the caller's outlet:

```go
func (h *Handlers) GetOutletTransfers(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	status := r.URL.Query().Get("status")
	if status != "completed" && status != "cancelled" {
		httpx.Err(w, http.StatusBadRequest, "status harus completed atau cancelled")
		return
	}
	if c.outletID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"data": []any{}})
		return
	}
	rows, err := h.Repo.OutletTransferHistory(r.Context(), c.outletID, status)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}
```

- [ ] **Step 3: Register the route** in `server.go` right after `r.Get("/sync/inbound-transfers", h.GetInboundTransfers)` (~line 133), in the same cashier-accessible group:

```go
			r.Get("/sync/outlet-transfers", h.GetOutletTransfers)
```

- [ ] **Step 4: Build.** `cd backend && gofmt -w internal/ && go build ./...` → green.

- [ ] **Step 5: Commit.**

```bash
git add backend/internal/read/repo.go backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(transfer): outlet transfer-history read + cashier-scoped handler + route"
```

### Task C3: Deploy + live-verify the endpoint

- [ ] **Step 1: Deploy.** `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`; `/readyz` 200.
- [ ] **Step 2: Verify with a CASHIER token** (login `test@mandalika.test`; its JWT carries the outlet). Confirm it returns this outlet's completed transfers (incoming + outgoing), excludes other outlets, and rejects a bad status:

```bash
BASE=https://mandalika-pos-538849926142.asia-southeast2.run.app
# CASHIER_TOKEN via login → data.access
curl -s "$BASE/api/v1/sync/outlet-transfers?status=completed" -H "authorization: Bearer $CASHIER_TOKEN" | python -m json.tool | head -40
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/sync/outlet-transfers?status=bogus" -H "authorization: Bearer $CASHIER_TOKEN"   # expect 400
curl -s "$BASE/api/v1/sync/outlet-transfers?status=cancelled" -H "authorization: Bearer $CASHIER_TOKEN" | python -m json.tool | head -20
```
Expected: completed list scoped to the cashier's outlet (both legs); 400 on bad status. Flag any mismatch; don't proceed if scope leaks other outlets.
- [ ] **Step 3: Push.** `git push origin prod-hardening`

---

## PHASE D — POS transfer-history UI (F3)

### Task D1: TS client method

**Files:** Modify `packages/api/src/client.ts`

- [ ] **Step 1: Interface** (near `getIngredientTransfer`): `outletTransfers: (status: 'completed' | 'cancelled') => Promise<Transfer[]>`.
- [ ] **Step 2: Impl:**
```ts
    outletTransfers: (status) =>
      data<Transfer[]>('GET', `${API}/sync/outlet-transfers?status=${status}`),
```
(`Transfer` is already exported/aliased for the existing transfer methods.)
- [ ] **Step 3: Typecheck (POS consumes it) + commit.**
```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
git add packages/api/src/client.ts
git commit -m "feat(transfer): api client outletTransfers(status)"
```

### Task D2: TransferHistoryPanel + MenuDrawer entry

**Files:** Create `apps/pos/src/cashier/TransferHistoryPanel.tsx`; Modify `apps/pos/src/cashier/MenuDrawer.tsx`, `apps/pos/src/cashier/CashierScreen.tsx`

- [ ] **Step 1: Read the existing patterns first.** Read `ReceiveTransferPanel.tsx` (how a transfer panel is structured, how it gets `usePrinter`/settings/cashier name, how it builds + prints tanda terima via `buildTandaTerimaData` + `printTandaTerima`), and `MenuDrawer.tsx` (how a menu item + its `onClick` open a panel; how `inboundCount` is passed). Match those patterns.

- [ ] **Step 2: Create `TransferHistoryPanel.tsx`.** Two tabs (Selesai/Dibatalkan); on-demand fetch via `api.outletTransfers(status)`; list → detail; completed → reprint tanda terima with the `reprint` flag. Adapt the `printTandaTerima` call + `buildTandaTerimaData(transfer, cashierName)` + `settings` + `isPaired` exactly as `ReceiveTransferPanel`/`TandaTerimaPrompt` use them (confirm those names when reading Step 1).

```tsx
import { useEffect, useState } from 'react'
import type { Transfer } from '@mandalika/api'
import { api } from '../api'

type Tab = 'completed' | 'cancelled'

interface Props {
  onClose: () => void
  cashierName: string
  // Reprint dependencies, passed from CashierScreen (mirror ReceiveTransferPanel):
  onReprint: (t: Transfer) => void
}

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return iso }
}

export function TransferHistoryPanel({ onClose, onReprint }: Props) {
  const [tab, setTab] = useState<Tab>('completed')
  const [rows, setRows] = useState<Transfer[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Transfer | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true); setErr(null); setOpen(null)
    api.outletTransfers(tab)
      .then((r) => { if (alive) setRows(r) })
      .catch(() => { if (alive) setErr('Perlu koneksi untuk memuat riwayat transfer.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tab])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-md bg-white h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h2 className="font-bold text-gray-900">Riwayat Transfer</h2>
          <button onClick={onClose} className="text-gray-400 text-xl leading-none">×</button>
        </div>
        <div className="flex border-b">
          {(['completed', 'cancelled'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-2.5 text-sm font-bold ${tab === t ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-400'}`}>
              {t === 'completed' ? 'Selesai' : 'Dibatalkan'}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto">
          {loading ? <p className="p-4 text-sm text-gray-400">Memuat…</p>
            : err ? <p className="p-4 text-sm text-red-600">{err}</p>
            : rows.length === 0 ? <p className="p-4 text-sm text-gray-400">Tidak ada transfer.</p>
            : rows.map((t) => (
              <button key={t.id} onClick={() => setOpen(t)}
                className="w-full text-left px-4 py-3 border-b hover:bg-gray-50">
                <div className="flex justify-between">
                  <span className="font-bold text-gray-800 text-sm">{t.transferNo}</span>
                  <span className="text-xs text-gray-400">{fmtDate(t.receivedAt ?? t.createdAt)}</span>
                </div>
                <div className="text-xs text-gray-500">{t.source?.name} → {t.dest?.name} · {t.items?.length ?? 0} item</div>
                {t.discrepancyReason && <div className="text-xs text-amber-600">Selisih: {t.discrepancyReason}</div>}
              </button>
            ))}
        </div>
        {open && (
          <div className="border-t bg-gray-50 max-h-[45%] overflow-auto p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="font-bold text-sm">{open.transferNo}</span>
              <button className="text-gray-400 text-sm" onClick={() => setOpen(null)}>Tutup detail</button>
            </div>
            <div className="text-xs text-gray-600 mb-2">{open.source?.name} → {open.dest?.name}</div>
            {(open.items ?? []).map((it, i) => (
              <div key={i} className="flex justify-between text-xs py-0.5">
                <span>{it.productName} {it.variantSize}</span>
                <span>{it.sentQty}{it.receivedQty != null && it.receivedQty !== it.sentQty ? ` → ${it.receivedQty}` : ''}</span>
              </div>
            ))}
            {open.status === 'completed' && (
              <button onClick={() => onReprint(open)}
                className="mt-3 w-full bg-indigo-600 text-white rounded-lg py-2 text-sm font-bold">
                Cetak Ulang Tanda Terima
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```
> Field names (`source.name`, `dest.name`, `items[].productName/variantSize/sentQty/receivedQty`, `transferNo`, `receivedAt`, `discrepancyReason`, `status`) come from the generated `Transfer` type — confirm exact casing in `schema.d.ts` when wiring and adjust if needed.

- [ ] **Step 3: Wire the reprint in `CashierScreen.tsx`.** CashierScreen already holds `usePrinter()` + settings + cashier name + `buildTandaTerimaData` for the post-receive prompt. Add an `onReprint` handler that mirrors that, with the reprint flag:
```tsx
  const reprintTandaTerima = (t: Transfer) => {
    void printer.printTandaTerima({ data: buildTandaTerimaData(t, /* cashierName */ <name> ), settings: <settings>, reprint: true })
  }
```
Use the EXACT `usePrinter()` API + `buildTandaTerimaData` signature + settings/cashier-name variables already used by `TandaTerimaPrompt`/the post-receive flow in this file (read them first). The `reprint: true` field requires the Phase A `print.ts` job change.

- [ ] **Step 4: Add the MenuDrawer item + mount the panel.** In `MenuDrawer.tsx`, add a "Riwayat Transfer" item (mirror the "Terima Transfer" item's markup) whose `onClick` opens the history panel (lift a `showTransferHistory` state into `CashierScreen` like the other panels). In `CashierScreen.tsx`, render `{showTransferHistory && <TransferHistoryPanel onClose={() => setShowTransferHistory(false)} cashierName={<name>} onReprint={reprintTandaTerima} />}`.

- [ ] **Step 5: Typecheck + commit.**
```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
git add apps/pos/src/cashier/TransferHistoryPanel.tsx apps/pos/src/cashier/MenuDrawer.tsx apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(pos): outlet transfer history panel (Selesai/Dibatalkan) + tanda terima reprint"
```

---

## PHASE E — Order-history receipt reprint (F4)

### Task E1: "Cetak Ulang" in OrderHistoryPanel

**Files:** Modify `apps/pos/src/cashier/OrderHistoryPanel.tsx` (+ `CashierScreen.tsx` if the print deps live there)

- [ ] **Step 1: Read `OrderHistoryPanel.tsx` + `ReceiptPreview.tsx` + `printer.tsx`.** Determine (a) what order data each history row carries, (b) how `ReceiptPreview` builds `ReceiptData` from an order (reuse that exact mapper — do NOT write a second receipt layout), (c) the `usePrinter().printReceipt` call shape used at checkout. **Flag (working rule 3)** if a history row lacks full line items/payment/totals — if so, fetch the order detail before printing (note the endpoint) rather than guessing.

- [ ] **Step 2: Add a "Cetak Ulang" button** to each past order (or the order-detail view) that calls `printReceipt` with the same `ReceiptData` builder used at checkout, plus `reprint: true`:
```tsx
  <button onClick={() => void printer.printReceipt({ data: <receiptDataForOrder>, settings: <settings>, reprint: true })}
    className="...">Cetak Ulang</button>
```
Disable it when the printer isn't paired (match the existing checkout/receipt print guard). The `reprint: true` flag relies on the Phase A change.

- [ ] **Step 3: Typecheck + commit.**
```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
git add apps/pos/src/cashier/OrderHistoryPanel.tsx apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(pos): reprint sales receipt from order history (with REPRINT marker)"
```

---

## PHASE F — Build, APK, verify

### Task F1: Full build + APK dispatch + push

- [ ] **Step 1: Full POS typecheck + build.**
```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
corepack pnpm --filter @mandalika/pos build
corepack pnpm --filter @mandalika/printer test
```
Expected: all clean/green.

- [ ] **Step 2: Push** (if not already) so CI builds from the latest commit.
```bash
git push origin prod-hardening
```

- [ ] **Step 3: Dispatch the signed APK** (workflow_dispatch on `prod-hardening`; token from `git credential fill`, has `workflow` scope):
```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Epheyy/mandalika-pos/actions/workflows/android-release.yml/dispatches \
  -d '{"ref":"prod-hardening","inputs":{"api_url":"https://mandalika-pos-538849926142.asia-southeast2.run.app"}}'
```
Then poll the run for the `mandalika-pos-release-apk` artifact.

- [ ] **Step 4: User-pending on-device verification.** Surface to the user (agent can't drive a paired BLE printer or a device): (a) the hamburger dot lights when an inbound transfer arrives; (b) Menu → Riwayat Transfer lists Selesai/Dibatalkan, detail shows items + discrepancy; (c) "Cetak Ulang Tanda Terima" prints with `*** CETAK ULANG (REPRINT) ***` at top + bottom; (d) order history "Cetak Ulang" prints the sales receipt with the same marker; (e) original checkout receipt + post-receive tanda terima print WITHOUT the marker.

---

## Self-review notes (gaps flagged for the executor)

- **`Transfer` field casing** (`source.name`/`dest.name`/`items[].*`/`receivedAt`/`discrepancyReason`/`status`): confirm against generated `schema.d.ts` when wiring `TransferHistoryPanel`; adjust if the DTO differs.
- **Reprint deps location:** `usePrinter()`, `settings`, cashier name, and `buildTandaTerimaData` are used by the existing post-receive `TandaTerimaPrompt` flow — reuse those exact references (read CashierScreen/ReceiveTransferPanel first); don't introduce parallel ones.
- **F4 order data:** if an order-history row lacks full line items, reprint must fetch the order detail first — flagged in E1 Step 1; do not fabricate receipt data.
- **`print.ts` job types:** Phase A adds `reprint?` to the print-job types; confirm the exact type names (`PrintJob`/data shape) when threading.
- On-device printing is the only true verification of the marker placement; CI/agent verifies byte content via the Phase A Vitest only.
