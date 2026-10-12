// i18n 词条 · tts 域（English）。聚合入口见 ../en.js。
export const tts = {
  'tts.alert.engineMigrated.title': 'TTS engine updated',
  'tts.alert.engineMigrated.body': 'The previously selected TTS engine is offline or unavailable and was switched to the system engine. Please choose again below.',
  'tts.alert.loadFailed.title': 'Read failed',
  'tts.alert.loadFailed.body': 'Could not read the speech settings.',
  // Saving after a failed read: state *why* saving is refused (aborted so the existing
  // configuration is not overwritten), same wording as error.storage.characterIndexReadFailed.
  'tts.alert.saveAborted.title': 'Cannot save',
  'tts.alert.saveAborted.body': 'Speech settings could not be read. Saving was aborted so your existing configuration is not overwritten. Please close and try again.',
  'tts.saveDisabled.readFailed': 'Speech settings could not be read, so saving is disabled to avoid overwriting your existing configuration.',
  'tts.alert.saveFailed.title': 'Save failed',
  'tts.alert.saveFailed.body': 'Check storage space or permissions.',
  'tts.alert.openLinkFailed.title': 'Cannot open link',
  // The panel name and "Close" are two different meanings and must not share one key
  // (same shape as transcription.title + transcription.closeA11y). `title` used to hold the
  // close wording, so the panel header read "Close".
  'tts.title': 'Voice Playback',
  'tts.closeA11y': 'Close',
  'tts.alert.unsupported.title': 'Not supported',
  'tts.alert.unsupported.body': 'The current engine does not support this service',
  'tts.alert.unsupported.defaultNote': '{name} is not supported yet',
  'tts.providerUnsupported': '{name} · not supported',
  'tts.unsupportedHint': 'The current engine does not support: {note}',
  'tts.unsupportedHint.defaultNote': 'this engine is not supported yet. Playback will fail, please choose another engine.',
  // 原值 'Label' 是机器翻译残留（中文基准是「预置音色（可选）」）：英文界面下
  // 音色选择区的标题会显示成「Label」。
  'tts.voices.label': 'Preset voices (optional)',
  'tts.a11y.getApiKey': 'Get the API Key for {name}',
  'tts.a11y.providerUnsupported': '{name}, not supported',
  'tts.autoBroadcast.hint': 'When on, character replies are read aloud automatically; tapping "Read aloud" under a message still works regardless.',
  'tts.autoBroadcast.title': 'Auto read aloud',
  'tts.getApiKey': 'Get API key / secret',
  'tts.hint.keyLocal': 'Keys are stored only on this device and never written to logs or documents.',
  'tts.hint.sendToProvider': 'Reading aloud sends the selected reply text to the chosen provider for speech synthesis.',
  'tts.providerLabel': 'Voice engine',
  'tts.voices.default': 'Default',
  'tts.volcanoHint': 'Volcano Engine uses a Bearer authorization header; get the Access Token and AppID from the speech console.',

  // Provider display names (providers.js labels are Chinese constants; the UI looks these
  // up by id. Add one when adding a provider, otherwise it falls back to the constant label).
  'tts.providerName.system': 'System engine',
  'tts.providerName.xiaomiMimo': 'Xiaomi MiMo',
  'tts.providerName.siliconflow': 'SiliconFlow',
  'tts.providerName.iflytekSpark': 'iFlytek Spark',
  'tts.providerName.stepfun': 'StepFun',
  'tts.providerName.tencentCloud': 'Tencent Cloud',
  'tts.providerName.aliyun': 'Aliyun Smart Speech',
  'tts.providerName.baidu': 'Baidu Smart Cloud',
  'tts.providerName.volcano': 'Volcano Engine',
  'tts.providerName.minimax': 'MiniMax',

  // Field copy for the voice engines (providers.js fields carry labelKey / placeholderKey;
  // one entry per meaning, shared across providers). Language-neutral placeholders
  // (URLs, model IDs, numbers) stay as literals and get no entry.
  'tts.field.label.voice': 'Voice',
  'tts.field.label.speed': 'Speed',
  'tts.field.label.baseUrl': 'Endpoint URL',
  'tts.field.label.apiKey': 'API Key',
  'tts.field.label.model': 'Model',
  'tts.field.label.appId': 'App ID',
  'tts.field.label.volcanoAppId': 'App ID',
  'tts.field.label.volcanoToken': 'Access Token',
  'tts.field.label.iflytekApiKey': 'APIKey',
  'tts.field.label.iflytekApiSecret': 'APISecret',
  'tts.field.label.secretId': 'SecretId',
  'tts.field.label.secretKey': 'SecretKey',
  'tts.field.label.appSecret': 'Secret Key',
  'tts.field.label.region': 'Region',
  'tts.field.label.voiceId': 'Voice ID',
  'tts.field.label.accessToken': 'Access Token',
  'tts.field.label.appKey': 'AppKey',
  'tts.field.label.speaker': 'Voice',
  'tts.field.label.groupId': 'GroupId',
  'tts.field.placeholder.voiceDefault': 'Leave empty for the default voice',
  'tts.field.placeholder.mimoApiKey': 'Get it from the open platform console',
  'tts.field.placeholder.appId': 'Application ID',
  'tts.field.placeholder.voiceList': 'See the provider voice list',
  'tts.field.placeholder.aliyunToken': 'Get it from the Smart Speech console',
  'tts.field.placeholder.appKey': 'Application AppKey',
  'tts.field.placeholder.accessToken': 'Access token',
  'tts.field.placeholder.minimaxBaseUrl': 'api.minimaxi.com for mainland China; international accounts use api.minimax.io',

  // Why an engine is unavailable (providers.js unsupportedNote is a Chinese constant too).
  'tts.providerNote.iflytekSpark': 'iFlytek speech uses the WebSocket (wss) protocol, which the current engine does not support yet',
  'tts.providerNote.tencentCloud': 'Tencent Cloud needs TC3-HMAC-SHA256 signing, which is not implemented yet',
};
