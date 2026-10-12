# X03 / X05 / X06 Facts (read-only collection, 2026-10-10)

Collected with read-only commands only. No enable, create, update, deploy, or trigger calls were made.

Notes on side effects:
- `gcloud beta` was auto-installed as an SDK component during the domain-mappings call. This is an SDK change only, not a project change.
- `gcloud scheduler jobs list` prompted to enable the Cloud Scheduler API. stdin was closed, so it was NOT enabled. The call failed with SERVICE_DISABLED.

## X03 - current routing and access

### Cloud Run service `mandalika-pos` (asia-southeast2)
- Ingress: `all` (annotation `run.googleapis.com/ingress: all`, status `all`).
- URLs: `https://mandalika-pos-538849926142.asia-southeast2.run.app` and `https://mandalika-pos-rqbgovtm2a-et.a.run.app`.
- Generation 77. Latest created and latest ready revision: `mandalika-pos-00077-b45`.
- Traffic: 100% to latestRevision (`mandalika-pos-00077-b45`).
- Service account: `538849926142-compute@developer.gserviceaccount.com` (default Compute SA).
- Container: port 8080, cpu 1000m, memory 512Mi, maxScale 20, containerConcurrency 80, timeout 300s.
- Startup probe: TCP 8080, failureThreshold 1, periodSeconds 240, timeout 240s.
- Env var NAMES present (values not recorded): ENV, CORS_ORIGINS, SEED_ADMIN_EMAIL, SEED_ADMIN_NAME, CLOUDINARY_CLOUD_NAME, RATE_LIMIT_RPS, RATE_LIMIT_BURST, JWT_REFRESH_TTL_HOURS. Secret-backed vars include DATABASE_URL, REDIS_URL, SENTRY_DSN, and others (secretKeyRef). The describe output was filtered, so this list may be incomplete.
- Deployed from Cloud Build source (`cloud-run-source-deploy/mandalika-pos`). Created 2026-05-18. Last Ready 2026-07-09.
- Ready conditions: all True.

### Invoker IAM (service level)
- `roles/run.invoker` bound to `allUsers`. The service is publicly invokable.

### Project IAM (`mandalika-pos`)
- `user:reffyvee@gmail.com`: roles/owner
- `538849926142-compute@developer.gserviceaccount.com`: roles/editor, roles/secretmanager.secretAccessor
- `538849926142@cloudbuild.gserviceaccount.com`: roles/cloudbuild.builds.builder
- `firebase-adminsdk-fbsvc@mandalika-pos.iam.gserviceaccount.com`: roles/firebaseauth.admin, roles/iam.serviceAccountTokenCreator, roles/firebase.sdkAdminServiceAgent
- Google service agents: artifactregistry, cloudbuild, containerregistry, firebase management, firebase rules, firestore, serverless-robot-prod (run.serviceAgent)

### Domain mappings
- `gcloud beta run domain-mappings list --region asia-southeast2` showed no mappings in the output. The output was dominated by the component install banner, so this is "none seen" rather than confirmed empty.

### Enabled services (filtered)
- Enabled: run.googleapis.com, logging.googleapis.com, monitoring.googleapis.com, runtimeconfig.googleapis.com
- NOT enabled (absent from the filtered list): compute.googleapis.com, iap.googleapis.com, vpcaccess.googleapis.com, cloudscheduler.googleapis.com

### Other Cloud Run services
- `gcloud run services list` (default region) shows only `mandalika-pos` in asia-southeast2.
- The all-regions list failed (`--region=-` produced an invalid endpoint override error). Not retried with other regions. Other-region services: undetermined.

## X05 - release ledger (APK and OTA)

### GitHub Actions: `android-release.yml` (60 most recent runs)
- All runs are `workflow_dispatch` on branch `prod-hardening`.
- Oldest run in the window: 2026-05-18. Newest: run 28996622264, 2026-07-09T05:36:27Z, success, headSha 6093c6d4db1a66c4e8b902826449f627a857d4dd.
- Failures (3): run 26027024804 (2026-05-18), run 26115120411 (2026-05-19), run 26441461112 (2026-05-26).
- No runs since 2026-07-09, about 3 months before today (2026-10-10).

Last 5 successful runs (newest first):

