-- Keep the Stripe Customer mapping while removing only abandoned pre-Checkout
-- state. Rows with a created Checkout Session are deliberately excluded.
UPDATE supporter_billing
SET checkout_key = NULL,
    checkout_id = NULL,
    checkout_params = NULL
WHERE checkout_id IS NULL
  AND checkout_key IS NOT NULL
  AND (
    checkout_params IS NULL
    OR CASE
      WHEN json_valid(checkout_params) = 1
      THEN COALESCE(CAST(json_extract(checkout_params, '$.expires_at') AS INTEGER), 0)
           <= CAST(strftime('%s', 'now') AS INTEGER)
      ELSE 1
    END
  );
