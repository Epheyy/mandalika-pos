-- A shift_open that arrived through the sync batch with a negative opening cash is accepted as
-- sent (a queued offline shift is never dropped; owner 2026-11-08: negative opening cash makes no
-- sense, so head office reviews it). Flag-only, like orders.stock_warning / tender_warning.
-- Additive: the previous revision ignores the column. The UPDATE flags shifts that already landed
-- with a negative opening cash (idempotent).
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS starting_cash_warning boolean NOT NULL DEFAULT false;
UPDATE shifts SET starting_cash_warning = true WHERE starting_cash < 0 AND NOT starting_cash_warning;
