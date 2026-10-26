-- Review and apply to the serving database before deploying owner-aware code.
-- Additive access grants: this migration never changes vehicle fleet membership.
BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('driver', 'supervisor', 'admin', 'vehicle_owner'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_master_company_id ON vehicle_master(company_id, id);

CREATE TABLE IF NOT EXISTS user_vehicle_access (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  vehicle_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, user_id, vehicle_id),
  FOREIGN KEY (company_id, user_id) REFERENCES users(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, vehicle_id) REFERENCES vehicle_master(company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_vehicle_access_vehicle
  ON user_vehicle_access(company_id, vehicle_id);

ALTER TABLE user_vehicle_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_access_read ON user_vehicle_access;
CREATE POLICY owner_access_read ON user_vehicle_access FOR SELECT USING (
  company_id::text = current_setting('app.user_company_id', true)
  AND (current_setting('app.user_role', true) = 'admin'
    OR (current_setting('app.user_role', true) = 'vehicle_owner'
      AND user_id::text = current_setting('app.user_id', true)))
);
DROP POLICY IF EXISTS owner_access_admin ON user_vehicle_access;
CREATE POLICY owner_access_admin ON user_vehicle_access FOR ALL USING (
  company_id::text = current_setting('app.user_company_id', true)
  AND current_setting('app.user_role', true) = 'admin'
) WITH CHECK (
  company_id::text = current_setting('app.user_company_id', true)
  AND current_setting('app.user_role', true) = 'admin'
);

DROP POLICY IF EXISTS vehicle_read ON vehicle_master;
CREATE POLICY vehicle_read ON vehicle_master FOR SELECT USING (
  company_id::text = current_setting('app.user_company_id', true)
  AND (current_setting('app.user_role', true) = 'admin'
    OR (current_setting('app.user_role', true) IN ('driver', 'supervisor')
      AND fleet_id = current_setting('app.user_fleet_id', true))
    OR (current_setting('app.user_role', true) = 'vehicle_owner' AND EXISTS (
      SELECT 1 FROM user_vehicle_access a WHERE a.company_id = vehicle_master.company_id
        AND a.vehicle_id = vehicle_master.id AND a.user_id::text = current_setting('app.user_id', true)
    )))
);

DROP POLICY IF EXISTS inspection_read ON inspection_logs;
CREATE POLICY inspection_read ON inspection_logs FOR SELECT USING (
  company_id::text = current_setting('app.user_company_id', true)
  AND (current_setting('app.user_role', true) = 'admin'
    OR (current_setting('app.user_role', true) IN ('driver', 'supervisor')
      AND fleet_id = current_setting('app.user_fleet_id', true))
    OR (current_setting('app.user_role', true) = 'vehicle_owner' AND EXISTS (
      SELECT 1 FROM user_vehicle_access a WHERE a.company_id = inspection_logs.company_id
        AND a.vehicle_id = inspection_logs.vehicle_id AND a.user_id::text = current_setting('app.user_id', true)
    )))
);

DROP POLICY IF EXISTS inspection_insert ON inspection_logs;
CREATE POLICY inspection_insert ON inspection_logs FOR INSERT WITH CHECK (
  company_id::text = current_setting('app.user_company_id', true)
  AND current_setting('app.user_role', true) IN ('driver', 'supervisor', 'admin')
  AND fleet_id = current_setting('app.user_fleet_id', true)
);
DROP POLICY IF EXISTS results_insert ON inspection_results;
CREATE POLICY results_insert ON inspection_results FOR INSERT WITH CHECK (
  current_setting('app.user_role', true) IN ('driver', 'supervisor', 'admin')
  AND EXISTS (SELECT 1 FROM inspection_logs WHERE inspection_logs.id = inspection_results.inspection_id)
);

DROP POLICY IF EXISTS issues_read ON issue_reports;
CREATE POLICY issues_read ON issue_reports FOR SELECT USING (
  company_id::text = current_setting('app.user_company_id', true)
  AND (current_setting('app.user_role', true) = 'admin'
    OR (current_setting('app.user_role', true) IN ('driver', 'supervisor')
      AND fleet_id = current_setting('app.user_fleet_id', true))
    OR (current_setting('app.user_role', true) = 'vehicle_owner' AND EXISTS (
      SELECT 1 FROM user_vehicle_access a WHERE a.company_id = issue_reports.company_id
        AND a.vehicle_id = issue_reports.vehicle_id AND a.user_id::text = current_setting('app.user_id', true)
    )))
);
DROP POLICY IF EXISTS issues_insert ON issue_reports;
CREATE POLICY issues_insert ON issue_reports FOR INSERT WITH CHECK (
  company_id::text = current_setting('app.user_company_id', true)
  AND current_setting('app.user_role', true) IN ('driver', 'supervisor', 'admin')
  AND fleet_id = current_setting('app.user_fleet_id', true)
);
DROP POLICY IF EXISTS issues_update ON issue_reports;
CREATE POLICY issues_update ON issue_reports FOR UPDATE USING (
  company_id::text = current_setting('app.user_company_id', true)
  AND (current_setting('app.user_role', true) = 'admin'
    OR (current_setting('app.user_role', true) IN ('driver', 'supervisor')
      AND fleet_id = current_setting('app.user_fleet_id', true)))
) WITH CHECK (
  company_id::text = current_setting('app.user_company_id', true)
  AND (current_setting('app.user_role', true) = 'admin'
    OR (current_setting('app.user_role', true) IN ('driver', 'supervisor')
      AND fleet_id = current_setting('app.user_fleet_id', true)))
);

-- NULL preserves existing fleet-scoped tickets; '{}' means zero vehicles.
ALTER TABLE export_download_tickets ADD COLUMN IF NOT EXISTS vehicle_ids UUID[];
ALTER TABLE export_download_tickets DROP CONSTRAINT IF EXISTS export_ticket_vehicle_ids_valid;
ALTER TABLE export_download_tickets ADD CONSTRAINT export_ticket_vehicle_ids_valid
  CHECK (vehicle_ids IS NULL OR array_position(vehicle_ids, NULL) IS NULL);

COMMIT;
