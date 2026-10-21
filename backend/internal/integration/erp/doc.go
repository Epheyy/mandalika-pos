// Package erp is the POS side of the ERP (erp-flamboyan) integration: the
// catalog pull, the stock-document outbox relay and the HTTP client wrapper
// around the generated erpapi package.
//
// The ERP is the catalog master and the stock-ledger source of truth. The
// contract is docs/integration/2026-10-21-serah-terima-erp-pos.md (POST
// /api/integration/v1/stock-documents, §4.3) plus the ERP's read API snapshot
// in api/erp/openapi.v1.json.
//
// Import tier: adapter. It may import db and ledger plus leaves; sync and
// handlers may import it (see internal/archtest once R6 lands).
package erp
