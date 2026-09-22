# Q08 — historical approval evidence (sanitized)

Prepared 2026-09-19 for CG-MA-20260919-01-R1 / S0A-20260919-01.
These are exact excerpts from existing repository decision records, not a newly
invented owner approval or a verbatim original chat transcript. The original
chat turns are not supplied locally in this evidence package. Source documents
were inspected; their historical verification/deployment claims were not rerun.

## Assigned-code identity — July 7, 2026

Source: `docs/superpowers/specs/2026-07-07-code-sp4-customer-assigned-design.md`,
lines 5 and 14–21, tracked at HEAD `4691c781842f0114acaf2e4371e0d11f0076f553`.

> **Status:** Design approved — build

> 3. **Match by RAW customer_id** on both POS and server (no merge-keeper resolution), so both sides behave identically. **Documented limitation:** if the assigned customer is later merged (SP-CRM-Merge), the code stops matching and must be reissued. Rare; avoids touching the merge transaction.

> 5. **`ON DELETE CASCADE`** on the FK — a personal code dies with its customer (vs `SET NULL`, which would wrongly make it public).

Corroborating source: `SESSION_HANDOFF.md`, July 7 SP-Code-4 banner, paragraph
beginning `Decisions:` (line 246 at S0a entry; later prepends shift that line).
Exact relevant excerpt, omitting unrelated implementation notes:

> **Decisions:** RAW-id match → **documented limitation:** an assigned customer later MERGED (SP-CRM-Merge) stops matching → reissue the code (user chose this over touching the merge tx). **`ON DELETE CASCADE`** (personal code dies with its customer; user confirmed — you CAN recreate the same code string afterward, it's a fresh code; only string-based reporting history conflates old+new).

Disposition: preserve raw assignment and the recorded reissue choice. No later
owner supersession found in the current supplied conversation, plan/draft or
relevant handoff records. This is documentary evidence of approval, not independent
verification of the original conversation. Fresh code identity after deletion
does not specify whether a merge-related reissue carries remaining allowance.
Merged cap subjects, reissue allowance/provenance and concurrency safeguards stay
open under Q08/A25; no reassignment or cap-policy change implemented in S0a.

## Shortage treatment — June 11, 2026

Source: `docs/superpowers/specs/2026-06-11-crm-sp9c-stock-awareness-design.md`,
lines 3 and 10–14, tracked at the same HEAD.

> Date: 2026-06-11 · Status: APPROVED (user, this session) · Builds on SP-CRM-9 / 9b (rev 00060-cdn)

> - Negative-stock enforcement = **warn + allow override** at POS checkout (offline-first: the sale already happened on-device; a hard block could freeze a legitimate sale from stale counts).
> - New setting default = **allow negative** (preserves today's behavior; opt-in to stricter).
> - Include the **optimistic local decrement** in this slice (fixes #3 and makes the warning accurate vs. what the cashier sees).
> - Server stays **lenient** — it records + flags, never rejects an offline sale. The setting drives POS UX only.

Source qualifier in the same document, section 2, line beginning `Server:`:

> - **Server:** unchanged. Sync path still records + flags `stockWarning`; direct online path still zero-floors. No new rejection. Documented so no one expects server enforcement.

Disposition: preserve warning/override and acceptance of legitimate already-captured
sales. No later superseding owner decision found in the inspected decision sources.
Historical zero-flooring is evidence of an implementation limitation, not approval
to hide physical shortages. A44 retains truthful movements, shortage/override
evidence, tombstoned identities and durable exceptions; A09 retains valid quantity
invariants. Neither new online hard denial nor an inventory repair is authorized
by S0a. A25/A44 are not closed by this narrow documentary correction.

No credentials, customer records or unrelated historical transcript sections are
included. Source hashes are provided in the reconciliation evidence artifact.
