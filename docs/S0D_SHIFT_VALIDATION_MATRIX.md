# S0d-shift-decode — contract and evidence

Historical E11 matrix, amended by CG-S0D-SHIFT-DECODE-20260920-01-R1:
changes requested for outer envelope; corrected locally under E13 in
S0D-ENVELOPE-A23-20260920-01, re-review pending. Parent A43/T25 remains open.
Authority AUTH-MANDALIKA-20260919-01; controlling reply CG-S0C-20260920-01-R1.

## Current contracts and callers

POS useShift supplies explicit startingCash (including automatic zero), closingCash
and the close reference. Shift recap converts UI input before capture; this slice
does not rewrite that capture or historical events. Authenticated server routes
use caller/outlet scope, with no new shift permission. handlers/writes.go and batch
dispatch delegate to the unchanged shift service.

Previously direct open/close ignored DecodeLoose errors and could mutate after
partial decoding. Batch json.Unmarshal rejected bad syntax but treated missing/null
cash as zero. OpenAPI also omitted required declarations; no documented empty-body
default was found. All inspected current producers send cash explicitly. Unknown
external legacy producers were not surveyed.

The shared decoder requires one complete object and explicit non-null cash. It
rejects wrong types, overflow and cash outside signed numeric(14,2). Explicit zero,
signed/fractional values and existing database rounding are preserved; no new
nonnegative policy. JSONB method values retain the finite-float domain without an
invented numeric-column cap. Whole counts may be absent/null/empty, preserving
stored counts through existing COALESCE behavior. Zero count is explicit; null
individual count is invalid. Method IDs remain exact-case/free-form.

Single case aliases of consumed top-level fields stay compatible; duplicate names/
aliases are rejected. Unknown metadata stays tolerated. Optional outletName may
be absent/null/string. Direct close uses route ID; batch requires nonblank string
shiftId. Body claims never provide authority. OpenAPI required declarations and
generated Go/TypeScript DTOs now align. Installed Go generator exits 0 with its
existing incomplete OpenAPI 3.1 support warning; consumers compile.

## Main reply acceptance scenarios

| ID | Evidence/result | Limit |
|---|---|---|
| SD01 | Same four TestShiftMalformedBodyRegression assertions failed before fix with one mutation call each; pass after | Spy boundary, separate real DB test |
| SD02 | Parser/direct/dispatch/DB reject partial decode, wrong types, truncation and overflow | Full-row DB checks for direct and representable batch payloads |
| SD03 | Missing/null required cash rejected, explicit zero passes real direct/batch service | No fabricated historical default |
| SD04 | Real signed/zero/nonzero/fractional cash and null name; unit absent/string name | No new shift/cash-sign policy |
| SD05 | E11 proves direct/inner completeness and one truncated HTTP envelope only | It did NOT prove outer trailing junk/second-value rejection. E12 reproduced gap; E13 BE01/05/09 adds real raw-envelope coverage. Historic logs unchanged |
| SD06 | Absent/null/empty counts preserve seeded DB counts; explicit zero/custom methods persist; malformed values/maps rejected | Large finite JSONB count unit-tested, no business cap |
| SD07 | E11 proves consumed shift payload duplicates/aliases and exact method IDs only | It did NOT prove outer items or item type/key/payload duplicate rejection. E13 BE02/03/04/07 adds structural preflight; inner per-item rejection preserved |
| SD08 | Signed synthetic JWT, RequireAuth, real caller lookup/routes/services/readback; forged body ignored; missing token 401/wrong outlet header 403 | No live revocation or capture-time authority claim |
| SD09 | Mixed invalid shift, valid independent shift, forbidden forged refund returns error/ok/error under original keys | Independent valid effect commits |
| SD10 | Isolated PostgreSQL 18.3, 45 existing migrations; denials preserve complete rows in ten relevant tables; valid services/readback pass | No live DB, Redis, external payment, concurrency or universal receipts |
| SD11 | Both shift types: five denials, parked counts, repeated unchanged diagnostics, same successful KV reconstruction and original-key retry | API response stub; no device durability, fresh UI/browser or backend-to-device E2E |
| SD12 | Affected Go suites pass; sync 31/31, POS 160/160; API/sync/POS types pass including S0a/b/c regressions | Normal Go skips opt-in DB tests; separate final shift DB run passes; prior sale DB not rerun |
| SD13 | Successful readback and existing already-closed behavior tested; post-commit code unchanged | Failure-after-commit injection/fix deferred; no new 500/retry path |
| SD14 | Fixture identity/data-dir verified before migrations, final DB test passed and server stopped exit 0; artifacts replay/hash verified | Directories retained; old cleanup block unattempted/unbypassed |

Compared tables: shifts, cash_flows, orders, order_items, outlet_variant_stock,
customers, point_transactions, discount_codes, promo_reward_grants, processed_keys.
Cache/version behavior outside these business tables is unchanged. No claim that
every database row never changes.

## Fixture safeguards and outstanding work

New fixture: C:/Users/MYBOOK~1/AppData/Local/Temp/mandalika-s0d-vg7qsp_l/postgres-synthetic.
Only 127.0.0.1:56440, mandalika_s0d_synthetic, s0d_test. Test refuses other parsed
targets, requires matching SHOW data_directory and an empty public schema before
45 existing migrations. No .env/provider secrets or live targets. Synthetic JWT
key/data deliberately non-production. Recreated only the identity-checked test DB
for the final run, then stopped its server. No filesystem deletion attempted.

Old fixture: C:/Users/MYBOOK~1/AppData/Local/Temp/mandalika-s0c-z4tdt0x0/postgres-synthetic.
Its stopped cleanup remains policy-blocked, no retry, alternative interpreter,
elevation, rename or deletion workaround. Independent work continued.

Remaining: post-commit uncertainty, other ignored decoders, durable capture, error
taxonomy, request/resource bounds, shift concurrency/idempotency and historical
recovery. No deployment/release or full A37 redaction qualification. Codex local
self-review only; no independent S0d review claimed.
