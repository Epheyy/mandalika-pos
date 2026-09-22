# Mandalika POS — A04/A14 business clarification and proposed implementation contract

Date: 2026-09-19
Status: design-review handoff for the existing Codex session; not application implementation or release approval.
Scope: refine A04 and expand A14 from AUDIT_REPORT.md and PLAN_ADDENDUM.md. Preserve all unrelated approved policies.

## 1. Authority, baseline, and workflow

The user wants ChatGPT to analyze policy/design and Codex to execute reviewed changes. This memo records the user's two new requirements, distinguishes them from proposed technical controls, and identifies conflicts needing resolution. Do not treat every proposal below as an independently approved business policy.

Evidence basis: the uploaded mandalika-pos.rar; the supplied audit and addendum; source files re-read through GitHub at prod-hardening commit 4691c781842f0114acaf2e4371e0d11f0076f553. No claim is made about later, unshared Codex edits or another worktree. No application tests or production operations were performed for this clarification. Numerical examples were checked arithmetically, not against the application.

For the next Codex turn, first reconcile this memo with the active worktree and latest decision documents. Report material differences; do not reset branches, discard local work, or silently replace newer user decisions. The immediate deliverable is a documentation/design diff plus bounded implementation slices and required tests. Implementation authorization is separate.

## 2. New user requirements — confirmed in this conversation

U04: Each operational POS device is tied to one outlet and its Admin/Team Leader outlet account. Ordinary use does not involve changing outlets. Remove ordinary POS logout/outlet-switching ability; account/device access administration belongs in Backoffice. Do not add a normal multi-outlet POS switching workflow to satisfy the old audit example.

U14: Stock counts must support manual input/import while sales continue, including delayed and backdated entry. Reconciliation should automatically calculate the correct stock effects when the observation and movement evidence is sufficient. Do not solve this by requiring the entire outlet to stop selling or by refusing all historical counts.

## 3. Existing policies that must not be silently changed

The uploaded consolidated plan, line 39, and draft, lines 31–33 and 324–328, require staff online authentication at shift start and approved offline authority for that shift. Permanent device enrollment is compatible with that requirement; a lifetime staff authentication with no later shift check would change it. The exact shift-start authentication experience is still a design decision. Background token refresh alone must not be represented as proof that a particular human authenticated.

The draft, lines 1055–1083, requires outlet-scoped TL authority and the TL's own in-app identity for paid-sale voids. It explicitly separates initiating cashier from authorizing TL and does not accept a plain TL-name selection as authentication. A terminal left signed in to a shared TL account must not automatically authorize every user's privileged action. A targeted in-app authorization can preserve the fixed outlet/session without logout; the credential/step-up mechanism remains to be selected.

The draft, lines 259–268, already proposes preserving count time, baseline/version, and movements during overlapping sales/transfers rather than overwriting stock. Lines 330–332 leave count-conflict authority unresolved. The user's new clarification establishes live/backdated count support, not arbitrary conflict-resolution authority or unlimited automatic changes to closed periods.

Inspection-held returns, pending receipts, testers, and sellable goods remain distinct. A count must not silently release held/provisional goods for sale. Inventory reconciliation does not authorize rewriting original sales, payments, submitted shift-close evidence, or financial approvals.

## 4. A04 — revise the scenario, retain historical attribution

### 4.1 Corrected finding

Reframe A04 as: **The fixed terminal/account/outlet invariant and preservation of original event identity need server enforcement and recovery evidence.**

The old normal-operations example of a POS admin switching from outlet X to Y is not the user's intended business workflow. Replace that example rather than treating multi-outlet switching as a product requirement. A04 can be closed when the enforced fixed-binding and recovery behavior is verified; it should not remain open solely because a prohibited routine journey is imaginable.

At the reviewed commit, however, OutletSwitcher.tsx:32–35 exposes switching for the technical admin/manager roles, and sync.go:184–223 constructs an order's outlet and cashier from the current batch caller. Consequently, intent and implementation are not yet equivalent. The business title Admin/TL must be mapped deliberately; it is not automatically the global technical admin role.

