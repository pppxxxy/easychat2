// 免责条款内容域：完备性 + 「内容 ↔ 版本号」配对棘轮 + 「整段文本 ↔ 分节」单一来源棘轮。
//
// 为什么需要这个文件：`src/onboarding/disclaimerContent.js` 的文件头写着两件
// **没有机械检查**的事——
//   ①「这样 Node 测试可以直接 import 校验条款完备性与章节一致性」—— 而此前**一个测试都没有**；
//   ②「条款实质变更时记得同步 bump DISCLAIMER_VERSION，否则存量用户不会重新确认新条款
//      （法律效力前提）」—— 全靠"记得"。
// 规则 3：只靠约定的不变量会被违反。这里把 ①② 都变成会红的断言。
//
// ---------------------------------------------------------------------------
// 2026-10-12：两份条款已按「对用户更严格」统一为**单一来源**。
//
// 统一前 `DISCLAIMER_TEXT`（整段）与 `DISCLAIMER_SECTIONS`（分节）是同一份条款的
// 两个**手写副本**，并且已**实质漂移**（不是排版差异）：SECTIONS 独有「不得干扰、
// 破坏本软件的正常运行。」「因配置错误导致的安全问题…由用户自行承担。」，
// TEXT 独有「除聊天外」「均由你自行选择与授权」，另有一处措辞冲突。而
// `disclaimer.js` 当时默认渲染 SECTIONS、却按 TEXT 记录同意 ⇒ 用户看到的那份与
// 被同意的那份不是同一份。本文件此前用 `KNOWN_DIVERGENCE.textsAreIdentical: false`
// 把这个差异"登记在案"，等一个"以哪份为准"的内容/法务决定。
//
// 决定已下：**权威源是 SECTIONS**。理由是用户实际读到、并据此勾选「同意」的就是
// 分节弹窗渲染的那份（`disclaimer.js` 默认渲染 SECTIONS）——被同意的那份必须与
// 看到的那份是同一份，否则「用户已确认本条款」这个法律效力前提不成立。
// `DISCLAIMER_TEXT` 现在由 SECTIONS 派生，因此"两份不一致"在结构上不再可能发生；
// 相应地删掉了 `KNOWN_DIVERGENCE` 那条棘轮，换成下面更硬的"逐句互查"。
//
// 取舍：条款是法律文本，用**管辖语言**（中文）书写，有意不 i18n——随界面语言翻译
// 会引入"哪个语言版本有约束力"的解释问题。故这里断言的是中文字面，不是 i18n key。
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  DISCLAIMER_TEXT,
  DISCLAIMER_SECTIONS,
  DISCLAIMER_TEXT_EN,
  DISCLAIMER_SECTIONS_EN,
  DISCLAIMER_EN_NOTICE,
} from '../src/onboarding/disclaimerContent.js';
import { DISCLAIMER_VERSION } from '../src/storage/settings/onboarding.js';

// 空白归一：只关心**文字内容**，不关心折行与拼接方式（否则纯排版改动也会红）。
const norm = value => String(value).replace(/\s+/g, ' ').trim();
// 更狠的一层归一：连空白都不要。中文条款里的空格只是中英混排的可读性空格，
// 不该让「不得擅自删除、篡改或隐匿 AI 生成标识」这类包含比对因空格差异失配。
const flat = value => String(value).replace(/\s+/g, '');
const sig = value => createHash('sha256').update(norm(value)).digest('hex').slice(0, 16);

// 权威源（SECTIONS）的完整语料：标题 + 正文 + 条目。
const SECTIONS_CORPUS = DISCLAIMER_SECTIONS
  .map(section => [section.title, section.body, ...(section.bullets || [])].join(''))
  .join('');

// ---------------------------------------------------------------------------
// 逐句互查用的工具。
//
// 为什么不整串比对：整串比对会把「段间空行怎么排」「标题前缀放不放」这类纯渲染
// 差异也算成漂移，于是测试被无关改动弄红，而真正的条款缺失反而淹没在噪声里。
// 只比对**句子集合**，既容得下排版，又能抓住任何一条实质条款的增删。
// ---------------------------------------------------------------------------
const SENTENCE_SEP = /[。；\n]/;

