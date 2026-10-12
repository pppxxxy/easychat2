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

// 取不到配置时的安全默认：什么都不支持（宁可不发图片/音频/视频，也不要发给不支持的端点）。
// allowVideo 必须与 allowVision/allowAudio 一起显式给 false：`filterRequestMedia` 是
// 解构取默认值（缺字段 = false），这里少写一个字段就会让「取不到配置」这条最危险的路径
// 依赖别处的默认值——能力对象要能自证它放行了什么。
export const EMPTY_ONLINE_REQUEST_CONTEXT = Object.freeze({
  media: Object.freeze({ allowVision: false, allowAudio: false, allowVideo: false }),
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
  // 媒体能力一律按**当前模型**解析（capabilitiesForModel），与发送侧门控同一口径：
  // - allowVision/allowAudio 不再读配置级 supports*——配置级字段只剩「旧版兼容读取」，
  //   逐模型能力编辑器只写 modelCapabilities，读配置级会漏掉用户新开的识图/音频。
  // - allowVideo 此前**从来没被产出过**：`filterRequestMedia` 是解构取默认值（缺字段 =
  //   false），而这里只给 allowVision/allowAudio ⇒ 已经建好的 `video_url` 被裁成一行
  //   「【视频：名称】」纯文本，**静默丢件**——用户以为视频发出去了，模型只看到文件名
  //   （附件菜单/发送侧却是按「支持视频」放行的，两边口径不一致）。
  //   判据与发送侧 videoEnabled（useChatSend.js:1392）逐字同源：模型声明 supportsVideo
  //   **且**线协议是 OpenAI 兼容——`video_url` 是 OpenAI 兼容端点的扩展类型，
  //   Responses/Anthropic 都没有视频输入（协议层另有一道丢弃，见 apiProtocols/messages.js）。
  //   本地 llama.cpp 链路没有视频能力，`filterRequestMedia` 的默认 false 保持不动，留给它继续裁剪。
  const caps = getCapabilities(config, modelName) || {};
  return {
    media: {
      allowVision: caps.supportsVision === true,
      allowAudio: caps.supportsAudio === true,
      allowVideo: caps.supportsVideo === true
        && String(config.protocol || 'openai') === 'openai',
    },
    modelName,
    configLabel: String(config.name || config.id || ''),
    contextWindow: Number(caps.contextWindow) || 0,
  };
}