### 4.2 Proposed controls

- Enroll the terminal through a server-controlled, immutable device-registration record binding its device identity to the outlet and permitted account. Reject an incompatible outlet or registration on POS commands, including direct and batch paths. Do not rely on hiding buttons or on client-supplied outlet IDs.
- Remove normal POS outlet selection and logout from the supported business flow. Keep legitimate Backoffice cross-outlet functionality under its own scopes. Authentication failure may require an access-recovery screen, but must not destroy pending history or become an unrestricted account picker.
- Bind each captured operation to an immutable registration identifier, operation ID, monotonic local sequence, original account, original shift, capture time, schema version, and appropriate authorization evidence. Where the business actually tracks a human operator or approver, retain that identity separately. The server can resolve the outlet from the historical immutable registration; arbitrary payload IDs are not proof of authority.
- A refreshed token is a delivery credential, not a replacement for the historical event's actor. Registration/account changes must not retroactively mutate existing envelopes.
- Backoffice credential rotation, revocation, and replacement-device recovery preserve prior queued facts under their original registration and operation IDs. Recovery is authenticated and audited; it is not unrestricted acceptance from a revoked credential. Block new unauthorized work according to the approved authority rules while retaining authentic prior evidence.
- A replacement enrollment has a distinct registration generation. Restoring an old queue must not generate new sale IDs or silently create two active clones of one operational identity. A nonempty unresolved journal cannot simply be wiped to complete administrative recovery.
- Enrollment persistence does not require an indefinitely valid bearer token. Preserve an explicit refresh/revocation model and the approved shift-bounded offline authority. Do not promise immediate remote enforcement on a disconnected terminal; define the offline authorization expiry and reconciliation behavior without inventing a duration.

These controls preserve the user's no-routine-logout/no-outlet-switch model. They do not impose a login/logout cycle on every sale or require support for moving terminals between outlets.

### 4.3 Remaining business clarification

Determine whether the permanently logged-in Admin/TL account identifies the actual sole operator or a shared terminal account. When shared, it does not by itself identify the staff member using the device or prove a fresh TL authorization. Preserve the distinction rather than silently labeling every action as performed/approved by the TL. Do not introduce new everyday cashier authentication obligations without reconciling them with the existing shift policy.

## 5. A14 — live and backdated stock-count reconciliation

### 5.1 Corrected requirement

**A count is an immutable observation of a scoped physical quantity at an identified cutoff, not an instruction to set current stock to an old number.**

Keep the original observation and completion receipt immutable. Derived reconciliation can acquire new audited versions when late movements or authorized corrections appear. An erroneous submitted observation is corrected by a linked superseding observation/correction command, not generic reopening or deleting the original.

“Frozen baseline” means retained historical evidence, not frozen selling activity and not a baseline forever assumed complete. Preserve the original calculation inputs; append a revised calculation when the known history changes.

### 5.2 Scope and timing

Each count line needs a count/line identity, location, product/variant, quantity and unit, inventory disposition/bucket, physical observation cutoff, and audit attribution. Record observation time separately from entry/import time, server acceptance time, and application time. Use the configured outlet timezone and retain an unambiguous time representation.

For in-app capture, record the relevant local operation-sequence boundary and known server inventory revision where practical. A local sequence establishes order for that device, not for independent Backoffice/other-source movements. Reconciliation needs all relevant sources and a deterministic before/after classification at the physical cutoff.

A shared file timestamp is valid only for a genuinely common physical snapshot or an explicitly movement-normalized observation. A list counted over 09:00–11:00 cannot automatically be treated as all physically counted at 09:00 or at upload time. Per-line observation time, an equivalent proven cutoff, or recorded movements during the counting interval are needed. A date-only value does not establish an intraday cutoff; never silently assume midnight, upload time, or closing time.

