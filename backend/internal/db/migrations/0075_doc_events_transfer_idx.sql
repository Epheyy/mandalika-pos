SET LOCAL lock_timeout = '5s';
-- Kartu stok shows the PB number of a transfer made from a Permintaan Barang by looking the
-- transfer id up in the requisition's fulfilled/refulfilled events; the read's predicate matches
-- this index exactly. Additive: a rollback just leaves the index unused.
CREATE INDEX inventory_doc_events_transfer ON inventory_doc_events ((data->>'transferId'))
  WHERE doc_type='requisition' AND action IN ('fulfilled','refulfilled');
