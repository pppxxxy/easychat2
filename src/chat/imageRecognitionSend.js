// 聊天发送路径的「图片识别（OCR）接线」。
//
// 从 src/chat/useChatSend.js 外提：那段接线（识别 → 描述注入 → 是否附原图 → 降级
// 判定）是纯编排，与发送流程的其它部分零交叉，抽出来既能直测、也不让已经顶到行数
// 基线的 useChatSend 继续膨胀（行数基线不留余量，能外提就外提）。
//
// 三条纪律（都有行为测试钉住）：
// 1. 描述注入到**消息对象**上（description / descriptionFailed），由 chatMedia 的
//    上下文投影拼进文本——所以看不到图的模型也能读到画面内容；
// 2. 失败**不许静默丢图**：主模型能看图 → 退回直发原图；看不到图 → 交给调用方给
//    用户可见的失败提示（decision === 'fail'）；
// 3. 是否附原图由 decideAttachOriginal 决定（主模型看不到图时一律不附）。

import { decideAttachOriginal, decideImageRecognitionAction, describeImageFiles, resolveImageRecognitionPlan } from '../imageRecognition/index.js';
import { isImageDescriptionEligible } from './chatMedia.js';

// 返回值：
// - decision：'continue' | 'fallback-original' | 'fail'（见 decideImageRecognitionAction）
// - attachOriginal：识别成功时是否把原图也交给主模型
// - failureCount / skipped / reason：透传引擎结果，供调用方记录与分流
// - ran：是否真的跑了识别（未就绪/无图时为 false，调用方不该改 includeImage）
export async function applyImageRecognitionToMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  // 只处理**普通图片**：表情包本身有名字（描述它没有意义，还白花一次请求），
  // 视频不走图片识别。判据与上下文投影共用 chatMedia.isImageDescriptionEligible。
  const targets = list.filter(isImageDescriptionEligible);
  if (targets.length === 0) {
    return { ran: false, decision: 'continue', attachOriginal: false, failureCount: 0, skipped: true, reason: 'no-image' };
  }
  const plan = options.plan || await resolveImageRecognitionPlan(options.settings || null).catch(() => null);
  if (!plan || !plan.ready) {
    return {
      ran: false,
      decision: 'continue',
      attachOriginal: false,
      failureCount: 0,
      skipped: true,
      reason: plan ? plan.reason : 'no-plan',
    };
  }
  const recognized = await describeImageFiles(
    targets.map(item => item.image.uri),
    {
      mainModelVision: options.mainModelVision === true,
      signal: options.signal || null,
      // 角色专属 OCR 配置：由调用方从 character/runtimeConfig.js 的解析层取好后传进来
      //（**不在本模块自己读盘**——override ?? global 只能有一处实现）。
      settings: options.settings || null,
    }
  );
  // 按**来源 URI** 把描述配回对应消息：调用方持有 file:// 路径，识别用的是 data URI。
  const byUri = new Map();
  (recognized.descriptions || []).forEach(item => {
    if (item && item.sourceUri) byUri.set(String(item.sourceUri), String(item.description || ''));
  });
  targets.forEach(item => {
    const description = byUri.get(String(item.image.uri)) || '';
    if (description) item.description = description;
    else item.descriptionFailed = true;
  });
  const decision = decideImageRecognitionAction({
    mainModelVision: options.mainModelVision === true,
    failureCount: recognized.failureCount,
    imageCount: targets.length,
  });
  return {
    ran: true,
    decision,
    attachOriginal: recognized.skipped === false
      ? recognized.attachOriginal === true
      : decideAttachOriginal({ settings: plan.settings, mainModelVision: options.mainModelVision === true }),
    failureCount: recognized.failureCount,
    skipped: recognized.skipped,
    reason: recognized.reason,
  };
}