Store count and physical-movement evidence sufficient to explain an item moving during the count itself. Do not equate an electronic invoice timestamp with physical stock handover without a defined business rule. Sales can continue across the outlet; ambiguous individual lines may require a recount/review rather than inventing precision.

### 5.3 Reconciliation arithmetic

For a single accepted count and no later accepted count for the same stock scope:

    discrepancy_at_cutoff = observed_qty - reconstructed_book_qty_at_cutoff
    current_corrected_qty = current_book_qty + discrepancy_at_cutoff

Equivalently, with complete movement history and a consistent cutoff:

    current_corrected_qty = observed_qty + sum(net movements AFTER the cutoff)

Movements at/before the cutoff are already reflected in the physical observation and must not be charged again after it. The model applies separately to the relevant location/product/variant/unit/disposition. It includes all pertinent stock-changing events, not just sales. Multiple accepted counts require chronological interval reconciliation; do not independently stack adjustments calculated against incompatible baselines.

Worked example:

| Fact | Quantity |
|---|---:|
| Book stock reconstructed at 10:00 | 100 |
| Physical stock observed at 10:00 | 80 |
| Sales after 10:00 and before 14:00 import | -12 |
| Accepted receipt in the same stock bucket after 10:00 | +5 |
| Book stock just before import | 93 |
| Discrepancy at 10:00 | -20 |
| Correct current stock | 73 |

Correct result: 80 - 12 + 5 = 73. Setting current stock to 80 discards later movements. Comparing 80 to the import-time balance of 93 incorrectly treats the discrepancy as -13 instead of -20.

### 5.4 Late pre-count events

Suppose a five-unit sale physically occurred before 10:00 and was already reflected in the observed 80, but reaches the server after the count was applied. Reconstructed book stock at 10:00 becomes 95, so the discrepancy becomes -15 rather than -20. Current stock remains 73 under the same post-count movements.

Blindly adding the late -5 movement to the old -20 adjustment would produce an incorrect 68. Retain the sale and original observation; append a linked +5 reconciliation compensation or equivalently rebuild a versioned projection whose ledger net reflects the revised discrepancy. Do not erase the sale, edit the original adjustment invisibly, or apply the observation a second time.

A late movement physically AFTER 10:00 is different: it changes current stock once. Tests must distinguish occurrence order from arrival order. Unknown/ambiguous occurrence evidence remains visible rather than being silently assigned to a convenient side of the cutoff.

### 5.5 Later counts and historical entry

Example: Monday's physical observation is 80; Tuesday's accepted physical observation is 60; subsequent sales are 5, yielding 55. Importing Monday's observation on Wednesday must not replace the Tuesday anchor or make current stock 75. It may revise historical interval discrepancies, with the Tuesday observation and subsequent movements still yielding 55.

Order by the validated observation/cutoff, not import arrival. Recalculate affected intervals and derived adjustments with history retained. Conflicting observations for the same item/cutoff require explicit resolution; arbitrary last-writer-wins is not a business policy.

### 5.6 Completion, import, and concurrency

- Validate the import schema before application: item/variant mapping, outlet/location, base unit, finite/nonnegative physical quantities with supported precision, disposition, time/cutoff evidence, duplicate rows, and row identity. Missing rows are not zero. A zero count is explicit. Do not silently aggregate duplicate observations, split malformed CSV fields, or reset uncounted products.
- Record import provenance and a stable logical count/line identity. Reimport/retry of the same operation has one effect; a changed body under the same key is a conflict. File names or matching quantities alone cannot distinguish a transport retry from a genuinely new count.
- Separate capture, pending synchronization, needs-review, and accepted/applied status. The physical observation may be safely saved while reconciliation is waiting for missing history. Routine unambiguous input should reconcile automatically; human approval must not be invented for every row. Conflict-review authority, thresholds, and closed-period policy remain to be assigned.
- Apply the command receipt, count lifecycle transition, stock/reconciliation effects, and audit atomically at the agreed unit of application. State explicitly whether a multi-line import is atomic as a session or applied per line; never label the whole import successful while hiding unapplied lines.
- Coordinate every writer affecting the stock scope, including sales, transfers, receipts and count application, through a shared concurrency strategy. A count-row lock alone is insufficient when competing writers do not participate in the stock-scope protocol. Use short transactions, consistent lock ordering, validated revisions, and classified retry. Do not hold database locks while people count shelves or while waiting for a device to reconnect.
- Completing an already completed count returns its immutable command receipt without replaying stock effects. A separate response field/read model may expose a newer reconciliation revision. Generic update cannot reopen, replace lines, or cancel a terminal count to overwrite its history.
- Keep catalog versions distinct from movement/projection coverage as necessary. POS provisional debits/credits are removed only when the returned canonical projection demonstrably includes them; refreshing after a count must not lose or double-count a queued sale.

