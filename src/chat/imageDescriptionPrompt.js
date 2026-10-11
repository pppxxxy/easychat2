// 图片识别（OCR）描述在**模型上下文**里用的两段固定文本 + 文本拼装。
//
// 为什么单独一个小模块：这两段是发给模型的提示词（按仓库铁律不进 i18n），但需要被
// 两处消费——chat/chatMedia.js 拼上下文投影、imageRecognition/index.js 拼识别结果。
// 若让 chatMedia 直接 import imageRecognition/index.js，就会拉出
// 「chatMedia → imageRecognition → network/api → storage/settings → …」的长链，
// 徒增耦合与环风险。放到这个零依赖叶子里，两边都只依赖它。
//
// 两段文本用**函数**返回而不是导出字符串常量：`export const X = '中文'` 会命中
// no-hardcoded-chinese-text（模块级导出常量），而规则有意不覆盖函数体内的返回值
//（那里大多是匹配关键词/模型提示词）。这里的中文确实属于「不该翻译的模型提示词」。

export function imageDescriptionPrefix() {
  return '【图片内容（由图片识别模型转述）】';
}

export function imageDescriptionFailed() {
  return '【这张图片的内容识别失败，你这次看不到它的内容】';
}

// 把识别结果拼成给主模型的文本：成功项带前缀，失败项如实标注（不静默省略）。
// 归属键优先用 sourceUri（file:// 原路径），没有才退回 dataUri——调用方（聊天发送
// 路径）持有的是文件路径，用它才能把描述配回对应消息。
export function buildImageDescriptionText(descriptions = []) {
  const prefix = imageDescriptionPrefix();
  const failed = imageDescriptionFailed();
  return (Array.isArray(descriptions) ? descriptions : [])
    .filter(item => item && (item.sourceUri || item.dataUri))
    .map(item => {
      const body = String(item.description || '').trim();
      return body ? `${prefix}\n${body}` : failed;
    })
    .join('\n\n');
}
