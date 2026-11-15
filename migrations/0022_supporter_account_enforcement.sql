ALTER TABLE supporter_accounts ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
 CHECK(account_status IN ('active','suspended'));
ALTER TABLE supporter_accounts ADD COLUMN status_reason TEXT;
ALTER TABLE supporter_accounts ADD COLUMN status_updated_at TEXT;
ALTER TABLE supporter_accounts ADD COLUMN status_updated_by TEXT;
ALTER TABLE supporter_accounts ADD COLUMN status_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_supporter_accounts_status_request
 ON supporter_accounts(status_request_id)
 WHERE status_request_id IS NOT NULL;
