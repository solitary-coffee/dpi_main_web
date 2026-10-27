CREATE TABLE IF NOT EXISTS access_log_events (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    site TEXT NOT NULL,
    host TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    query_keys TEXT NOT NULL DEFAULT '[]',
    ip TEXT NOT NULL DEFAULT '',
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT NOT NULL DEFAULT '',
    referer TEXT NOT NULL DEFAULT '',
    cf_ray TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    colo TEXT NOT NULL DEFAULT '',
    request_bytes INTEGER,
    response_bytes INTEGER,
    content_type TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'cloudflare-worker'
);

CREATE INDEX IF NOT EXISTS access_log_events_received_idx
    ON access_log_events(received_at, id);

CREATE INDEX IF NOT EXISTS access_log_events_host_path_idx
    ON access_log_events(host, path, occurred_at DESC);

CREATE INDEX IF NOT EXISTS access_log_events_ip_idx
    ON access_log_events(ip, occurred_at DESC);
