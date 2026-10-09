# Offline ingress design and contract models

This directory is not deployable infrastructure or production middleware.
`INGRESS_PROPOSAL.json` always says proposed-not-applied and activation_ready=false.
The schema/checker tests design completeness, never cloud truth. No apply entrypoint
exists. See `../A34E15B_INGRESS_DESIGN.md` for unresolved G01–G07 and the conditional
IAP question. Do not copy the model's `QualifiedRoute` boolean into production.

From this directory, using existing Python (no third-party packages):

```text
python -B check_proposal.py INGRESS_PROPOSAL.json
python -B -m unittest -v test_proposal
```

For `model/`, use the existing qualified **Go 1.26.8 executable**, verify its version
and digest before any Go operation, set its bin directory first on PATH **for that
process only**, GOTOOLCHAIN=local and GOWORK=off. The exact executable, SHA256, owned
caches, commands, working directories, deadlines and results are in the packet.
Do not change global Go settings, disable checksum trust or install a toolchain for
these models. With that environment in `model/`:

```text
go test -mod=readonly -count=1 -timeout=45s -json ./...
go vet -mod=readonly ./...
```

The enclosing supervisor uses a 120-second wall-clock limit. Existing qualified
module/build caches were reused. The local replace reads the unchanged repository
backend; this nested module is outside application builds and ordinary backend ./...
tests. It uses the already-qualified miniredis 2.39.0 fixture dependency, not a new
active application dependency. Its module/sum files and the active source hashes are
supplied separately. It is a manual design test lane, not a new hosted gate.

Tests use httptest recorders, documentation IP ranges and inert business terminals.
Miniredis opens only 127.0.0.1 with bounded actual go-redis calls and verified listener
cleanup. Auth/outlet/permission and Cache calls are real repository implementations;
edge replacement, route qualification and context-based limiter/key selection are
models. No Cloud Run request, Google token validation, real login or financial/database
mutation happens. TCP platform startup remains a documented contract, not a cloud
probe measured here. Windows/non-race results are not Linux/hosted evidence.

The checker implements only the type/const/object/array subset used by its checked-in
schema. Its real CLI tests reject unsafe design counterexamples and still cannot
produce an activation-ready result. Temporary negative JSON files are created in an
owned, resolved, prefix-checked temporary directory; no existing denied cleanup target
is touched. Original failed fixture evidence remains outside this directory in the
review packet.
