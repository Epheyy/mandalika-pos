# A34e11 js-yaml remediation

Packet A34E11-JSYAML-20260924-01; AUTH-MANDALIKA-20260919-01.
Entry 4f6347346ac738e9ac4c7c295dd26351e1cd9e94, audit/hosted-proof-20260922.
E60 accepts A34e10:28 milestones across11findings. E9-REPORT-01 closed as corrected
evidence, no additional replay or milestone. All44 retained; A31 alone resolved.
A34/T29, A38/T33 and every release gate open. A34e11 scoped accepted by
CG-A34E11-JSYAML-20260924-01-R1; historical hosted checkpoint retained below.

## Resolution and exact-parent-pin qualification

Actual root ESLint9.39.4 -> @eslint/eslintrc3.3.5 declares js-yaml^4.1.1.
Actual packages/api openapi-typescript7.13.0 -> @redocly/openapi-core1.34.14
**declares exact js-yaml4.1.1**, not a compatible range. Its manifest is unchanged.
The candidate 4.3.2 satisfies ESLint's range but is outside Redocly's published pin.
This is explicitly a scoped same-4.x security override, not publisher range approval.
Within the authorized parent-scoped remediation, qualify compatibility by the unchanged
parent's real schema/API/bundle operations and actual repository generator. These pass
on old, clean candidate and active candidate graphs; no source incompatibility found.
The resolver records rangeSatisfied=false for Redocly and only permits this exact
qualified parent/declared/selected combination. No general range bypass is introduced.
The exact project-qualified Redocly1.34.14 -> js-yaml4.3.2 override is accepted
by CG-A34E11-JSYAML-20260924-01-R1. This is neither publisher/range approval
nor a blanket pin bypass; consumer/generator qualification remains mandatory.

Ordinary targeted transitive update in isolation did not change the lock hash.
Two version-scoped parent overrides select the single js-yaml4.3.2 installation.
Exactly one selected version changes; argparse2.0.1, both parents, workspace importers
and separate yaml2.9.1 remain unchanged. No unused root parser, broad update or5.x.

Official registry tarball https://registry.npmjs.org/js-yaml/-/js-yaml-4.3.2.tgz, 227545 bytes,
SHA256 c7b241d2224cf9253ff53854aa4cee87da91bd889c4d0fa3a3ffd1041ecee5b1. Full source URL/retrieval time/SRI/license/API/engine
metadata included. MIT; engine evidence uses the actual manifest, not an invented floor.
Published old/new js-yaml and both parent regular files match old/active/clean installs.
Lock integrity matches authenticated archives. No lifecycle scripts during inspection.

## Actual callers and schemas

Current eslint.config.js uses flat config; no legacy YAML config path is established
for normal project linting. Legacy.loadConfigFile and ConfigArrayFactory are separately
exercised with trusted owned .eslintrc.yaml, normalized rules and malformed diagnostics.
That parent uses yaml.load with default schema; extensionless legacy config strips
comments before load. The latter separate extensionless path is source-traced, not a
separate end-to-end fixture. Normal real-config TSX lint smoke passes without switching
application config or executing arbitrary plugins from YAML.

Redocly extends JSON_SCHEMA with implicit merge and explicit binary/omap/pairs/set;
timestamps intentionally remain strings. Its parseYaml/stringifyYaml, document-error
wrapper and bundle/local reference resolution are exercised. Synthetic OpenAPI schema
values, required fields, Unicode, file dependencies and diagnostics have independent
expected values. Actual openapi-typescript regeneration matches checked-in schema.d.ts.
Repository OpenAPI parses under unchanged new default limits; no raised/disabled safety
options. No remote refs or real credentials are used by synthetic tests.
loadAll is an exported-library control, not a claimed actual parent call. yaml used by
the dependency scanner is a separate package. No Go parser or business source changes.

## Tests and exact inference limits

30 supervised cases:13 core cases through each actual parent plus4consumer cases.
E11-REPORT-01 correction: before-tests.json is18pass/12fail; before-final.json
is17pass/13fail, including one unrelated missing flat ESLint configuration fixture.
The final run must not be called18/12. Original logs remain unchanged; no new replay.
Fixed active and frozen:30/30. The12 dependency-focused failures
repeat six boundaries through two paths: merge budget, empty-source budget, omap source,
limit defaults/source charges, depth default and merge-work default. They are not12
vulnerabilities. !!omap finite correctness passes old/new; its complexity repair is
source-supported own-property membership/defineProperty, not timing/OOM proof or Set.

Tiny configured-budget tests use3, plus below-budget8 positive control. Separate145-node
merge chain tests default10000 rejection (input below16KiB), and105 nested brackets test
default100. No -1/Infinity/raised-budget workaround. Rejection does not return a partial
object; file bytes remain equal and a subsequent independent parse succeeds. Schemas,
structured scalars, aliases, merge precedence, ordered-map reserved keys/duplicates,
dump/load and document/error behavior retain independent expected values.