// 段首的「标题：」是渲染层加的，不是条款内容——比对前剥掉，
// 否则整段文本每段的首句都会因为带标题前缀而被误判成"独有"。
const stripSectionTitle = text => {
  const bare = flat(text);
  const hit = DISCLAIMER_SECTIONS.find(section => bare.startsWith(`${flat(section.title)}：`));
  return hit ? bare.slice(flat(hit.title).length + 1) : bare;
};

const clausesOf = value => String(value)
  .split(SENTENCE_SEP)
  .map(stripSectionTitle)
  .filter(Boolean);

const TEXT_CLAUSES = clausesOf(DISCLAIMER_TEXT);
const SECTION_CLAUSES = DISCLAIMER_SECTIONS.flatMap(section => (
  clausesOf([section.body, ...(section.bullets || [])].join(''))
));

// ---------------------------------------------------------------------------
// 冻结表：**条款文字变了就必须 bump DISCLAIMER_VERSION 并在这里加一行**。
//
// 为什么用"签名 + 版本号"而不是直接断言文案：文案本身是长中文，把它抄进测试
// 等于再养一份平行定义（改一处忘一处）。签名只回答"变没变"，
// 而"该不该 bump 版本"由这张表把两者绑在一起。
//
// 这是防「改了条款忘了 bump 版本」的**唯一机械保障**：条款一改签名就变，
// 版本号没跟着走就红，存量用户不会在不知情的情况下被套上新条款。
// ---------------------------------------------------------------------------
const FROZEN_BY_VERSION = {
  4: {
    text: '9a4df324e3691ba1',
    sections: '9ee4a2ff8360a855',
  },
};

test('完备性：每个分节都有非空 title 与 body，且 title 不重复', () => {
  assert.ok(Array.isArray(DISCLAIMER_SECTIONS) && DISCLAIMER_SECTIONS.length > 0);
  const seen = new Set();
  DISCLAIMER_SECTIONS.forEach((section, index) => {
    assert.equal(typeof section.title, 'string', `第 ${index + 1} 节缺 title`);
    assert.ok(norm(section.title).length > 0, `第 ${index + 1} 节的 title 为空`);
    assert.equal(typeof section.body, 'string', `第 ${index + 1} 节（${section.title}）缺 body`);
    assert.ok(norm(section.body).length > 0, `第 ${index + 1} 节（${section.title}）的 body 为空`);
    assert.ok(!seen.has(section.title), `分节标题重复：${section.title}`);
    seen.add(section.title);
  });
});

test('完备性：整段文本非空，且已包含「同意」这一终局条款', () => {
  assert.ok(norm(DISCLAIMER_TEXT).length > 0, 'DISCLAIMER_TEXT 为空');
  // 「使用即代表同意以上条款」是勾选生效的语义前提，删掉它条款就失去落点。
  assert.ok(
    norm(DISCLAIMER_TEXT).includes('使用即代表同意以上条款'),
    '整段文本里找不到「使用即代表同意以上条款」——它是勾选生效的语义前提'
  );
});

test('版本配对棘轮：条款文字变了就必须 bump DISCLAIMER_VERSION', () => {
  const frozen = FROZEN_BY_VERSION[DISCLAIMER_VERSION];
  assert.ok(
    frozen,
    `DISCLAIMER_VERSION = ${DISCLAIMER_VERSION} 在冻结表里没有条目。`
    + '若你刚 bump 了版本，请把下面两个签名填进 FROZEN_BY_VERSION 的新条目；'
    + '若是误改版本号，请改回去。'
  );

  const actualText = sig(DISCLAIMER_TEXT);
  const actualSections = sig(JSON.stringify(DISCLAIMER_SECTIONS));

  assert.equal(
    actualText,
    frozen.text,
    `DISCLAIMER_TEXT 的内容变了（版本 ${DISCLAIMER_VERSION}）。`
    + '\n条款实质变更必须 bump DISCLAIMER_VERSION（src/storage/settings/onboarding.js），'
    + '否则存量用户不会重新确认新条款——那是法律效力的前提。'
    + `\n新签名：text: '${actualText}'`
  );
  assert.equal(
    actualSections,
    frozen.sections,
    `DISCLAIMER_SECTIONS 的内容变了（版本 ${DISCLAIMER_VERSION}）。同上，需要 bump 版本。`
    + `\n新签名：sections: '${actualSections}'`
  );
});

