CREATE TABLE IF NOT EXISTS reuse_oauth_states (
    state_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reuse_sessions (
    token_hash TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    discord_avatar TEXT,
    guilds_json TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS reuse_sessions_expiry_idx
    ON reuse_sessions(expires_at);

CREATE TABLE IF NOT EXISTS reuse_applications (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    revision INTEGER NOT NULL DEFAULT 1,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    guild_name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    channel_type INTEGER NOT NULL,
    delivery_types TEXT NOT NULL,
    server_public TEXT NOT NULL,
    channel_visibility TEXT NOT NULL,
    announcement_automated TEXT NOT NULL,
    reuse_method TEXT NOT NULL,
    reuse_method_other TEXT,
    contact_email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    destination_url TEXT,
    notes TEXT,
    admin_message TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resubmitted_at TEXT,
    manage_token_hash TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS reuse_applications_status_idx
    ON reuse_applications(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS reuse_applications_discord_user_idx
    ON reuse_applications(discord_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS reuse_application_events (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reuse_application_events_application_idx
    ON reuse_application_events(application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reuse_rate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL,
    event_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS reuse_rate_events_lookup_idx
    ON reuse_rate_events(key_hash, event_type, created_at);
