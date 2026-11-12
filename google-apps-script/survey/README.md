# Googleフォーム連携

対象フォームに `Code.gs` を紐付け、Script Propertiesへ次を設定してから `setupSurveyForm` を1回実行します。

- `SURVEY_CALLBACK_URL`: `https://dpi-bot.com/api/survey/google-submit`
- `SURVEY_SUBMISSION_SECRET`: Cloudflare Workerと同じ十分に長いランダム値

実行ログに出る `prefilledUrl` の `entry.<数字>` を、Workerの `SURVEY_UUID_ENTRY_ID` と `SURVEY_TOKEN_ENTRY_ID` に設定します。このフォームではUUIDが `266196952`、回答トークンが `1806004575` です。`setupSurveyForm` はメール収集、回答編集、UUID・トークン項目の必須化、送信トリガーを設定します。

フォーム送信時にUUIDと短時間トークンをDPI-Bot側で検証します。検証が明示的に拒否した回答はGoogleフォームから削除されます。一時障害（5xx）の場合は回答を削除せず、トリガーを失敗として記録します。
