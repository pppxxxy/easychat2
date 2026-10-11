// 发送前的历史窗口解析：把「记忆总结设置」读进来，交给纯函数 planHistoryWindow。
//
// 单独一个模块的理由：读取是异步 + 可能失败，而裁剪口径必须是纯函数（Node 可测）。
// 设置读失败一律当作「总结开启」——也就是保持改动前的行为，绝不因为一次存储读失败
// 就悄悄改变发送内容（与工作区模式、向量配置同一条纪律）。

import { getMemorySummarySettings } from '../storage/settings.js';

import { planHistoryWindow } from './replyFlow.js';

export async function resolveHistoryWindow({ historyMessages, boundary }) {
  let memorySummary = null;
  try {
    memorySummary = await getMemorySummarySettings();
  } catch (error) {
    memorySummary = null;
  }
  return planHistoryWindow({ historyMessages, boundary, memorySummary });
}