### 5.7 Evidence limits and historical reports

Automatic arithmetic is reliable only to the extent the physical observation, cutoff, and relevant movement history are known. A disconnected POS can show its local/provisional view; Backoffice cannot claim complete global reconciliation while required movements remain unsynchronized. Missing history should be visible and later reconciliation automatic when sufficient evidence arrives.

Do not claim to reconstruct stock before the earliest trustworthy retained baseline without evidence. Preserve as-recorded history alongside restated inventory views. A backdated count does not rewrite paid-sale values, original receipts, original shift-close submissions, or stock-cost/financial closed periods by implication. Define who may backdate, historical limits/closed-period treatment, and who resolves ambiguous conflicts before implementing those policy choices. No arbitrary cutoff period is selected here.

## 6. Required acceptance scenarios — proposed, not passing application tests

Replace T04's routine outlet-switching scenario with fixed-terminal and recovery tests. Expand T11 rather than removing its replay regression.

| ID | Scenario | Required result |
|---|---|---|
| T04a | POS UI and direct/batch API try incompatible outlet/device scope | No normal switch; server rejects incompatible scope; legitimate Backoffice scope remains available |
| T04b | Offline sale, reboot, token refresh, delivery | Original registration/account/outlet/shift retained; one receipt/effect |
| T04c | Backoffice credential rotation/revocation with pending evidence | No silent deletion or reassignment; new authority and historical recovery handled separately |
| T04d | Replacement-device/backup recovery | Original event IDs preserved; distinct enrollment generation; no silent operational clone |
| T04e | Persistent account, new shift, and TL-only action | Existing shift authentication and distinct required TL authorization remain enforceable without logout/outlet switching |
| T11a | Count 80 at 10:00, sell 12, receive 5, import at 14:00 | Current stock 73; discrepancy -20 against book 100 at cutoff |
| T11b | Complete count at 10; sell 2; replay completion | Current stock remains 8; receipt repeated without stock effect |
| T11c | Negative stock movement of 5 occurred before count but arrives late | Reconstructed discrepancy changes -20 to -15; current remains 73 in worked example |
| T11d | Movement occurred after count but arrives late | Current stock changes once; no pre-count compensation |
| T11e | Monday count imported after accepted Tuesday count | Tuesday anchor and subsequent movements determine present stock; historical intervals audited |
| T11f | Concurrent sale and count application; concurrent count completions | Neither effect lost/duplicated; consistent serial outcome and bounded retries |
| T11g | Long rolling count with movement during one item's counting interval | Correct per-line cutoff/normalization; ambiguous line not given invented precision |
| T11h | Same import repeated; response lost; changed quantity under same command ID | One effect for same body; changed body conflicts; correction requires new linked command |
| T11i | Partial count, explicit zero, duplicate rows, bad unit/timezone/CSV | Only intended valid scope applies; omitted item unchanged; errors and unapplied rows visible |
| T11j | Physical observation includes held/pending/tester goods | Separate correct dispositions; no implicit release into sellable stock |
| T11k | Authorized correction of a completed observation | Original evidence remains; linked superseding observation/reconciliation revises affected intervals |
| T11l | Reconciliation updates POS while local movements remain pending | Projection covers each physical effect once; no stock rebound or duplicate subtraction |
| T11m | Offline count, late dependencies, reconnect | Capture survives restart; incomplete reconciliation visible; automatic correct reconciliation after evidence arrives |
| T11n | Backdated count touches a closed shift/financial period | Original close/payment evidence retained; approved historical-reporting/period policy enforced |

