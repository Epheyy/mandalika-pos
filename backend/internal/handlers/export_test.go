package handlers

// GatePool exposes the PostgreSQL gate fixture to the external handlers_test
// package (AU gate), which must import internal/server (an internal test would
// create an import cycle).
var GatePool = gatePool

// ExpireErrorLogSweep makes the hourly POST-triggered error_logs sweep due again.
func ExpireErrorLogSweep(h *Handlers) { h.lastErrorLogSweep.Store(0) }
