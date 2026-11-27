CREATE TABLE IF NOT EXISTS supporter_settings_backup_20261127 (
 discord_user_id TEXT PRIMARY KEY,
 settings_json TEXT NOT NULL,
 revision INTEGER NOT NULL,
 backed_up_at TEXT NOT NULL
);

INSERT OR IGNORE INTO supporter_settings_backup_20261127
 (discord_user_id, settings_json, revision, backed_up_at)
SELECT account.discord_user_id, account.settings_json, account.revision, CURRENT_TIMESTAMP
FROM supporter_accounts AS account
WHERE json_valid(account.settings_json)
 AND json_type(account.settings_json, '$.rules') = 'array'
 AND EXISTS (
  SELECT 1
  FROM json_each(account.settings_json, '$.rules') AS rule
  WHERE json_extract(rule.value, '$.detail') = 'flood-level'
   OR EXISTS (
    SELECT 1
    FROM json_each(rule.value, '$.conditions') AS condition
    WHERE json_extract(condition.value, '$.kind') = 'detail'
     AND json_extract(condition.value, '$.value') = 'flood-level'
   )
 );

UPDATE supporter_accounts AS account
SET settings_json = json_set(
 account.settings_json,
 '$.rules',
 json(COALESCE((
  SELECT json_group_array(json(
   CASE
    WHEN json_type(rule.value, '$.conditions') = 'array' THEN json_set(
     rule.value,
     '$.conditions',
     json(COALESCE((
      SELECT json_group_array(json(condition.value))
      FROM json_each(rule.value, '$.conditions') AS condition
      WHERE NOT (
       json_extract(condition.value, '$.kind') = 'detail'
       AND json_extract(condition.value, '$.value') = 'flood-level'
      )
     ), '[]'))
    )
    ELSE rule.value
   END
  ))
  FROM json_each(account.settings_json, '$.rules') AS rule
  WHERE COALESCE(json_extract(rule.value, '$.detail'), '') <> 'flood-level'
 ), '[]'))
),
revision = revision + 1
WHERE json_valid(account.settings_json)
 AND json_type(account.settings_json, '$.rules') = 'array'
 AND EXISTS (
  SELECT 1
  FROM json_each(account.settings_json, '$.rules') AS rule
  WHERE json_extract(rule.value, '$.detail') = 'flood-level'
   OR EXISTS (
    SELECT 1
    FROM json_each(rule.value, '$.conditions') AS condition
    WHERE json_extract(condition.value, '$.kind') = 'detail'
     AND json_extract(condition.value, '$.value') = 'flood-level'
   )
 );
