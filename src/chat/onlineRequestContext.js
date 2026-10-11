// 一次在线请求的「配置侧上下文」：媒体能力 / 模型名 / 配置标签 / 模型声明的上下文窗口。
//
// 为什么单独成模块：`useChatSend.js` 已超架构棘轮基线（只许减不许增），而 K1 的预算
// 需要多一个「模型声明的窗口」字段——顺手把这一整块解析抽出来，守住棘轮。
//
// **本模块不 import 存储层**：`storage/apiConfigs.js` 那条链会拖进 `expo-file-system`，
// Node 里加载不了、也就没法直测。两个查询函数由调用方注入（与 `options.fileSystem`
// 等既有可注入写法一致）；不注入时退化为「什么都不支持」的安全默认。
//
// 纯函数：配置数组由调用方从 `getApiConfigs()` 取好后传入。

// 取不到配置时的安全默认：什么都不支持（宁可不发图片/音频，也不要发给不支持的端点）。
export const EMPTY_ONLINE_REQUEST_CONTEXT = Object.freeze({
  media: Object.freeze({ allowVision: false, allowAudio: false }),
  modelName: '',
  configLabel: '',
  contextWindow: 0,
});

// 选配置的顺序：显式期望的配置 > 活动配置 > 第一个。
// 返回 { media, modelName, configLabel, contextWindow }；contextWindow 为 0 表示**未声明**
// （调用方据此不传 K1 预算 = 保持默认行为，不要拿一个默认窗口去编）。
export function resolveOnlineRequestContext(configs, activeId, expectedConfigId, {
  getModel = () => '',
  getCapabilities = () => null,
} = {}) {
  const list = Array.isArray(configs) ? configs : [];
  const config = list.find(item => item && item.id === expectedConfigId)
    || list.find(item => item && item.id === activeId)
    || list[0];
  if (!config) return { ...EMPTY_ONLINE_REQUEST_CONTEXT };
  const modelName = String(getModel(config) || '').trim();
  return {
    media: {
      allowVision: Boolean(config.supportsVision),
      allowAudio: Boolean(config.supportsAudio),
    },
    modelName,
    configLabel: String(config.name || config.id || ''),
    contextWindow: Number((getCapabilities(config, modelName) || {}).contextWindow) || 0,
  };
}
