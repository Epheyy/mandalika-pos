# A34e review decisions

Decision packet: **CG-A34E-DEPENDENCY-SECURITY-20260922-01-R1**

## Q-A34e-01 — chi / client-IP trust

**Disposition: NEEDS_DEPLOYMENT_EVIDENCE. Do not implement a version-only chi fix.**

Current source globally uses deprecated `middleware.RealIP`, and logging/rate-limit/login
buckets depend on the derived address. The dependency baseline proves the RealIP advisories
are actually called.

The documented production API is directly served by Google Cloud Run's `run.app` endpoint.
Google's Cloud Run security documentation establishes that `run.app` traffic is handled by
the Google Front End and proxied onward to Cloud Run. That means treating `RemoteAddr` as
the original end-user address would be an unsupported assumption.

chi's current ClientIP middleware requires choosing an explicit trust strategy:
- direct `RemoteAddr`;
- a header that a trusted proxy unconditionally overwrites;
- X-Forwarded-For with trusted CIDRs; or
- X-Forwarded-For with an exact trusted-proxy hop count.

The currently gathered Cloud Run documentation does **not** establish a sufficiently
specific stable application-visible overwrite/hop contract to pick one of those safely.

Therefore:
- keep both chi RealIP blocker records open;
- do not let upgrading chi merely hide the vulnerable version range while keeping unsafe
  semantics;
- later run a dedicated ingress evidence slice that inspects current Cloud Run ingress
  configuration and performs a controlled non-mutating header-chain/spoof probe;
- then migrate logger/rate-limit/login consumers to chi `GetClientIP` using the verified
  strategy with spoofed-header, direct request, IPv4/IPv6 and proxy-chain regressions.

No proxy hop count/CIDR/header guarantee is invented here.

## Q-A34e-02 — SheetJS

**Disposition: TECHNICAL DIRECTION APPROVED FOR A LATER BOUNDED NPM SLICE.**

The application uses `xlsx@0.18.5` for Backoffice workbook export. The official SheetJS
installation documentation identifies **0.20.3** as the current vendor distribution and
strongly recommends vendoring the tarball for stability.

Approved remediation direction:
1. obtain the exact official `xlsx-0.20.3.tgz` vendor distribution;
2. verify and record source URL, byte SHA-256/integrity and packaged license evidence;
3. check the tarball into a dedicated `vendor/` path;
4. make the workspace dependency a `file:` reference to that exact tarball;
5. extend dependency/SBOM collection so a vendored `file:` dependency remains fully
   identified rather than disappearing from supply-chain evidence;
6. run workbook export/round-trip compatibility and the existing A26 XLSX
   51/201/1000-row evidence;
7. require quality/backend/PostgreSQL/browser/dependency-security to remain consistent on
   the resulting final SHA.

Do not substitute an unrelated fork, floating CDN dependency or silent package source.

This decision is technical distribution/remediation direction only; execute it separately
from the next Go dependency slice.

## Q-A34e-03 — rgbcolor 1.0.1 license

**Disposition: PENDING EXPLICIT OWNER/LEGAL APPROVAL. No exception/review entry yet.**

The exact integrity-verified package contains:
- the full MIT license text in `LICENSE.md`; and
- an explicit statement allowing the user to apply either that MIT license or the
  alternative `FEEL-FREE.md` terms.

Technical evidence therefore supports a targeted classification using the packaged MIT
alternative while preserving the copyright and permission notice.

However, selecting a licensing basis is a legal/compliance decision. Do not claim the owner
has approved it and do not create a license-review exception merely to make CI green.

Suggested owner decision text when ready:

`Approve rgbcolor@1.0.1 under its packaged MIT alternative, preserving the MIT notice.`

Until that explicit decision exists, keep the single license blocker open.