Each security child:5s,192MiB V8 heap,1024KiB stack,64KiB output,<=16KiB fixtures.
Trusted consumer children:60s. All children reaped; tiny owned nonsymlink fixtures removed.
No exhaustive YAML resource-safety, internal memory bound or deployed exploit claim.
No production untrusted YAML endpoint was established: these are lint/build/generator paths.

## Security and preservation

Fresh before20raw/18actionable/29report-only -> after17raw/15actionable/28report-only.
Reviewed2 and exceptions0 unchanged. Removed High GHSA-52cp-r559-cp3m,
GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh; additionally the existing Moderate
GHSA-h67p-54hq-rp68 disappears. Raw advisory evidence retained; no extra alias counted
as a new exploit. No new/changed unrelated normalized record. Complete js-yaml identity,
argparse edge, both parents and separate yaml remain in inventory/CycloneDX/licenses/OSV.
Preserved Browserslist15, PostCSS15, NanoID16, brace20, XML10, tar6, vendor22;
policy19/applicability16 pass. Full quality:349application/package passes, one existing
optional Backoffice replay skipped; all established types/builds/schema drift pass.
Thresholds, empty exceptions, exact SheetJS bytes/provenance/two assessments and expiry
2026-10-23 unchanged. Chi/rgbcolor/OpenPGP/password/A14 and all other work remain separate.

## YJ acceptance matrix

| ID | Evidence |
|---|---|
| YJ01 | entry.json, parent-context resolution and staged classification |
| YJ02 | consumer-inventory.json; exact Redocly pin deviation above; actual schemas/options |
| YJ03 | official archives/metadata/advisories + installed-provenance.json |
| YJ04 | one changed version, two scoped overrides, no supporting change/importer drift |
| YJ05 | clean frozen install resolves4.3.2 from both parent contexts,30/30 |
| YJ06 | real Legacy loader/factory + separate flat ESLint smoke |
| YJ07 | real Redocly bundle/local ref/diagnostics; actual API gen-check unchanged |
| YJ08 | independent core controls through both parent contexts |
| YJ09 | tiny configured chain rejects; positive control and original bytes retained |
| YJ10 | four empty-source visits exceed small budget; old ignores it |
| YJ11 |27-key finite omap correctness/reserved keys; source-supported complexity only |
| YJ12 | default depth/merge proof, atomic failure/subsequent load, bounded cleanup |
| YJ13 | three High + one Moderate IDs removed; full raw/assessed inventory retained |
| YJ14 | mandatory30-case harness plus all prior quality/security tests pass |
| YJ15 | hosted same-SHA verification passes below |
| YJ16 | explicit staged hashes/tree, trigger/secret scan, current packet/manifest |

## Residuals

No independent publisher assurance for Redocly's exact-pin replacement: compatibility
is demonstrated for these real consumers/current schema and bounded cases, not all
possible configurations. Full repository lint is not claimed; real-config synthetic
smoke and established quality are distinct. WindowsNode24 local proof is distinct
from hostedNode22. Prior denied installation-copy deletions/stopped database cleanup
untouched; two new isolated install copies retained without deletion. No signing,
deployment, OTA, live data, business policy or release gate change.

## Final A34e11 hosted proof — 2026-09-24

Source `7d2ab470fa4edfa78c9ee8f3c435587590681e81`, tree `72682d1e8f74a14891e93360b8dfab762e961bda`, audit/hosted-proof-20260922.
Quality/backend/PostgreSQL/browser succeed on this exact SHA. HostedNode22 passes
30 js-yaml +15 Browserslist +15 PostCSS +16 NanoID and prior accepted checks.
Backend generated drift/vet/gofmt/build/race passes. DockerPostgreSQL18.3/race:
6 fixtures, 142 named passes, zero skips, verified identity/cleanup.
Chromium26/26, zero skips, clean network/owned processes/ports. Fresh security
completes RED: 17 raw / 15 actionable /28report-only/2reviewed/0exceptions.
Source input hashes match commit; hosted normalized findings equal local. Removed
three High and one Moderate js-yaml IDs; no new/changed unrelated record.
A34e11 locally/hosted verified, ChatGPT review pending. A34e10 accepted; E9-REPORT-01
closed as corrected evidence only.28accepted milestones/same11findings;all44parents
retained,A31alone resolved. A34/T29,A38/T33 and every release gate stay open.
Post-proof docs are local reporting after-images, not another executable revision.
Previously denied cleanup targets untouched; two new install copies retained.
No signing, deployment, OTA, live data or business policy change.

| Workflow | Run | Result |
|---|---|---|
| backend | [35953693676](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693676) | success |
| Mandatory PostgreSQL integration | [35953693549](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693549) | success |
| dependency-security | [35953693547](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693547) | failure |
| JS/TS Quality | [35953693570](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693570) | success |
| Mandatory Chromium browser gate | [35953693545](https://github.com/Epheyy/mandalika-pos/actions/runs/35953693545) | success |
