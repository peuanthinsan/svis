-- Single-use dashboard download capabilities. Prepare/review this additive
-- migration before deployment; never apply it implicitly from an API request.
BEGIN;

CREATE TABLE IF NOT EXISTS export_download_tickets (
  token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fleet_ids TEXT[] NOT NULL DEFAULT '{}',
  date_start DATE,
  date_end DATE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (cardinality(fleet_ids) <= 100),
  CHECK (array_position(fleet_ids, NULL) IS NULL),
  CHECK (array_position(fleet_ids, '') IS NULL),
  CHECK (date_start IS NULL OR date_end IS NULL OR date_start <= date_end)
);

CREATE INDEX IF NOT EXISTS idx_export_download_tickets_owner_expiry
  ON export_download_tickets (user_id, company_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_export_download_tickets_expiry
  ON export_download_tickets (expires_at);

-- This is API-internal capability state. Do not grant browser/database clients
-- direct access. Issuance locks the matching user/company row, bounds outstanding
-- tickets, and clears that user's expired tickets. Redemption deletes atomically.
COMMIT;
