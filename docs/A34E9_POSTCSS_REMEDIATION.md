# A34e9 PostCSS previous-source-map remediation

Packet A34E9-POSTCSS-20260923-01; AUTH-MANDALIKA-20260919-01.
Entry4cd7f89d857d64b0ae265605c9a25d39185522ac, audit/hosted-proof-20260922.
CG-A34E8-NANOID-20260923-01-R1 scoped accepts A34e8:26milestones/same11findings.
All44parents remain;A31alone resolved. A34/T29,A38/T33 and release gates open.
A34e9 implemented and locally verified; hosted proof and ChatGPT review pending.

## Compatible graph and real consumer

Vite8.0.13 declares PostCSS^8.5.14. The actual single selected PostCSS moves8.5.14
->8.5.23. It declares Nano ID^3.3.16; the accepted3.3.18 remains selected. Ordinary
pnpm9 targeted indirect update in a copy made no lock change. Exact Vite-parent
PostCSS override and new PostCSS-parent Nano ID override reproduce the graph.
Old version-bound Nano ID override is replaced, not left ineffective. No other
selected package or workspace importer changes. All PostCSS child versions match.
No unused root dependency, major/platform update, source-map disabling or unsafeMap.

The Nano ID harness now uses a shared real-consumer resolver: POS/Backoffice Vite,
Vitest and Tailwind Vite entry chains, six per installation. Every chain checks
parent ranges and selected identities; multiple physical selected copies fail closed
until separately qualified. It never discovers the first leftover .pnpm cache entry.
All16 accepted Nano ID worker assertions are byte-identical, retained in quality,
and pass on active/clean contexts. No library or business identifier behavior changed.

Installed Vite runPostCSS passes from/to=removeDirectQuery(id), and generated map
options inline:false/annotation:false/sourcesContent:true when maps are enabled.
Otherwise it does not force map:false. Project react/Tailwind configs add no custom
PostCSS/unsafeMap/previous-map options. This is a build/dev CSS path; no deployed
untrusted-CSS processor or live exploit is established. Both real app builds pass.

## Official provenance and intended behavior

Official https://registry.npmjs.org/postcss/8.5.23 and versioned tarball recorded.
SHA256:d2cf324ff10baf8c34e1c79309bf2bfe15ee9b6e957f665737b9a9604c0744f1. Bytes:51391; MIT, Node^10||^12||>=14.
Timestamp, SHA512/lock integrity, license/exports and all55published-file hashes are
bundled. Active/clean candidate and authentic old installation match official bytes.
Tagged8.5.23 previous-map.js equals registry source. Candidate is minimum covering
High GHSA-r28c-9q8g-f849 (8.5.18) and Moderate GHSA-fxqj-rqcc-2cmp (8.5.23).
Publisher intermediate changes include AST/position/comment formatting/performance
fixes; exact changelog and file-hash delta included. No claim that every upstream
edge case is exhaustively qualified; normal CSS/diagnostics/builds are exercised.

Automatic external maps require a CSS base and remain lexically within its folder.
Rejected maps are ignored, not required to throw. Same/nested-directory and inline
maps remain; explicit trusted map.prev object/function may intentionally read beyond
the CSS directory. No symlink/global filesystem/remote URL/CSS sanitization claim.
unsafeMap exists upstream but is never enabled by this change or these fixtures.

## Fifteen bounded cases

Same/nested directory maps; relative traversal; absolute and relative no-from;
non-map suffix,missing/invalid map;map:false;inline;explicit object/trusted path;
prev:false;Unicode/comment/custom-property/at-rule/diagnostic/plugin;real Vite build.
Corrected identical before/after:12pass/3fail before;15/15 fixed and clean.
All3old cases read the owned sibling map twice (Input+process), load its map and
propagate SYNTHETIC_OUTSIDE. Fixed performs zero named reads and no propagation.
The passthrough observer records actual fs reads without blocking/faking results.
Only owned base/outside synthetic files are targets; no real secret/system file.

Initial fixture assumptions were corrected for base64 inline map output, repeated
Vite plugin passes and Windows slash-normalized source identity. Initial logs remain;
these fixture errors are not dependency defects. Final identical harness confirms
3targeted old failures only. CSS output and mapping controls retain exact assertions.

Each case is a supervised child:5s deadline (10s minimal Vite),96MiB V8 heap,
512KiB stack,64KiB output;owned fixture <=32KiB (actual small counts in logs).
Children reaped; every uniquely owned nonsymlink temp tree removed and absence
checked. These are not OS RSS/disk quotas. No large/network/decompression probes.
Four historically denied installation-copy removals remain untouched. Prior A34e7/
A34e8 copies and two new A34e9 install copies retained without deletion attempt;
historical stopped DB cleanup untouched. No cleanup campaign or bypass.

## Security and gates

Fresh before23raw/21actionable/30report-only;after22raw/20actionable/29report-only.
Reviewed-not-affected2/riskexceptions0 unchanged. Exactly2PostCSS records removed:
GHSA-r28c-9q8g-f849 High blocker and GHSA-fxqj-rqcc-2cmp Moderate report-only.
This is one blocker removal, not two. No added/changed unrelated normalized finding.
Old evidence still blocks unchanged policy CLI (1blocker+1report). PostCSS8.5.23 and
Nano ID3.3.18 retain inventory,CycloneDX,parent edges,license and OSVquery coverage.
Counts observed, never a hardcoded gate target. Raw and assessed evidence separate.

Exact SheetJS archive/provenance/two assessments/2026-10-23deadline,tar/XML/brace,
Nano ID,thresholds and empty exceptions preserved. Chi/rgbcolor/OpenPGP/password/A14,
concurrency/native/release and live operations remain out of scope. Local full quality
and policy checks plus same-SHA four hosted application passes and completedfresh
security assessment are required; red security due unrelated blockers is expected.
Local Go/DB need not repeat for this Node leaf; hosted Docker18.3/race remains mandatory.
