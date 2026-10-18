// 表情包「从来不出现」与「图片从不发」两条 P1（2026-10-18）。
//
// 用户报告 A（表情包）：开关 ON、概率 50%、位置「文字下方」，存了表情包，从来没见过。
// 用户报告 B（图片）：开了「图片下载」，从来没见过角色发图（「自动配图」是关的）。
//
// 两者的**共同根因类型**是同一个：功能链路都在，但模型侧的决定被 app 静默否掉，
// 或者用户对开关的预期与实际机制错位，而且**都没有任何可观察的线索**。
//
// 这个文件钉三件事：
//   ① 表情包：模型写了指令就发（概率不再在 app 侧丢指令）；
//   ② 表情包：概率改为提示词措辞，四档说人话且边界正确；
//   ③ 图片：设置文案与教学措辞都把「通道 ≠ 来源」讲清楚。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildStickerInstruction,
  extractStickerDirectives,
  pickExampleName,
  resolveStickerNames,
} from '../src/chat/stickerDirectives.js';
import { chanceToWording } from '../src/chat/stickerPolicy.js';
import { buildAssistantReplyParts } from '../src/chat/assistantReply.js';
import { translate } from '../src/i18n/index.js';

const STICKERS = [
  { id: 's1', name: '开心', uri: 'file:///a.png' },
  { id: 's2', name: '抱抱', uri: 'file:///b.png' },
];

// ---- ① 「模型写了就发」端到端 ----

test('表情包：模型写了指令、名字在白名单 → 必然生成消息（不再被概率吞掉）', () => {
  const names = resolveStickerNames(STICKERS);
  const { stickers: hit } = extractStickerDirectives('晚安 [[表情包:开心]]', names);
  assert.deepEqual(hit, ['开心'], '白名单内的指令应被识别');

  // 曾经 chance=0.5 时约一半的轮次会「指令被剥离、表情包不生成」——静默丢失。
  // 现在无论 chance 取什么值都必须生成。
  for (const chance of [0, 0.1, 0.5, 1]) {
    const { parts } = buildAssistantReplyParts({
      replyText: '晚安 [[表情包:开心]]',
      stickers: STICKERS,
      sticker: { enabled: true, chance },
    });
    const stickerParts = parts.filter(item => item.kind === 'sticker');
    assert.equal(stickerParts.length, 1, `chance=${chance} 时必须生成 1 条表情包消息`);
    assert.equal(parts.find(item => !item.kind).text, '晚安', '正文里的指令必须剥离干净');
  }
});

test('表情包：开关关闭 → 不发，但指令仍被剥离（不把标记露给用户）', () => {
  const { parts } = buildAssistantReplyParts({
    replyText: '晚安 [[表情包:开心]]',
    stickers: STICKERS,
    sticker: { enabled: false },
  });
  assert.equal(parts.some(item => item.kind === 'sticker'), false);
  assert.equal(parts[0].text, '晚安');
  assert.equal(/\[\[表情包/.test(parts[0].text), false, '关闭时也不该让标记出现在正文里');
});

test('表情包：名字不在白名单 → 不生成，且标记**原样保留**（这正是诊断判据）', () => {
  const names = resolveStickerNames(STICKERS);
  const { text, stickers: hit } = extractStickerDirectives('晚安 [[表情包:不存在的名字]]', names);
  assert.deepEqual(hit, [], '白名单外的一律丢弃');
  assert.match(text, /\[\[表情包:不存在的名字\]\]/, '未命中的标记保留原样——诊断靠这个判断「名字错了」');
});

test('表情包：位置设置仍然生效（above 在前 / below 在后）', () => {
  const run = position => buildAssistantReplyParts({
    replyText: '晚安 [[表情包:开心]]',
    stickers: STICKERS,
    sticker: { enabled: true, position },
  }).parts;
  assert.equal(run('above')[0].kind, 'sticker', 'above：表情包在前');
  assert.equal(run('below')[0].kind, undefined, 'below：文字在前');
});

// ---- ② 概率档位 → 提示词措辞 ----

test('概率措辞：四档语义正确，且 0 档真的会「不注入教学」', () => {
  assert.match(chanceToWording(0), /不要/);
  assert.match(chanceToWording(0.1), /偶尔/);
  assert.match(chanceToWording(0.5), /一半/);
  assert.match(chanceToWording(1), /每条/);
  // 100% 档绝不能仍写着「偶尔」——那会反向压制
  assert.equal(/偶尔/.test(chanceToWording(1)), false);

  // chance=0 时 buildStickerInstruction 仍能产出文本（调用方负责不注入），
  // 但那时措辞必须是明确的「不要用」，不会是鼓励。
  const atZero = buildStickerInstruction(['开心'], { chance: 0 });
  assert.match(atZero, /不要/);
});

test('教学模板：按 chance 传入频率措辞；不传时保持旧的「偶尔」口径', () => {
  const withChance = buildStickerInstruction(['开心'], { chance: 1 });
  assert.match(withChance, /每条/, 'chance=1 应注入「每条」措辞');
  assert.equal(/偶尔/.test(withChance), false);

  const legacy = buildStickerInstruction(['开心']);
  assert.match(legacy, /偶尔/, '不传 chance 时保持既有行为（向后兼容既有调用点/测试）');
});

test('教学模板：必须包含「真的写进正文」的强约束与一个合法示例', () => {
  const text = buildStickerInstruction(['开心'], { chance: 0.5 });
  assert.match(text, /真的写|真的出现/, '必须明确「只在心里想不够，要真写出来」（用户截图里的失败模式）');
  assert.match(text, /\[\[表情包:[^\]]+\]\]/, '必须给出一个 few-shot 示例');
});

test('教学示例的名字必须来自用户清单（否则示例本身在教模型自造名字）', () => {
  // 「抱抱」在清单里 → 用它（贴合安慰场景）
  assert.equal(pickExampleName(['开心', '抱抱']), '抱抱');
  // 不在清单里 → 退回第一个，绝不使用清单外的名字
  assert.equal(pickExampleName(['开心', '难过']), '开心');
  assert.equal(pickExampleName([]), '');
  // 集成：示例里的名字必须真的在清单中。
  // 注意取**最后一个** `[[表情包:...]]`：正文前面还有一句「单独写一行：[[表情包:名称]]」
  // 是格式说明（占位符），真正的示例在末尾（这条断言第一版就栽在取错匹配上）。
  const instruction = buildStickerInstruction(['开心', '难过'], { chance: 0.5 });
  const matches = [...instruction.matchAll(/\[\[表情包:([^\]]+)\]\]/g)];
  assert.ok(matches.length >= 2, '应同时有格式说明与示例');
  const example = matches[matches.length - 1];
  assert.ok(['开心', '难过'].includes(example[1]), `示例名「${example[1]}」必须来自清单`);
});

