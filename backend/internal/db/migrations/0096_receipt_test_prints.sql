-- 0096: receipt test-print relay (receipt designer, phase 4). The Backoffice posts an unsaved draft for one
-- outlet; that outlet's tablet fetches it on a "Tes Cetak" tap and prints it with a sample sale. One row per
-- outlet (a newer draft replaces the older one); the read side ignores rows older than 60 minutes. New table,
-- additive; it never feeds a sale or the sync pull.
SET LOCAL lock_timeout = '5s';

CREATE TABLE receipt_test_prints (
  outlet_id   uuid        PRIMARY KEY REFERENCES outlets (id) ON DELETE CASCADE,
  paper_width smallint    NOT NULL CHECK (paper_width IN (58, 80)),
  blocks      jsonb       NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
