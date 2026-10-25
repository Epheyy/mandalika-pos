-- Inventory controls S1 (kartu stok): location-wide keyset paging by seq. The per-SKU history is
-- already served by stock_movements_loc_variant (0064); this one serves the location-wide list,
-- export and summary without a sort. The recorded index makes the window boundary of a date
-- range (lowest seq among a location's rows recorded in [t, t + a few minutes)) a bounded,
-- index-only range lookup instead of a walk over the location history.
--
-- Additive only: an index the previous revision ignores. Never renumber this file.
SET LOCAL lock_timeout = '5s';
CREATE INDEX stock_movements_loc_seq ON stock_movements (location_type, location_id, seq);
CREATE INDEX stock_movements_loc_recorded ON stock_movements (location_type, location_id, recorded_at, seq);
