// 表情包策略：概率与位置的纯逻辑（零 RN 依赖，Node 直测）。
//
// 背景：表情包「教学」原先挂在一条全局预设上（src/settings/presets.js 的「表情包使用」），
// 需手动开启、且老用户持久化的预设列表里根本没有它，实际从未触发。改为「聊天开关 + 概率」
// 之后，概率判定与位置归一化需要可测的纯逻辑，集中在这里。

export const DEFAULT_STICKER_CHANCE = 0.5;

// 位置：文字下方（默认，与旧行为一致）/ 文字上方。
export const STICKER_POSITIONS = Object.freeze(['below', 'above']);

// 归一化概率：非法/缺失回落默认；夹取到 [0, 1]。
export function normalizeStickerChance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_STICKER_CHANCE;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

// 位置归一化：只认 below/above，其余回落 below。
export function normalizeStickerPosition(value) {
  return value === 'above' ? 'above' : 'below';
}

// 本轮是否允许发表情包：只看「开关开启 + 有表情包」。
//
// ⚠️ 2026-10-18 语义变更（用户报告「开了表情、也存了表情包，从来没见过」）：
// 这里**不再掷骰子**。原来的实现是每轮 `Math.random() < chance`，后果是一个
// 双重控制打架的死结：提示词已经写明「只在情绪真正贴合时偶尔使用」（管模型侧频率），
// app 侧又用硬币把模型**已经发出**的指令丢掉——模型写了 [[表情包:微笑]]，
// extractStickerDirectives 已把指令从正文剥离（所以正文干净、看不出痕迹），
// 而 allowStickers=false 时表情包消息不生成 ⇒ 指令凭空消失、无表情包、无任何提示。
// 用户看到的就是「从来不发表情包」，而且**没有任何可观察的线索**。
//
// 新语义：模型写了就发。频率由提示词按概率档位控制（见 stickerDirectives 的
// buildStickerInstruction 与 chanceToWording）——把「发多少」交给真正做决定的模型，
// app 不再二次否决。chance=0 时教学不注入（见 buildStickerInstruction），
// 于是模型根本不会被引导去写指令，效果仍然是「不发」。
//
// random 参数保留但**不再使用**：既有调用点/测试可能还在传，删参数会波及无关文件；
// 留着它让签名兼容，同时用注释说清它已不参与判定（避免下一个人以为它还有效）。
export function shouldSendStickers({ enabled, hasStickers } = {}) {
  return Boolean(enabled) && Boolean(hasStickers);
}

// 概率档位 → 提示词措辞（纯函数，Node 直测）。
//
// 为什么需要它：「发表情包概率」这个设置项原本只影响 app 侧硬币，现在改成**影响提示词**，
// 就必须有一个确定的「档位 → 措辞」映射，否则改文案时容易让 0%/100% 的边界说反。
// 档位用 [0,1] 的数值（与 normalizeStickerChance 同域），映射成模型能照做的自然语言。
export function chanceToWording(chance) {
  const value = normalizeStickerChance(chance);
  // 0 由调用方处理（不注入教学），这里仍给一个兜底措辞，防有人单独调用时拿到 undefined。
  if (value >= 1) return '只要情绪合适，每条回复都可以带一个表情包。';
  if (value >= 0.75) return '大多数回复（约四分之三）在情绪合适时可以带一个表情包。';
  if (value >= 0.4) return '大约一半的回复可以在情绪合适时带一个表情包。';
  if (value > 0) return '偶尔（少数回复）在情绪特别贴合时可以带一个表情包。';
  return '不要在回复里使用表情包。';
}
