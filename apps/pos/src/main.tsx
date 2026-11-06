// THROWAWAY PROBE BRANCH (probe/a9-glass), never merged. PROBE = true boots straight into the glass performance
// probe: no storage hydrate, no auth, no OTA, no sync, no network. The real boot lives in ./bootApp (moved
// verbatim) and is only loaded when PROBE is false, so none of its modules even evaluate in the probe.
const PROBE = true

if (PROBE) {
  void import('./probe/bootProbe')
} else {
  void import('./bootApp')
}