// ---------------------------------------------------------------------------
// 防再漂移的**核心**断言：逐句互查，两个方向都查。
//
// 单向（TEXT ⊇ SECTIONS）只能保证"没漏条款"；反向（SECTIONS ⊇ TEXT）才能保证
// 整段文本里**没有夹带**分节里不存在的话——否则又会长出第三份口径。
// 两个方向合起来 = 两份是同一份条款的两种形状，这正是"单一来源"的定义。
// ---------------------------------------------------------------------------
test('单一来源：TEXT 覆盖 SECTIONS 的每一条实质条款，且不夹带分节里没有的话', () => {
  const missingInText = SECTION_CLAUSES.filter(clause => !TEXT_CLAUSES.includes(clause));
  assert.deepEqual(
    missingInText,
    [],
    '整段文本漏掉了分节里的条款（用户看到的是分节版，漏掉就意味着"被同意的文本"'
    + '与"展示的文本"不一致）：\n'
    + missingInText.map(clause => `  · ${clause}`).join('\n')
  );

  const extraInText = TEXT_CLAUSES.filter(clause => !SECTION_CLAUSES.includes(clause));
  assert.deepEqual(
    extraInText,
    [],
    '整段文本里有分节版**不存在**的条款——这会让条款重新长出第二份口径，'
    + '请把该条款并入 DISCLAIMER_SECTIONS 的对应分节（只许并入，不许只在 TEXT 里加）：\n'
    + extraInText.map(clause => `  · ${clause}`).join('\n')
  );

  // 每个分节的标题都以「标题：」的形式出现在整段文本里：证明 TEXT 是 SECTIONS 的
  // **渲染产物**，而不是另一份可以独立漂移的手写稿（手写稿不会给每节补标题前缀）。
  DISCLAIMER_SECTIONS.forEach(section => {
    assert.ok(
      flat(DISCLAIMER_TEXT).includes(`${flat(section.title)}：`),
      `整段文本里没有「${section.title}：」——TEXT 应是由 SECTIONS 渲染出来的`
    );
  });
});

// ---------------------------------------------------------------------------
// 统一口径「对用户更严格」的结果必须真的落在权威源里。
// 这是防"统一时顺手把某条删了/放宽了"的登记：法律文本只允许并入与取更严。
// ---------------------------------------------------------------------------
test('统一口径「对用户更严格」：并入与取更严的结果确实在 SECTIONS 里', () => {
  const corpus = flat(SECTIONS_CORPUS);
  const has = (clause, why) => assert.ok(
    corpus.includes(flat(clause)),
    `权威源（SECTIONS）里找不到「${clause}」。${why}`
  );

  // ① 原本只在 SECTIONS 里的两条——统一时保留，不得因为"合并"而丢。
  has('不得干扰、破坏本软件的正常运行。', '这是 SECTIONS 独有的禁止性条款，删掉就是放宽。');
  has(
    '因配置错误导致的安全问题、第三方服务中断或数据泄露，由用户自行承担。',
    '这是 SECTIONS 独有的责任分配条款，删掉就是把责任推回开发者/用户之外，属实质变更。'
  );

  // ② 措辞冲突取**更严**的一版：「商业用途」的外延比「等牟利行为」宽
  //（无直接营利的商用场景也落在禁止范围内），故保留 SECTIONS 的说法。
  has('不得将本软件用于转售、出租、出借或以此牟利等商业用途。', '这是取更严的那一版。');
  assert.ok(
    !corpus.includes(flat('不得将本软件用于转售、出租、出借等牟利行为。')),
    '更宽松的那版措辞（「等牟利行为」）不得回潮——统一只许取更严。'
  );

  // ③ 原本只在 TEXT 里的两处限定——已**并入** SECTIONS 的「数据与配置」节。
  has('除聊天外', '这处限定原本只在 TEXT 里，须并入分节。');
  has('均由你自行选择与授权', '这句原本只在 TEXT 里，须并入分节。');

  // ④ AI 生成内容标识条款（合规硬项）。核对结果：这条**两份都有**，
  // 差别仅是 TEXT 多一个主语「用户」（「用户不得擅自删除…」vs「不得擅自删除…」），
  // 语义同一，故无需并入；此处登记它确实在权威源里，防日后被删。
  has(
    '不得擅自删除、篡改或隐匿 AI 生成标识（含显式与隐式标识）后对外传播，由此产生的责任由用户自行承担。',
    'AI 生成标识是法定合规项（《人工智能生成合成内容标识办法》），删除即丧失合规落点。'
  );
});

