const LEGACY_UUID_TITLE = '回答者UUID（自動入力・変更しないでください）';
const TOKEN_TITLE = '回答アクセストークン（自動入力・変更しないでください）';

function setupSurveyForm() {
  const form = FormApp.getActiveForm();
  form.setAllowResponseEdits(true);
  form.setCollectEmail(true);
  removeTextItem_(form, LEGACY_UUID_TITLE);
  const tokenItem = ensureTextItem_(form, TOKEN_TITLE);
  tokenItem.setRequired(true).setValidation(FormApp.createTextValidation()
    .requireTextMatchesPattern('^v1\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{40,200}$')
    .setHelpText('公式サイトからDiscord認証後に回答してください。').build());
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'onSurveySubmit')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('onSurveySubmit').forForm(form).onFormSubmit().create();
  const prefilledUrl = form.createResponse()
    .withItemResponse(tokenItem.createResponse('v1.00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))
    .toPrefilledUrl();
  console.log(JSON.stringify({
    formId: form.getId(),
    prefilledUrl,
  }));
}

function onSurveySubmit(event) {
  const properties = PropertiesService.getScriptProperties();
  const endpoint = properties.getProperty('SURVEY_CALLBACK_URL');
  const secret = properties.getProperty('SURVEY_SUBMISSION_SECRET');
  if (!endpoint || !secret) throw new Error('アンケート連携のScript Propertiesが未設定です。');

  const response = event.response;
  const values = itemValues_(response);
  const payload = JSON.stringify({
    accessToken: values[TOKEN_TITLE] || '',
    responseId: response.getId(),
    editUrl: response.getEditResponseUrl(),
    submittedAt: response.getTimestamp().toISOString(),
  });
  const timestamp = String(Date.now());
  const signature = hmacHex_(secret, timestamp + '.' + payload);
  const result = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    payload,
    headers: { 'X-Survey-Timestamp': timestamp, 'X-Survey-Signature': signature },
    muteHttpExceptions: true,
  });
  const status = result.getResponseCode();
  if (status >= 200 && status < 300) return;
  if (status >= 400 && status < 500) {
    FormApp.getActiveForm().deleteResponse(response.getId());
    console.warn('回答トークンが無効なため回答を削除しました: ' + response.getId());
    return;
  }
  throw new Error('DPI-Bot側の回答検証に失敗しました。HTTP ' + status);
}

function ensureTextItem_(form, title) {
  const existing = form.getItems(FormApp.ItemType.TEXT)
    .map(item => item.asTextItem())
    .find(item => item.getTitle() === title);
  return existing || form.addTextItem().setTitle(title);
}

function removeTextItem_(form, title) {
  form.getItems(FormApp.ItemType.TEXT)
    .filter(item => item.getTitle() === title)
    .forEach(item => form.deleteItem(item));
}

function itemValues_(response) {
  return response.getItemResponses().reduce((result, itemResponse) => {
    result[itemResponse.getItem().getTitle()] = String(itemResponse.getResponse() || '').trim();
    return result;
  }, {});
}

function hmacHex_(secret, message) {
  return Utilities.computeHmacSha256Signature(message, secret)
    .map(value => ((value + 256) % 256).toString(16).padStart(2, '0')).join('');
}
