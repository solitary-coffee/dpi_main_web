CREATE TABLE IF NOT EXISTS survey_participants (
    discord_user_id TEXT PRIMARY KEY,
    participant_uuid TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS survey_access_tokens (
    token_hash TEXT PRIMARY KEY,
    participant_uuid TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    response_id TEXT
);

CREATE INDEX IF NOT EXISTS survey_access_tokens_participant_idx
    ON survey_access_tokens(participant_uuid, expires_at DESC);

CREATE TABLE IF NOT EXISTS survey_responses (
    participant_uuid TEXT PRIMARY KEY,
    response_id TEXT NOT NULL UNIQUE,
    edit_url_ciphertext TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
