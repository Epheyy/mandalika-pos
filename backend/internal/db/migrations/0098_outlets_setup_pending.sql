-- 0098: outlets.setup_pending marks an outlet created from the ERP that nobody has set up yet. The first
-- activation (write.UpdateOutlet with is_active=true) clears it; nothing sets it again. Additive: existing
-- rows default to false.
SET LOCAL lock_timeout = '5s';

ALTER TABLE outlets ADD COLUMN setup_pending boolean NOT NULL DEFAULT false;
