// i18n 词条 · tts 域（zh-CN 基准）。聚合入口见 ../zh-CN.js。
export const tts = {
  'tts.alert.engineMigrated.title': '播报引擎已更新',
  'tts.alert.engineMigrated.body': '原先选择的播报引擎已下线或不可用，已切换为系统引擎，请在下方重新选择。',
  'tts.alert.loadFailed.title': '读取失败',
  'tts.alert.loadFailed.body': '无法读取语音播报设置。',
  // 读失败后仍去保存：必须说清「为什么不能存」（已中止保存以免覆盖已有配置），
  // 口径同 storage/worldMap.js:37 与 error.storage.characterIndexReadFailed——
  // 只说「保存失败」会把用户引去查存储权限，而真实原因是读失败。
  'tts.alert.saveAborted.title': '无法保存',
  'tts.alert.saveAborted.body': '语音播报设置未能读出，已中止保存以免覆盖已有配置，请关闭后重试。',
  'tts.saveDisabled.readFailed': '语音播报设置未能读出，已停用保存以免覆盖已有配置。',
  'tts.alert.saveFailed.title': '保存失败',
  'tts.alert.saveFailed.body': '请检查存储空间或权限。',
  'tts.alert.openLinkFailed.title': '无法打开链接',
  // 面板名与「关闭」是两个语义，不能共用一个键（形态照 transcription.title +
  // transcription.closeA11y）。此前 title 被误写成关闭文案 ⇒ 面板标题显示成「关闭」。
  'tts.title': '语音播报',
  'tts.closeA11y': '关闭',
  'tts.alert.unsupported.title': '暂不支持',
  'tts.alert.unsupported.body': '当前引擎暂不支持该服务',
  'tts.alert.unsupported.defaultNote': '{name}，暂不支持',
  'tts.providerUnsupported': '{name}·暂不支持',
  'tts.unsupportedHint': '当前引擎暂不支持：{note}',
  // 原值开头多一个孤立的 `}`（'{...}。播报会失败…' 的 `{...}` 段被删掉后留下的碎片），
  // 拼在 '当前引擎暂不支持：{note}' 之后会渲染成「当前引擎暂不支持：}。播报会失败…」。
  // 只删掉缺陷前缀 `}。`，其余一字不动：若只删 `}` 会留下「：。」连排标点，
  // 若补成「该引擎尚未支持…」则与前面的「暂不支持：」重复。同一缺陷家族的另一例
  // （zh-CN/preset.js 的 preset.unnamed，原值 '}」吗？'）**已修为 '未命名'**；此处保留
  // 本条的修复说明，作为这个「删模板 {…} 段留下尾巴」家族的**已修案例登记**。
  'tts.unsupportedHint.defaultNote': '播报会失败，请选择其他引擎。',
  'tts.voices.label': '预置音色（可选）',
  'tts.a11y.getApiKey': '获取 {name} 的 API Key',
  'tts.a11y.providerUnsupported': '{name}，暂不支持',
  'tts.autoBroadcast.hint': '开启后，角色回复完成会自动朗读；手动点消息下方「播报」不受此开关影响。',
  'tts.autoBroadcast.title': '自动播报',
  'tts.getApiKey': '获取 API Key / 密钥',
  'tts.hint.keyLocal': '密钥仅保存在本机，不会写入日志或文档。',
  'tts.hint.sendToProvider': '播报时会把你选中的回复文本发送到所选服务商合成音频。',
  'tts.providerLabel': '播报源',
  'tts.voices.default': '默认',
  'tts.volcanoHint': '火山引擎使用 Bearer; 签名头，请在语音控制台获取 Access Token 与 AppID。',

  // 播报源显示名（providers.js 的 label 是中文常量，界面按 id 查这里的词条；
  // 新增 provider 时记得同步补一条，否则回落常量 label）。
  'tts.providerName.system': '系统引擎',
  'tts.providerName.xiaomiMimo': '小米 MiMo',
  'tts.providerName.siliconflow': '硅基流动',
  'tts.providerName.iflytekSpark': '讯飞星火',
  'tts.providerName.stepfun': '阶跃星辰',
  'tts.providerName.tencentCloud': '腾讯云',
  'tts.providerName.aliyun': '阿里云智能语音',
  'tts.providerName.baidu': '百度智能云',
  'tts.providerName.volcano': '火山引擎',
  'tts.providerName.minimax': 'MiniMax',

  // 播报源的字段文案（providers.js 的字段带 labelKey / placeholderKey；
  // 同一语义跨 provider 共用一条，如「音色」「语速」）。URL / 模型 ID / 数字这类
  // 语言无关的占位符不建词条，仍走字段自带的字面量。
  'tts.field.label.voice': '音色',
  'tts.field.label.speed': '语速',
  'tts.field.label.baseUrl': '接口地址',
  'tts.field.label.apiKey': 'API Key',
  'tts.field.label.model': '模型名',
  'tts.field.label.appId': 'APPID',
  'tts.field.label.volcanoAppId': 'AppID',
  'tts.field.label.volcanoToken': 'Access Token',
  'tts.field.label.iflytekApiKey': 'APIKey',
  'tts.field.label.iflytekApiSecret': 'APISecret',
  'tts.field.label.secretId': 'SecretId',
  'tts.field.label.secretKey': 'SecretKey',
  'tts.field.label.appSecret': 'Secret Key',
  'tts.field.label.region': '地域',
  'tts.field.label.voiceId': '音色 ID',
  'tts.field.label.accessToken': '访问令牌',
  'tts.field.label.appKey': 'AppKey',
  'tts.field.label.speaker': '发音人',
  'tts.field.label.groupId': 'GroupId',
  'tts.field.placeholder.voiceDefault': '留空使用默认',
  'tts.field.placeholder.mimoApiKey': '在开放平台控制台获取',
  'tts.field.placeholder.appId': '应用 ID',
  'tts.field.placeholder.voiceList': '以官方音色列表为准',
  'tts.field.placeholder.aliyunToken': '智能语音交互控制台获取',
  'tts.field.placeholder.appKey': '应用 AppKey',
  'tts.field.placeholder.accessToken': '访问令牌',
  'tts.field.placeholder.minimaxBaseUrl': '国内 api.minimaxi.com；国际账号改 api.minimax.io',

  // 「暂不支持」的原因说明（providers.js 的 unsupportedNote 也是中文常量，会渲染进提示）。
  'tts.providerNote.iflytekSpark': '讯飞语音走 WebSocket（wss）协议，当前引擎暂不支持',
  'tts.providerNote.tencentCloud': '腾讯云需要 TC3-HMAC-SHA256 签名，尚未实现',
};