// ---------------------------------------------------------------------------
// 英文参考译文（2026-10-24 用户裁决：应用内免责条款出双语 + 界面「简体中文/English」
// 切换按钮）。分工与中文棘轮互补：
//   · 中文是权威/管辖文本——上面那组「签名 + DISCLAIMER_VERSION」只认中文字面，
//     改中文必须 bump 版本；英文与中文同版本，**不因新增英文而 bump**。
//   · 这三钉的是英文侧自己的失守方式：
//     ① 逐节对应：节数 / 顺序 / 图标 / 要点数与中文一一对应（漏译一节或一要点即红）；
//     ② 译文完整：语料不允许残留任何中文字符（中文残留 = 漏译的机械信号），
//        且必须有「同意」终局条款与英文管辖语言提示；
//     ③ 单一来源：TEXT_EN 必须是 SECTIONS_EN 的渲染产物（每节以「标题: 」开头，
//        正文与要点全部出现在整段文本里），防止英文侧长出第二份手写口径。
// ---------------------------------------------------------------------------
const CJK = /[\u4e00-\u9fff]/;
const EN_CORPUS = DISCLAIMER_SECTIONS_EN
  .map(section => [section.title, section.body, ...(section.bullets || [])].join(''))
  .join('');

test('英文译文：与中文逐节一一对应（节数/顺序/图标/要点数）', () => {
  assert.equal(DISCLAIMER_SECTIONS_EN.length, DISCLAIMER_SECTIONS.length, '英文节数必须与中文一致');
  DISCLAIMER_SECTIONS_EN.forEach((section, index) => {
    const zh = DISCLAIMER_SECTIONS[index];
    assert.equal(section.icon, zh.icon, `第 ${index + 1} 节图标与中文不一致`);
    assert.ok(norm(section.title).length > 0, `第 ${index + 1} 节缺英文标题`);
    assert.ok(norm(section.body).length > 0, `第 ${index + 1} 节（${zh.title}）缺英文正文`);
    assert.equal(
      (section.bullets || []).length,
      (zh.bullets || []).length,
      `第 ${index + 1} 节（${zh.title}）的要点数与中文不一致`
    );
  });
});

test('英文译文：无中文残留，含「同意」终局条款与管辖语言提示', () => {
  assert.ok(!CJK.test(EN_CORPUS), '英文译文里残留中文（漏译的机械信号）');
  assert.ok(
    flat(EN_CORPUS).includes(flat('By using the app, you agree to these terms.')),
    '英文译文缺少「同意」终局条款（对应中文「使用即代表同意以上条款」）——勾选生效的语义前提'
  );
  assert.ok(
    norm(DISCLAIMER_EN_NOTICE).length > 0 && !CJK.test(DISCLAIMER_EN_NOTICE),
    '管辖语言提示必须是非空英文'
  );
});

test('英文译文单一来源：TEXT_EN 是 SECTIONS_EN 的渲染产物', () => {
  const flatText = flat(DISCLAIMER_TEXT_EN);
  DISCLAIMER_SECTIONS_EN.forEach(section => {
    assert.ok(flatText.includes(`${flat(section.title)}:`), `TEXT_EN 里没有「${section.title}:」前缀`);
    assert.ok(flatText.includes(flat(section.body)), `TEXT_EN 缺少「${section.title}」的正文`);
    (section.bullets || []).forEach(bullet => {
      assert.ok(flatText.includes(flat(bullet)), `TEXT_EN 缺少「${section.title}」的要点`);
    });
  });
});
