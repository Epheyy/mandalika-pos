# A34e2 — x/crypto remediation scope

Scope ID: **A34E2-XCRYPTO-20260922-01**

## Objective

Upgrade the direct runtime dependency `golang.org/x/crypto` from `v0.46.0` to the
minimum compatible version that clears all currently fixed x/crypto advisories in the
A34e1 normalized baseline.

Current evidence shows the highest required fixed version among those records is
**v0.56.0**.

Do not require v0.57.0 merely because it is newer; use the minimum compatible fixed version
unless module selection or newly refreshed advisory evidence proves another version is
needed.

## Preserve password compatibility

The application imports `golang.org/x/crypto/argon2` for Argon2id password hashing.

Before changing the module, capture at least one deterministic pre-upgrade encoded
Argon2id fixture generated with the application's current format. After the update prove:

- the pre-upgrade encoded hash still verifies with the correct password;
- it rejects the wrong password;
- new hashes verify;
- malformed-hash behavior remains unchanged;
- stored encoding format/parameters are unchanged unless a separately reviewed security
  change is required.

Do not bulk-rehash users or modify stored credentials.

## OpenPGP no-fixed advisory

`GO-2026-5932` applies to `golang.org/x/crypto/openpgp` and related OpenPGP packages for all
versions with no known fixed version.

The application password code imports `argon2`, not OpenPGP.

Therefore:
- keep GO-2026-5932 visible if the current policy still classifies the module-level record
  as blocking;
- do not pretend upgrading x/crypto "fixes" it;
- do not introduce an exception or weaken the policy in this slice;
- capture current import/reachability evidence so a later policy/reachability slice can
  decide how module-present-but-unimported no-fixed packages should be classified.

## Non-goals

Do not modify:
- chi/RealIP;
- SheetJS/xlsx;
- rgbcolor license state;
- kin-openapi;
- dependency-security policy/thresholds/exceptions;
- business logic, migrations or API contracts;
- deployment, Android release or live data.
