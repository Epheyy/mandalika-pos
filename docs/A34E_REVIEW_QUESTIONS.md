# A34e consequential review questions

Packet: **A34E-DEPENDENCY-SECURITY-20260922-01**. These are consequential decisions,
not another phase/slice authorization request. Independent inventory, SBOM, gate,
negative proofs and hosted verification have continued. Exceptions remain empty.

## Q-A34e-01 — client IP trust boundary

Current source installs `chimw.RealIP` globally at `backend/internal/server/server.go:36`.
`backend/internal/middleware/ratelimit.go:44` consumes the resulting RemoteAddr;
`backend/internal/auth/handlers.go:64` also derives the login bucket from it.
The pinned source scan proves calls for GO-2026-5775 and GO-2026-5777, with
aliases GHSA-9g5q-2w5x-hmxf / GHSA-rjr7-jggh-pgcp. Their reported fixed version is
v5.3.0, but a version-only upgrade is insufficient evidence of application repair.

[chi v5.3.0 release notes](https://github.com/go-chi/chi/releases/tag/v5.3.0)
introduce explicit ClientIP strategies and deprecate RealIP. The
[v5.3.2 legacy source](https://raw.githubusercontent.com/go-chi/chi/v5.3.2/middleware/realip.go)
still accepts forwarded client-IP headers without establishing their trust.
Do not let a disappearance from a version-range scan manufacture proof of repair.

Options: use connection IP only, with its shared-proxy rate-limit consequence;
or configure ClientIP from a verified ingress/header/trusted-proxy contract.
Recommendation: establish the actual trusted ingress chain and header-overwrite
guarantee, then implement explicit trust with spoofed-header, direct-request,
IPv4/IPv6 and proxy-chain regressions. Do not guess proxy hops/CIDRs or change
rate-limit/business availability policy incidentally. Which verified deployment
trust contract should the application enforce? Existing provider configuration
was not changed or inferred by this slice.

## Q-A34e-02 — SheetJS remediation/distribution

The exact lock retains xlsx 0.18.5 with GHSA-4r6h-8v6p-xvw6 and
GHSA-5pgg-2g8v-p4x9. Backoffice `src/lib/csvUtils.ts:1` imports it for workbook
creation/export. The current repository search found no `XLSX.read/readFile`
call; this is not proof that all library vulnerability paths are unreachable.
The initial policy blocks High runtime findings regardless of a speculative
JavaScript call-graph exception.

[SheetJS installation documentation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
identifies its own distribution, including the 0.20.3 tarball, instead of an
ordinary maintained npm xlsx patch. Options: pin and integrity-check that vendor
distribution and extend the exact-source collector; replace the workbook
library after format compatibility analysis; or seek an exact temporary reviewed
exception with compensating controls. Recommendation: qualify the vendor build
with workbook round-trip/export vectors, license/provenance verification and all
five gates. This changes the distribution path; it was not silently substituted.
Confirm that technical direction or identify the intended replacement strategy.

## Q-A34e-03 — rgbcolor license classification

The runtime chain is Backoffice -> jsPDF -> canvg -> rgbcolor 1.0.1. Its declared
expression is exactly `MIT OR SEE LICENSE IN FEEL-FREE.md`, which is not a valid
SPDX expression. The exact integrity-verified tarball contains both LICENSE.md
and FEEL-FREE.md; their hashes and original contents are supplied. LICENSE.md
offers the MIT option explicitly. No named SPDX family was automatically denied.

Options: approve an exact package/version/declaration review recording use of
the packaged MIT alternative and its notice obligation; or replace/remove the
dependency through a separately verified PDF path. Recommendation: a targeted
review of the actual terms and distribution context, retaining the original
declaration and file evidence. Record reviewer, decision/date and review-by when
needed before adding any license review entry. Does the owner approve that exact
MIT-alternative review? Codex has not invented or entered that approval.

## Independent next engineering work

The complete blocker list is `hosted/dependency/policy-result.json` in the bundle.
Do not interpret these three questions as the only remaining findings. Routine
candidate upgrades include Vite/tar/brace-expansion/js-yaml/PostCSS/Browserslist/
xmldom and pgx/x/text/x/crypto. They need targeted version/API compatibility review
and the existing five gates, not generic reauthorization. Start with a bounded
pgx/x/text patch/minor compatibility slice: preserve transaction/stock/refund
behavior, generated API parity, six real PostgreSQL gates and called-symbol
comparison. Do not merge that with proxy trust, quote/receipt, native/provider
changes, or a general dependency major-upgrade campaign.

Full A34/T29, A38/T33 and every release gate stay open. This packet does not
approve production use while the dependency gate is failing.