test('教学模板：清单为空返回空串（无表情包就不注入）', () => {
  assert.equal(buildStickerInstruction([]), '');
  assert.equal(buildStickerInstruction(null), '');
});

// ---- ③ 图片：通道 ≠ 来源 ----

test('图片下载文案：中英双语都讲清「只是通道、不提供来源、去开自动配图」', () => {
  const zh = translate('zh-CN', 'settings.downloadImage.hint');
  assert.match(zh, /通道/, '必须点明这是「通道」');
  assert.match(zh, /不提供图片来源|不会自己去网上找图/, '必须说明它不提供图片来源');
  assert.match(zh, /自动配图/, '必须引导到「自动配图」（真正的主动发图路径）');

  const en = translate('en', 'settings.downloadImage.hint');
  assert.match(en, /channel/i);
  assert.match(en, /not a source|source of images/i);
  assert.match(en, /Auto Illustrations/i);
});

test('图片下载文案：仍保留原有的安全提示（不让改动顺手删掉）', () => {
  const zh = translate('zh-CN', 'settings.downloadImage.hint');
  assert.match(zh, /可信/, '安全提示（仅对可信来源开启）必须保留');
  const en = translate('en', 'settings.downloadImage.hint');
  assert.match(en, /trusted/i);
});

test('图片教学措辞：讲清「何时可用」，不是只说「不要编造」', () => {
  const source = fs.readFileSync(path.resolve('src/prompt/chatPipeline.js'), 'utf8');
  const block = source.slice(
    source.indexOf('const DOWNLOAD_IMAGE_INSTRUCTION'),
    source.indexOf('export function buildRequestMessages')
  );
  // 必须仍然禁止编造（安全底线不能丢）
  assert.match(block, /不要编造/, '不得编造 URL 这条必须保留');
  // 但必须同时给出「何时可以用」——原措辞只有禁止，模型于是永远不用
  assert.match(block, /使用条件|只在对话上下文中确实出现过/, '必须讲清可用条件（否则模型永远不用这条指令）');
  // 并说明自己没有联网搜图能力（否则模型会假装能找图）
  assert.match(block, /没有联网搜图的能力|无法联网/, '必须说明没有联网搜图能力');
});

// ---- 可观测性：解析处要留痕，否则下次仍无法归因 ----

test('可观测性：assistantReply 在有指令活动时留诊断，且覆盖三类归因', () => {
  const source = fs.readFileSync(path.resolve('src/chat/assistantReply.js'), 'utf8');
  assert.match(source, /recordDiagnostic/, '必须有诊断留痕');
  assert.match(source, /not in whitelist|白名单/, '要能区分「名字不在白名单」');
  assert.match(source, /recordStickerDiagnostic/, '诊断应集中在单一函数里，便于维护');
  // 干净回复（没写指令）不该刷屏：必须有「没有指令就不记」的早退
  assert.match(source, /if \(!hasDirective\) return/, '没有指令时必须早退，否则每轮一条把诊断刷爆');
});
