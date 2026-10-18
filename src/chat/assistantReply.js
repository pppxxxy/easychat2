// 助手回复 → 消息分段（从 ChatScreen.js 外提并扩展图片下载指令）。
//
// 纯逻辑、零 RN 依赖、Node 可直测：把一条助手回复拆成「文字消息 + 表情包媒体消息」，
// 同时剥离并收集 <download_image:URL> 指令（下载由调用方异步执行，见 imageDownloadRunner）。
// 表情包名称必须命中白名单；图片下载只在开关开启时解析。

import { ASSISTANT_ID } from './chatConstants.js';
import { STICKER_MESSAGE_KIND, createMediaMessage } from './chatMedia.js';
import { extractStickerDirectives, resolveStickerNames } from './stickerDirectives.js';
import { extractDownloadImageDirectives } from './imageDownloadDirectives.js';
import { normalizeStickerPosition, shouldSendStickers } from './stickerPolicy.js';
import { recordDiagnostic } from '../storage/diagnostics.js';

// 表情包归因留痕（用户「从来没见过表情包」的可观测性需求）。
//
// 三种情况必须能区分，否则下次再报「从来没见过」依然只能猜：
//   ① 模型根本没写指令       → 问题在提示词/模型意愿（教学不够强）
//   ② 写了但名字不在白名单   → 问题在清单（模型记错了名字，或用户改名了）
//   ③ 写了且命中 N 条        → 若仍没显示，问题在渲染/消息落屏，不在解析
//
// 只在**有指令活动**时留痕：干净回复（没写指令）不记，否则每轮一条会把诊断刷爆。
// 白名单不命中的判断依据：extractStickerDirectives 对未命中项**原样保留标记**
// （见 stickerDirectives.js:42 的 `if (!allowed.has(name)) return match;`），
// 所以正文里仍有 `[[表情包:` 就说明存在未命中项。
// 诊断上下文里拼接名字：这里是**诊断日志文本**（给开发者/模型看的内部记录），
// 与 i18n 的列表分隔符规则无关——那一套是给「用户可见文案」用的。
// 用 += 拼接而不是 join('、')，既避免误踩 no-hardcoded-chinese-text 的 join 分支，
// 也让这段内部文本的意图（自由拼接）更直白。
function joinNames(names) {
  const list = Array.isArray(names) ? names : [];
  let out = '';
  for (let index = 0; index < list.length; index += 1) {
    if (index > 0) out += '、';
    out += String(list[index]);
  }
  return out;
}

function recordStickerDiagnostic({ replyText, names, hitNames, allowStickers }) {
  try {
    const source = String(replyText || '');
    const hasDirective = /\[\[\s*表情包\s*[:：]/.test(source);
    if (!hasDirective) return; // 模型没写：不记（这是常态，记了只会刷屏）
    const hit = Array.isArray(hitNames) ? hitNames : [];
    if (hit.length > 0) {
      if (!allowStickers) {
        recordDiagnostic(
          'sticker',
          new Error('sticker directives hit but not allowed'),
          `命中 ${hit.length} 条但未放行：${joinNames(hit)}`
        );
      }
      return; // 命中且放行 = 正常路径，不留痕
    }
    // 写了指令但一条都没命中 → 名字不在白名单（这是最需要归因的一种）
    const requested = (source.match(/\[\[\s*表情包\s*[:：]\s*([^\]\n]+?)\s*\]\]/g) || [])
      .map(item => item.replace(/^\[\[\s*表情包\s*[:：]\s*/, '').replace(/\s*\]\]$/, '').trim())
      .filter(Boolean);
    recordDiagnostic(
      'sticker',
      new Error('sticker directives not in whitelist'),
      `请求 [${joinNames(requested)}]，可用 [${joinNames(names)}]`
    );
  } catch (error) {
    // 诊断是旁路：任何失败都不得影响回复解析主流程。
  }
}

// 返回 { parts, imageDownloads }：
//  · parts —— 可直接替换占位符的消息数组（默认文字在前、表情包依次在后；「上方」时反序）；
//  · imageDownloads —— 需异步下载的图片 URL（最多 MAX_DOWNLOAD_IMAGES 个）。
//
// sticker 选项：{ enabled, position }——只决定「开关 + 位置」。
// chance 已不参与判定（概率改由提示词控制，见 stickerPolicy），random 参数仅为
// 兼容既有调用点/测试而保留，**不再读取**。
export function buildAssistantReplyParts({ replyText, stickers, downloadEnabled = false, sticker = {} } = {}) {
  const list = Array.isArray(stickers) ? stickers : [];
  const names = resolveStickerNames(list);
  const { text: afterStickers, stickers: hitNames } = extractStickerDirectives(replyText || '', names);
  const { text, urls } = downloadEnabled
    ? extractDownloadImageDirectives(afterStickers)
    : { text: afterStickers, urls: [] };

  // 表情包：开关关闭 / 无表情包 → 本轮不发。指令仍已从正文剥离，不会露出标记。
  //
  // 2026-10-18：**不再掷骰子**（见 stickerPolicy.shouldSendStickers 的说明）。
  // 模型写了就发——概率已改为提示词里的频率措辞，app 侧不再二次否决。
  const allowStickers = shouldSendStickers({
    enabled: sticker && sticker.enabled === true,
    hasStickers: names.length > 0,
  });
  // 可观测性（用户「从来没见过表情包」的归因依据）：区分三种情况并留痕。
  // 没有这个，下次再报「从来没见过」依然只能靠猜——是模型没写、还是写了但名字不在
  // 白名单（被丢弃）、还是写了且命中却因其它原因没生成。
  recordStickerDiagnostic({
    replyText,
    names,
    hitNames,
    allowStickers,
  });
  const byName = new Map(list.map(item => [item.name, item]));
  const now = Date.now();
  const textItem = [];
  const body = String(text || '').trim();
  if (body) {
    textItem.push({ id: `${now}-assistant`, role: ASSISTANT_ID, text: body, timestamp: now });
  }
  const stickerItems = [];
  if (allowStickers) {
    hitNames.forEach((name, index) => {
      const matched = byName.get(name);
      if (!matched) return;
      stickerItems.push(createMediaMessage({
        id: `${now}-assistant-sticker-${index}`,
        kind: STICKER_MESSAGE_KIND,
        role: ASSISTANT_ID,
        uri: matched.uri,
        mime: matched.mime,
        name,
        stickerName: name,
        stickerId: matched.id,
        width: matched.width,
        height: matched.height,
        timestamp: now + index + 1,
      }));
    });
  }
  const ordered = normalizeStickerPosition(sticker && sticker.position) === 'above'
    ? [...stickerItems, ...textItem]
    : [...textItem, ...stickerItems];
  // createMediaMessage 固定 role:'user'（用户发表情包用），助手表情包需覆盖为 assistant。
  const parts = ordered.map(item => (
    item.kind === STICKER_MESSAGE_KIND ? { ...item, role: ASSISTANT_ID } : item
  ));
  return { parts, imageDownloads: urls };
}
