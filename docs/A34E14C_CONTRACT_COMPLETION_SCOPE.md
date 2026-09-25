# A34e14c — contract migration, safe generation and tool-scan completion

Scope ID: **A34E14C-CONTRACT-COMPLETION-20260925-01**
Decision: **CG-A34E14B-CODEGEN-20260925-01-R1 / Q-KB-01**

## Required outcome

Finish the qualified tuple `oapi-codegen2.7.2 / kin-openapi0.149.0 / runtime1.4.2` without
preserving the specifically approved legacy null-collapse or optional-body EOF rejection.
Current spec/options and TypeScript output remain unchanged. The migration must not weaken
handwritten routes, mutate financial/historical data or publish unsafe partial generated output.

Qualification permission is not implementation acceptance. Active graph stays protected until
all promotion prerequisites pass; the accepted milestone count remains31 in this return packet.

## KC01–KC20 acceptance matrix

| ID | Acceptance requirement |
|---|---|
| KC01 | Confirm reply/path and active63c7471 baseline, current dirty state and existing candidate evidence. Select/hash/check Go1.26.8 per process before Go work. No global environment/cache/trust mutation. |
| KC02 | Preserve exact spec/options/TS bytes; retain full raw generated diff and AST classification. Exactly the approved five fields/six EOF adapters and other listed generated categories are explained. No new unreviewed semantic drift. |
| KC03 | For each of five fields: absent/null/realistic populated value/invalid type, repeated round trip and nullable constructors/accessors. Optional absent is omitted; explicit null is retained; no fabricated empty object. |
| KC04 | Real Transfer/IngredientTransfer repository JSON decode/serialize, POS/BO reader and relevant output fallback tests. Separate generated SyncItemResult from actual sync pointer result; historical queued bytes remain untouched. |
| KC05 | All six generated adapters: no body/whitespace, `{}`, JSON null, permitted zero, populated and malformed body. Record dispatch/Body state; generated EOF acceptance is not asserted to be business success. |
| KC06 | Actual handwritten routes/auth/permissions/service behavior remain unchanged. Missing required financial input still rejects before mutation; legitimate existing optional cases remain valid. Isolated DB/auth controls; no provider calls or router swap. |
| KC07 | Typed scope key/named function types/caller inventory; required path/query/header/cookie binding and valid zero; buffer-before-status success and representative serialization-error handling. No invented new enum validation policy. |
| KC08 | One canonical load+Validate/generate path consumes identical frozen spec/config/local-ref snapshot. Current whole document and valid recursive/local-ref fixtures succeed; remote refs and unapproved external inputs cannot trigger I/O. |
| KC09 | KO-OBS-02 unused and reachable cases, missing/invalid refs and malformed input reject before publishing. Original loader12/1 record preserved; new boundary test has explicit passing rejection expectation rather than a fake skip. |
| KC10 | Prove config.output precedence cannot reach the real destination before qualification. Successful output is complete and repeatable; temp output lives on the destination filesystem and is checked before atomic replace. |
| KC11 | Old output bytes survive validation/codegen/output-check/publication error, cancellation and timeout before commit. Input-change and concurrent/stale writer cases cannot publish unvalidated output. Publication commit-point semantics are explicit. |
| KC12 | `make gen-go`, `make gen-check` and relevant CI use the guard; a deliberately drifted generated file makes gen-check fail. Useful required passing boundary suite is checked in and rejects missing/skipped required cases. |
| KC13 | Explicit project-tool govulncheck target coverage in addition to application scan. Required targets reconciled with tool declaration; pinned scanner/config/module/source identity recorded. New guard code is also covered. |
| KC14 | Active supplementary GO-2026-6016 trace replay reaches policy as called/build evidence. Called wins over non-called across targets; duplicate traces/aliases do not inflate unique advisory counts. No severity threshold change or exception. |
| KC15 | Missing tool target, wrong version/graph, absent/truncated/invalid stream, scanner/compiler failure cannot yield clean result. Zero-finding candidate target is accepted only with valid completed evidence. JSON exit zero alone is insufficient. |
| KC16 | Fresh same-scope application+tool before/after inventory/SBOM/licenses/advisories with graph minimization explanation. Preserve raw data, known feed conflicts and SheetJS exact artifact/assessments/expiry. No count target or coverage loss. |
| KC17 | Maintain inert generator escaping/AST checks and valid benign generation/response tests. No hostile generated init code execution, no blanket validation suppression, NoopAuthenticationFunc, unsafe ZIP workaround or remote exploit. |
| KC18 | Backend generation drift/vet/gofmt/build/ordinary tests and x/mod5 pass; all six dedicated PG fixtures run with zero skips. Quality, accepted Node family checks and required browser suite pass; local non-race limits labelled. |
| KC19 | After qualified adoption, explicit stage/normal commit/push on safe branch. Four application workflows pass on one final SHA; expanded security scan completes on same SHA, possibly red for unrelated blockers; hosted race proof required. |
| KC20 | Current packet plus compact ZIP maps every KC row to exact evidence. Counts stay31 until ChatGPT accepts completed remediation. Keep44 parents/A31 resolved/all release gates open; no extra credit for design/evidence decisions. |

## Implementation notes

The scope is the missing completion work from KB05/07/09/11/14/17/18, not permission to rebuild
the entire generator stack. Preserve the useful19-case comparison, inert tests and candidate
qualification already done; extend exactly where the evidence was incomplete.

The typed field changes and EOF adapters are intentionally approved differences. Test their
new expected semantics directly, not old/candidate equality that would contradict this review.
All unapproved successful-wire/business semantics still require compatibility.

When freezing inputs, include transitive local refs and config/template/overlay inputs actually
supported by the canonical command. Current project config has no overlay/user template and
its444 references are internal. Do not add remote/template features merely for this task.
A supported-library in-memory generation path or a checked immutable snapshot is acceptable;
prove identical validated/generated bytes either way.

Guard tests should use deterministic synchronization/failure injection in the test wrapper,
not timing-only races. Keep time/output/memory budgets and owned-process cleanup. Do not claim
a universal OS sandbox, filesystem power-loss durability, or arbitrary-spec safety.

Scanner integration should not conflate a tool command with its complete module graph, or a
called generator function with a deployed-server call. Keep normalized policy decisions and
all raw target traces independently inspectable. Do not multiply18 traces into18 vulnerabilities.
If a fresh provider report adds findings, report them honestly; do not suppress them to reach
an old6/4 candidate target.

## Explicit exclusions

No source OpenAPI rewrite, global nullable disable, manual generated patches, version fork,
automatic2.8.x migration, new production strict router, new authentication policy, SQL/financial
changes, guest/stock/loyalty redesign, historical event normalization, chi migration, licensing
approval, OpenPGP assessment, A13/A42 concurrency, default-local Go replacement, branch policy,
signing/deployment/OTA/live-data action, blanket staging, force push, or denied cleanup bypass.
