-- A39: audit + replay record of every APPLIED CSV import (customers, products,
-- ingredients). Dry runs are never stored and raw file contents are never kept:
-- only the hash, the summary and a redacted copy of the report.
-- result is the report with personal values redacted (issue values and, for customer
-- imports, row keys are blank); it keeps counts, row numbers, codes and actions.
-- idempotency_key is UNIQUE so a retried commit replays the stored result instead
-- of writing twice.
CREATE TABLE IF NOT EXISTS import_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('customers','products','ingredients')),
  idempotency_key  text NOT NULL UNIQUE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  file_name        text,
  file_sha256      text NOT NULL,
  delimiter        text NOT NULL,
  total_rows       integer NOT NULL,
  summary          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied')),
  result           jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_runs_kind_created ON import_runs (kind, created_at DESC);