| run id | created (UTC) | headSha (short) |
|---|---|---|
| 28996622264 | 2026-07-09 05:36 | 6093c6d |
| 28856389582 | 2026-07-07 09:35 | 17126e5 |
| 28847084027 | 2026-07-07 06:45 | 1e16465 |
| 28714921434 | 2026-07-04 18:01 | 1530623 |
| 28298448261 | 2026-06-27 18:48 | 1485f8a |

### Artifacts for those runs
- `gh api .../runs/<id>/artifacts` returned `total_count: 0` for all 5 runs checked.
- The workflow uploads `mandalika-pos-<versionName>-build<versionCode>-<release_type>-<sha7>` (APK plus `release-manifest.json`; `gh run download <run-id>` unpacks into a directory with that name) via `actions/upload-artifact@v4`. Zero artifacts means expired, deleted, or cleaned up. Expiry dates are not exposed for removed artifacts.
- Conclusion: the APKs are not available from Actions.

### GitHub Releases
- `gh release list --repo Epheyy/mandalika-pos` returned no output. No releases are published.

### OTA bucket `gs://mandalika-pos-ota`
- `gcloud storage ls -l gs://mandalika-pos-ota/`: TOTAL 0 objects, 0 bytes.
- The recursive listing is empty. No OTA zips are present.
- `scripts/ota-release.sh` uploads to `gs://mandalika-pos-ota/pos/android/<VERSION>.zip`, with public URL `https://storage.googleapis.com/mandalika-pos-ota/pos/android/<VERSION>.zip`. The bucket is empty, so either no OTA release has been run or the uploads were removed.

### Where OTA versions are recorded
- DB table: `ota_releases`, created by `backend/internal/db/migrations/0044_ota_releases.sql`.
  Columns: id (uuid), platform, version, url, checksum, size (bigint), created_by (FK to users), created_at. Index on (platform, created_at DESC).
- Backend handlers: `backend/internal/handlers/ota.go`. Routes: `POST /ota/check` (public, server.go:94) and `POST /ota/publish` (admin, server.go:268).
- ota-release.sh reads the current version via `/ota/check` and publishes via the admin endpoint.
- The database was NOT queried.

## X06 - who calls the backend

### Cloud Run request logs (30 days, `httpRequest.requestUrl` set)
- Entries returned: 604 (limit was 2000, not reached).
- Time range covered: 2026-09-11T07:05:10Z to 2026-10-09T10:37:53Z.
- Distinct remote IPs: 1.

Top request paths (IDs stripped, query strings removed):

| path | count |
|---|---|
| /api/v1/sync/inbound-transfers | 272 |
| /api/v1/sync/version | 272 |
| /api/v1/auth/refresh | 12 |
| /api/v1/auth/login | 10 |
| /api/v1/sync/customers/lookup | 10 |
| /api/v1/sync/loyalty-preview | 7 |
| /api/v1/shifts/current | 6 |
| /api/v1/sync/outlet-transfers | 5 |
| /api/v1/sync/pull | 4 |
| /api/v1/shifts | 2 |
| /api/v1/orders | 2 |
| /api/v1/cash-flows | 2 |

User-agent groups:
- Android device user agent (Mozilla/5.0 Linux; Android 16): 596. Consistent with the POS Android app (Capacitor/WebView). Not separately confirmed.
- Windows desktop browser (Mozilla/5.0 Windows NT 10.0): 8. Likely a backoffice browser.
- curl/Go/script, Google health checks, and uptime monitors: 0 observed.

### Uptime checks
- `gcloud monitoring uptime list-configs`: 0 items. The Monitoring API responded.

### Cloud Scheduler
- Not usable: cloudscheduler.googleapis.com is not enabled. Error: SERVICE_DISABLED / PERMISSION_DENIED.

### GitHub workflows calling the backend
- `.github/workflows/android-release.yml` line 9: default input `https://mandalika-pos-538849926142.asia-southeast2.run.app`, used by the release job.
- `.github/workflows/react-doctor.yml` matched the search but no backend call was found. Not a confirmed backend caller.
- No smoke-test or health-check job calling the deployed backend was found.

## Failed or undetermined
- Cloud Run services in other regions: undetermined (all-regions list syntax failed).
- Domain mappings: none seen, but the output was obscured by the gcloud beta install banner. Re-run to confirm.
- Cloud Scheduler jobs: not listable (API disabled).
- Artifact expiry dates: not returned (artifacts are gone).
- Full env var set on the service: partially filtered, names only.
- Database not queried (per instructions).
