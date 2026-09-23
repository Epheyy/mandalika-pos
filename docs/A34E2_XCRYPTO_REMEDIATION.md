# A34e2 — x/crypto remediation

Packet: A34E2-XCRYPTO-20260923-01. Authority: AUTH-MANDALIKA-20260919-01.
Review input: CG-A34E1-GO-REMEDIATION-20260922-01-R1.
Entry: feb0048de2a577bf8e5b2d9243944ce115aa3a29, audit/hosted-proof-20260922.

A34e1 is scoped ChatGPT accepted. A34e2 is implemented and locally+hosted verified, pending ChatGPT review.
A34/T29, A38/T33 and every release gate remain open.

## Exact dependency scope

Only go.mod/go.sum and two new synthetic password-test/fixture files affect
executable inputs. Production password code, API contracts, business source,
migrations, workflows, policy thresholds and exceptions remain unchanged.
The exact command was `go get golang.org/x/crypto@v0.56.0`; no broad update.

| Module | Before | After | Required graph edge |
| --- | --- | --- | --- |
| x/crypto | v0.46.0 | v0.56.0 | Explicit minimum fixed target |
| x/mod | v0.37.0 | v0.38.0 | golang.org/x/text@v0.41.0, golang.org/x/tools@v0.48.0 |
| x/net | v0.56.0 | v0.57.0 | golang.org/x/crypto@v0.56.0, golang.org/x/tools@v0.48.0 |
| x/sync | v0.21.0 | v0.22.0 | golang.org/x/text@v0.41.0, golang.org/x/tools@v0.48.0 |
| x/sys | v0.46.0 | v0.47.0 | golang.org/x/crypto@v0.56.0, golang.org/x/tools@v0.48.0 |
| x/telemetry | v0.0.0-20260625142307-59b4966ccb57 | v0.0.0-20260708182218-49f421fb7959 | golang.org/x/tools@v0.48.0 |
| x/term | v0.38.0 | v0.45.0 | golang.org/x/crypto@v0.56.0 |
| x/text | v0.39.0 | v0.41.0 | golang.org/x/crypto@v0.56.0 |
| x/tools | v0.47.0 | v0.48.0 | golang.org/x/text@v0.41.0 |

The 137 third-party selected modules remain 137. Six root requirements change;
x/net, x/term and x/telemetry move transitively. The go directive normalizes
1.26 to 1.26.0 as required by the target, using the same existing Go 1.26.8
verification toolchain. The generator tool declaration remains unchanged.
All 13 added go.sum lines belong to selected target/support versions; none
are removed. Read-only tidy-diff's broader historical checksum cleanup is not
applied. Old checksum entries do not select old module versions.

## Password compatibility

The fixture was captured before the upgrade from the real HashPassword function
with x/crypto v0.46.0, using a fixed synthetic salt/input in a disposable source
copy. Checked-in encoded bytes are identical to that capture. The same 19 named
parent/subtest assertions pass before and after the update: old correct/wrong/
empty passwords, fixed-input byte equality, fresh distinct salts, encoding and
parameters, new correct/wrong passwords, digest tampering, and malformed inputs.
A disposable digest-bit mutation makes the real compatibility test fail; the
active fixture is unchanged. No database credentials or customer hashes are used.

The current Argon2id contract remains v19, m65536 KiB, t1, p4, salt16 bytes,
key32 bytes with raw standard Base64. The fixed-random-reader test is explicitly
serial and restores the process-global reader through t.Cleanup. Current auth
tests contain no parallel runner. Production HashPassword/VerifyPassword bytes
are unchanged; no credential migration or bulk rehash exists in this slice.

Existing malformed parser limitations are characterized, not endorsed or fixed:
a numeric v18 field is not validated and zero rounds/threads cause the same
Argon2 panic before and after. This is separate future stored-hash input hardening.
Ordinary malformed syntax keeps false/errBadHash behavior.

## Fresh security evidence

Full scans with pinned govulncheck v1.8.0 and unchanged DEPSEC-INITIAL-20260922
complete before and after. JSON exit status alone is not used as a clean result.
Blocking policy records fall 69 -> 48; distinct (ecosystem, package, ID) keys
fall 63 -> 42. Advisory aliases/scoped records are not independent exploit counts.
All 29 x/crypto advisory records with a known fixed version <=v0.56.0 disappear;
21 were blocking. No new policy blocker or called finding appears.

The only remaining x/crypto advisory is no-fixed GO-2026-5932, retained as a
blocking module-level runtime-present-unproven record. Neither OpenPGP nor any
vulnerable x/crypto package is imported/called according to current import and
scanner evidence. The application imports argon2 and blake2b; Argon2 has no
called x/crypto finding. Existing chi GO-2026-5775/GO-2026-5777 remain called.
chi, kin-openapi, xlsx and rgbcolor findings stay visible. The register stays
empty; no policy change or exception makes the dependency job green.

## Verification

Local make gen-check, gofmt, vet, build and ordinary Go tests pass under Go 1.26.8.
Ordinary tests record 510 PASS events and the six opt-in DB skips; these skips
are not database evidence. Password-only tests record 19 PASS, zero skips.
The six isolated PostgreSQL 18.3 gates pass 142 named parent/subtests with race,
zero skips and verified fixture/container cleanup. A disposable network-none
Linux container uses the unchanged guarded native runner and fixed loopback
ports, with no published ports. Verified public module caches permit network-off
execution; module checksums and TLS are not bypassed. First fixture-image build
failed because BuildKit interpreted a bare image SHA as a registry name; using
the existing local tag after matching its exact identity corrected the launcher.
That setup failure is retained.

Final hosted SHA `76cc02b2fec813ee534a998c9a45ff9cde5db9f4` passes quality 35811155308,
backend 35811155301, postgres 35811155452 and browser 35811155310. The default
PostgreSQL 18.3 Docker/race runner passes all six gates, 142 named parent/subtests,
zero skips, verified target identity and cleanup. Chromium passes 26/26, zero
skips/unexpected network requests, confirmed browser/Vite cleanup. Dependency
run 35811155324 completes a fresh committed-input scan and correctly FAILS on 48
blocker records, identical to the local blocking set. No new called finding;
GO-2026-5932 remains visible, module-level and unimported. These hosted outcome
paragraphs are uncommitted reporting after-images of the tested executable source.
A34e2 ChatGPT review is pending; A34/T29, A38/T33 and every release gate stay open. Raw commands, working directories, exit statuses, exact module graphs,
scanner messages, policy records, fixture capture and negative proof are bundled.

Historical stopped DB/cache cleanup remains untouched. New fixture resources are
owned and identity-checked. No native/customer/production target is contacted.
After ChatGPT review, the next bounded work is the already-approved official
SheetJS 0.20.3 vendoring slice. chi ingress trust and rgbcolor owner/legal approval
remain unresolved; this dependency update does not decide either.

## Subsequent review — 2026-09-23

CG-A34E2-XCRYPTO-20260923-01-R1 scoped-accepts this exact checkpoint.
20 accepted milestones across 11 findings; no parent or release closure. The
stored-hash characterization residual is linked to A07/A09 for separate hardening.
