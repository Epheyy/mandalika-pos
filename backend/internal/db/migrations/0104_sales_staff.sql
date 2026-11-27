-- Tim Sales: a per-outlet list of sales staff (people credited on orders), separate from
-- login users. A row may optionally point at a user (user_id), e.g. migrated past salespeople.
CREATE TABLE sales_staff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  active     boolean NOT NULL DEFAULT true,
  user_id    uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE TABLE sales_staff_outlets (
  staff_id  uuid NOT NULL REFERENCES sales_staff(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, outlet_id)
);
CREATE INDEX idx_sales_staff_outlets_outlet ON sales_staff_outlets (outlet_id);

-- The statements between the markers are data-only and re-runnable by the integration test
-- (TestSalesStaffPostgres/migration); the migration runner executes the file as one script.
-- migrate:data-begin
-- Past salespeople come in INACTIVE so owners opt each one in.
INSERT INTO sales_staff (name, active, user_id)
SELECT COALESCE(
         NULLIF(btrim(left(btrim(u.display_name), 60)), ''),
         (SELECT NULLIF(btrim(left(btrim(o.salesman_name), 60)), '')
            FROM orders o
           WHERE o.salesman_id = u.id AND NULLIF(btrim(o.salesman_name), '') IS NOT NULL
           ORDER BY o.created_at DESC LIMIT 1),
         'Sales'), false, u.id
  FROM users u
 WHERE EXISTS (SELECT 1 FROM orders o WHERE o.salesman_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM sales_staff s WHERE s.user_id = u.id);
INSERT INTO sales_staff_outlets (staff_id, outlet_id)
SELECT DISTINCT s.id, o.outlet_id
  FROM sales_staff s JOIN orders o ON o.salesman_id = s.user_id
 WHERE o.outlet_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- One-time content-version bump of 'sales_staff' for EVERY outlet (same upsert as bumpVersionOutlets
-- in write/repo.go). Tablets pull only when their outlet's version moves, so without this they keep
-- the stored full users list and the new OTA would fall back to it.
INSERT INTO content_versions (outlet_id, version, data_manifest, updated_at)
SELECT id, 2, jsonb_build_object('sales_staff'::text, 1), now() FROM outlets
ON CONFLICT (outlet_id) DO UPDATE SET
  version = content_versions.version + 1,
  data_manifest = content_versions.data_manifest ||
    jsonb_build_object('sales_staff'::text, COALESCE((content_versions.data_manifest->>'sales_staff')::int, 0) + 1),
  updated_at = now();

-- Grants. No perm_version bump: the grant reaches a tablet at its next token refresh; revocation
-- stays instant through #138.
INSERT INTO user_permissions (user_id, permission)
  SELECT id, 'manage_sales_staff' FROM users WHERE role = 'manager'
  ON CONFLICT DO NOTHING;
INSERT INTO custom_role_permissions (role_id, permission)
  SELECT id, 'manage_sales_staff' FROM custom_roles WHERE name ~* '(manajer|manager)'
  ON CONFLICT DO NOTHING;
-- migrate:data-end
