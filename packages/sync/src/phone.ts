// The phone normalizer lives in @mandalika/types (shared with the backoffice) and is re-exported here
// for the POS. Twins: backend/internal/phone/phone.go and the SQL normalize_phone() (migration 0080).
// Shared vectors: __fixtures__/phone-vectors.json, asserted in phone.test.ts.
export { normalizePhone, PHONE_MIN_DIGITS, PHONE_MAX_DIGITS } from '@mandalika/types'
