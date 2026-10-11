// 看屏幕的「画面识别来源」：走主模型直接看，还是先用图片识别（OCR）模型转成文字描述。
//
// 为什么单独一层：这是**纯决策 + 请求形态**，与 React 无关，可以直测；而
// useScreenWatchComments 是 hook，Node 里跑不动。把判定抽出来后，「模型选择真的
// 生效」这件事才有行为测试钉住（而不是只靠源码字符串断言）。
//
// 口径与聊天路径一致：
// - 'main'：画面直接交给当前聊天模型（需要它支持识图）——**默认值，行为与既有完全一致**；
// - 'ocr'：画面先由图片识别模型转成文字描述，描述作为文本交给主模型评论；
//   主模型自己也能看图且用户开了「同时附原图」时才附原图。
//
// 失败不许静默丢画面：OCR 模式下识别失败时，主模型能看图就退回直发原图；
// 看不到图就给用户可见的失败提示（reason='ocr-failed'）。

import { describeImages } from '../imageRecognition/index.js';
import { getImageRecognitionSettings } from '../storage/settings/imageRecognition.js';

// 当前生效的画面识别来源：读用户配置；读不到时回落 'main'（既有行为）。
export async function resolveScreenWatchSource() {
  const settings = await getImageRecognitionSettings().catch(() => null);
  const source = String((settings && settings.screenWatchSource) || '');
  return source === 'ocr' ? 'ocr' : 'main';
}

// 纯判定：拿到识别结果后，请求里到底放什么。
// 返回 { images, descriptionText, useDescriptionOnly, error }：
// - images：要交给主模型的数据 URI 列表（OCR 成功且不附原图时为空）；
// - descriptionText：要注入到用户文本里的画面描述（OCR 成功时非空）；
// - useDescriptionOnly：true 表示这次是「只发文字描述」（供调用方如实告知）；
// - error：非空表示不能继续（'ocr-failed' / 'ocr-unavailable'）。
export function buildScreenWatchRequestShape({ source, dataUris = [], recognition = null, mainModelVision = false }) {
  const uris = (Array.isArray(dataUris) ? dataUris : []).map(item => String(item || '')).filter(Boolean);
  if (source !== 'ocr') {
    // 主模型直接看：保持既有行为（画面随多模态发出）。
    return { images: uris, descriptionText: '', useDescriptionOnly: false, error: '' };
  }
  if (!recognition || recognition.skipped) {
    return { images: [], descriptionText: '', useDescriptionOnly: false, error: 'ocr-unavailable' };
  }
  if (recognition.failureCount > 0) {
    // 识别失败：主模型能看图 → 退回直发原图（不静默丢画面）；看不到图 → 明确失败。
    if (mainModelVision) {
      return { images: uris, descriptionText: '', useDescriptionOnly: false, error: '' };
    }
    return { images: [], descriptionText: '', useDescriptionOnly: false, error: 'ocr-failed' };
  }
  return {
    images: recognition.attachOriginal === true ? uris : [],
    descriptionText: String(recognition.text || ''),
    useDescriptionOnly: recognition.attachOriginal !== true,
    error: '',
  };
}

// 编排：按来源决定要不要先识别，并给出请求形态。
// settings = **角色生效**的图片识别设置（调用方从 character/runtimeConfig.js 的解析层
// 取好后传进来）；不传时引擎按全局设置解析（既有行为）。识别本身不许在这里自己读盘。
export async function resolveScreenWatchRequest({ source, dataUris, signal = null, mainModelVision = false, settings = null }) {
  if (source !== 'ocr') {
    return buildScreenWatchRequestShape({ source, dataUris, mainModelVision });
  }
  const recognition = await describeImages(dataUris, { signal, mainModelVision, settings });
  return buildScreenWatchRequestShape({ source, dataUris, recognition, mainModelVision });
}

// 把描述文本拼进用户文本（在原有内容之后，作为「画面内容」补充）。
export function mergeDescriptionIntoUserText(userText, descriptionText) {
  const base = String(userText || '').trim();
  const description = String(descriptionText || '').trim();
  if (!description) return base;
  return base ? `${base}\n\n${description}` : description;
}