## 7. Related findings remain in scope

A04 interacts with A01/A02 (durability and retention), A05/A07 (shift authority and sessions), A30 (scope/permissions), and A41 (local history/device recovery). Fixed POS outlets do not remove A31: Backoffice still has independent multi-outlet views and polling races.

A14 depends on A11 (operation receipts), A15 (projection coverage), A16 (offline count capture), A17 (complete movement history), A28 (business time), A39 (lossless import), and A42 (cross-command concurrency). Its delivery must not be reduced to adding a timestamp column and replacing an absolute write with a subtraction.

## 8. Suggested next Codex deliverable

Read the latest local draft, plan and handoff. Reconcile U04/U14 and the policy tensions above. Update documents only to distinguish approved requirements, proposed mechanics, and unresolved business decisions. Adjust A04/T04 wording and expand A14/T11 coverage with the scenarios above. Produce a bounded implementation plan with files/migrations affected and evidence gates. Stop before application code changes, deployments, live data writes or credential administration unless separately authorized.

Carry evidence back to ChatGPT as a compact handoff: active root/branch/commit; changed document paths and diff; decisions preserved/superseded/open; smallest proposed implementation slice; exact test commands and observed outputs if any were separately authorized. Do not call proposed tests passing or use this memo as a release sign-off.

## 9. Source locations

- Uploaded docs/PRODUCTION_READINESS_PLAN.md:3–6, 23–47, 68–90, 128–147.
- Uploaded docs/PRODUCTION_READINESS_DRAFT.md:31–33, 210–268, 324–332, 1055–1083.
- Supplied AUDIT_REPORT.md: A04, A05, A14, A15, A17, A28, A30, A39, A41, A42.
- Supplied PLAN_ADDENDUM.md: sections 2–4, 6–8; tests T04, T05, T11–T13, T26, T30, T32, T34.
- GitHub baseline source: apps/pos/src/components/OutletSwitcher.tsx:1–58; backend/internal/sync/sync.go:158–223; backend/internal/write/stockcount.go:133–287.
- External technical reference: OWASP Authorization Cheat Sheet (server-side authorization checks); PostgreSQL current documentation, section 13.3 Explicit Locking (row-lock behavior, consistent lock order and short transactions). These support implementation safeguards, not company business policy.

## 10. Selected original draft excerpts

These are excerpts from the uploaded draft, not newly approved decisions.

### Existing shift-start rule — PRODUCTION_READINESS_DRAFT.md:31–33

> - Staff must authenticate online before starting a shift; retain approved offline
>   permissions for that shift. Detailed session expiry and device recovery mechanics
>   remain technical design work.

### Existing overlapping-count proposal — PRODUCTION_READINESS_DRAFT.md:268–268

> | Stock count overlaps sales or transfers | Preserve count time, baseline/version and movements; do not blindly overwrite current stock; reconcile or request review |

### Existing TL identity rule — PRODUCTION_READINESS_DRAFT.md:1065–1075

> Approved authorization mechanism: the TL must authorize a paid-sale void inside
> the application using their own identity. A cashier recording phone/message
> approval does not satisfy this requirement. The external-SPV approval mechanism
> for returns is separate and unchanged.
> 
> Proposed implementation: bind authorization to the specific original sale and
> reviewed correction, preserve both initiating cashier and authorizing TL in the
> audit record, and reauthorize if the proposed correction materially changes.
> Do not implement a plain TL-name selector as authentication or silently replace
> the active cashier attribution with the TL. The exact step-up/login mechanism,
> and credential handling remain design decisions. Offline TL authorization for
