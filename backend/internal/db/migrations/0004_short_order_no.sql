-- Shorter, global order numbers: MND-NNNNNN (6+ digit zero-padded).
-- A single global sequence keeps them unique across outlets/days/devices
-- (the order_number column is globally UNIQUE) while staying short.
CREATE SEQUENCE IF NOT EXISTS order_no_seq START 1;
