-- Inventory controls S1 (kartu stok): location-wide keyset paging by seq. The per-SKU history is
-- already served by stock_movements_loc_variant (0064); this one serves the location-wide list,
-- export and summary without a sort.
--
-- Additive only: an index the previous revision ignores. Never renumber this file.
SET LOCAL lock_timeout = '5s';
CREATE INDEX stock_movements_loc_seq ON stock_movements (location_type, location_id, seq);
