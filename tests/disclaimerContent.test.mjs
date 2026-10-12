// 免责条款内容域：完备性 + 「内容 ↔ 版本号」配对棘轮 + 同源双份的已知差异。
//
// 为什么需要这个文件：`src/onboarding/disclaimerContent.js` 的文件头写着两件
// **没有机械检查**的事——
//   ①「这样 Node 测试可以直接 import 校验条款完备性与章节一致性」—— 而此前**一个测试都没有**；
//   ②「条款实质变更时记得同步 bump DISCLAIMER_VERSION，否则存量用户不会重新确认新条款
//      （法律效力前提）」—— 全靠"记得"。
// 规则 3：只靠约定的不变量会被违反。这里把 ①② 都变成会红的断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { DISCLAIMER_TEXT, DISCLAIMER_SECTIONS } from '../src/onboarding/disclaimerContent.js';
import { DISCLAIMER_VERSION } from '../src/storage/settings/onboarding.js';

// 空白归一：只关心**文字内容**，不关心折行与拼接方式（否则纯排版改动也会红）。
const norm = value => String(value).replace(/\s+/g, ' ').trim();
const sig = value => createHash('sha256').update(norm(value)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// 冻结表：**条款文字变了就必须 bump DISCLAIMER_VERSION 并在这里加一行**。
//
// 为什么用"签名 + 版本号"而不是直接断言文案：文案本身是长中文，把它抄进测试
// 等于再养一份平行定义（改一处忘一处）。签名只回答"变没变"，
// 而"该不该 bump 版本"由这张表把两者绑在一起。
// ---------------------------------------------------------------------------
const FROZEN_BY_VERSION = {
  3: {
    text: '03a889602772d125',
    sections: 'c7ad8f0a10517a13',
  },
};

// ---------------------------------------------------------------------------
// 同源双份的**已知实质差异**（登记在案，不是"通过"）。
//
// `DISCLAIMER_TEXT`（整段）与 `DISCLAIMER_SECTIONS`（分节）是同一份条款的两种形状，
// 而 `disclaimer.js:13/20` 的实际行为是：默认 content 取 DISCLAIMER_TEXT，
// 但**渲染出来的却是 DISCLAIMER_SECTIONS**（`content === DISCLAIMER_TEXT ? DISCLAIMER_SECTIONS : null`）
// ⇒ **用户勾选"同意"时看到的是 SECTIONS，而应用按"已同意 TEXT"记录**。
// 两者已漂移，且差异是**实质性**的（不是排版）：
//   · SECTIONS 独有：「不得干扰、破坏本软件的正常运行。」
//   · SECTIONS 独有：「因配置错误导致的安全问题、第三方服务中断或数据泄露，由用户自行承担。」
//   · TEXT   独有：「用户不得擅自删除、篡改或隐匿 AI 生成标识（含显式与隐式标识）后对外传播…」
//   · TEXT   独有：「除聊天外」「均由你自行选择与授权」（SECTIONS 少了这两处限定）
//   · 措辞不同：「转售、出租、出借等牟利行为」vs「转售、出租、出借或以此牟利等商业用途」
//
// **这份差异需要一个"以哪份为准"的决定**（内容/法务决定，不是工程决定）。
// 在决定之前，这里把差异**冻结**：谁改动任一份，本测试就红，
// 强迫改动者面对"两份是否仍一致 / 版本号要不要 bump"。
// 决定之后：把两份统一，删除本清单，并 bump DISCLAIMER_VERSION。
// ---------------------------------------------------------------------------
const KNOWN_DIVERGENCE = {
  // 两份的归一化内容目前**不相等**。改成 false 意味着已经统一。
  textsAreIdentical: false,
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

test('同源双份：两份是否一致的现状被登记在案（改动任一份都会红）', () => {
  const fromSections = norm(DISCLAIMER_SECTIONS.map(section => (
    [section.title, section.body, ...(section.bullets || [])].join(' ')
  )).join(' '));
  const identical = fromSections === norm(DISCLAIMER_TEXT);

  assert.equal(
    identical,
    KNOWN_DIVERGENCE.textsAreIdentical,
    identical
      ? '两份现在**一致**了——很好，请把 KNOWN_DIVERGENCE.textsAreIdentical 改成 true，'
        + '并删除本文件头「已知实质差异」那段注释（它已过期）。'
      : '两份现在**不一致**（这是已登记的现状）。若你刚改动其中一份，请确认：'
        + '另一份要不要同步？用户实际看到的是 SECTIONS（见 disclaimer.js:13/20），'
        + '而应用按 TEXT 记录同意——两者不一致时，被同意的那份与看到的那份不是同一份。'
  );
});
