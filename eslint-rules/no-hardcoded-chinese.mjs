// 自定义 ESLint 规则：禁止把中文文案硬编码进「会展示给用户」的地方。
//
// 背景：i18n 框架已就位（zh-CN/en 双语言），但用户可见文案仍有数百处硬编码中文，
// 英文用户会看到中英混排。靠人工 review 拦不住（新代码会继续加），所以做成可机检的
// 门禁——与 guard:structure 同一思路：先把「新债」冻住，存量按清单分批迁移。
//
// 本文件导出**两条规则**，各自带独立的存量冻结清单（互不影响，各自只减不增）：
//
//   noHardcodedChinese（首版口径）
//     1. Alert.alert(...) 的所有字符串参数
//     2. throw new Error('中文')（NewExpression + ThrowStatement）
//     说明：`new Error` 在 AST 里是 NewExpression 而非 CallExpression——写成
//     CallExpression 匹配会静默漏掉全部 throw（本规则首版即栽在此，注入验证抓出）。
//
//   noHardcodedChineseText（2026-10-11 扩展，补首版最大的两个盲区）
//     3. JSXText——JSX 里直接写的中文正文（<Text>你好</Text>）
//     4. 模块级**导出**常量的字符串字面量（export const X = '中文' / { a: '中文' }）：
//        模块级常量会被渲染层直接读走，是首版最大的盲区（chatConstants.js 的
//        THINKING_PLACEHOLDER / AI_DISCLAIMER_TEXT / THINKING_LEVEL_LABELS 即此形态）。
//
//   noHardcodedChineseText 第三批扩展（2026-10-12，补「规则看不见」的形态盲区）
//     5. 数组 join() 的中文分隔符：`list.join('、')`——英文界面下预览/导出会混入中文
//        标点（src/extension/schedule/preview.js、CardForgeEditor.js 即此形态）。
//     6. 函数返回的**对象字面量**里的中文：`return { label: '内存未知' }`——调用方
//        （ModelCard.js / AcquireSection.js）把 label 直接拼进英文句子。
//     7. 模块级**非导出**常量：`const FIELD_LABELS = { name: '角色名' }`——不导出也一样
//        能被同仓模块 import 走、照样渲染到界面上（实测 139 处 / 18 文件）。
//        判据是「模块级」＝**祖先里没有函数**，而不是「parent 恰好是 Program」，
//        这样模块顶层的 if/for 块里的常量也算。
//        ⚠️ **函数体内的普通字符串常量仍然有意不覆盖**（imageDescriptionPrompt.js
//        记录过这条口径：函数体里的中文绝大多数是模型提示词）——所以同一个
//        `const x = '中文'`：写在函数里不报，写在模块顶层报。这两者是**故意**分开的。
//     8. 中文标点也计入（见 CJK_PUNCT）。
//
// ⚠️ 为什么中文标点**必须**纳入匹配（本次最有价值的发现）：`join('、')` 里一个汉字都
//    没有，只查汉字（\u4e00-\u9fff 等）会**整类**漏掉。同一份代码实测：只查汉字时
//    join() 命中 **1 处 / 1 文件**，纳入标点后 **61 处 / 34 文件**——差 60 倍。这不是
//    「多报」，是原本整类看不见。对既有检测的影响可忽略：首批规则 +0，
//    JSXText/导出常量 +1（src/TranscriptionPanel.js 的 JSX 全角冒号）。
//    刻意**不含**全角字母数字（Ａ-ｚ＝\uff21-\uff5a、０-９＝\uff10-\uff19）：它们在英文
//    界面里同样不该出现，但把它们当「中文文案」报会误伤（例如用全角数字对齐的日志），
//    而本规则只对「中文文案」负责——宁可少报一类，也不要制造噪音。
//
// ⚠️ 已知盲区（下一个人需要知道，**别以为模板串已被覆盖**）：
//    **模板串里的中文仍不覆盖**。`${x}` 形式的模板串与模型提示词在 AST 上**同形**，
//    没有简单形态判据能把两者分开。实测模板串命中 384 处 / 94 文件，约六成（≈237 处）
//    落在模型提示词 / agent 内部工具文案文件里，且散在 9 棵树 ≈50 个文件
//    （src/workspace|chat|moments|books|music|diary|prompt|agent|imageGen），
//    **不只是** src/prompt/** 与 src/agent/**（「目录」不能当「用途」的代理信号）。
//    试过窄化成「单行且 ≤40 字」（赌长模板=提示词）：仍有 **257 处 / 84 文件**，几乎
//    没降 ⇒ 放弃。因此下面两处**用户可见**中文至今对规则不可见，只能靠 review：
//      · src/cardForge/forge/advanced.js:139/166 —— `正则脚本 ${i + 1}` / `预设 ${i + 1}`
//        （写进卡片数据、编辑器当标题显示）；
//      · src/localModel/modelParams.js:90 —— `需要在 ${min}~${max} 之间`（表单校验提示）。
//    要覆盖它们得做「上下文感知」（例如只报被赋给卡片数据字段的模板串），属独立一批。
//
// 第三批**实测后放弃**的候选（只剩一条，见 eslint.config.mjs 的注释）：
//     - 模板串里的中文（数据见上面的「已知盲区」）。只登记在报告里，不写成规则——
//       写进去等于给清单塞 ~100 行「其实不该迁」的条目。
//
// 不计入：注释（AST 只看字面量）、console.*/诊断日志（不算用户可见）、正则字面量。
//
// 仍不覆盖（已知盲区，靠 review）：模板串（见上）、函数体内的普通字符串常量、
// Alert 按钮配置对象内的文案（{ text: '取消' }）、setNotice 类提示的实参。

// 汉字（含扩展 A 区与兼容区）。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 中文标点与全角标点：CJK 符号区（、。〈〉「」…）＋ 全角标点（，：；！？（）｜）＋ 全角空格。
// 刻意不含全角字母数字（Ａ-ｚ＝\uff21-\uff3a/\uff41-\uff5a、０-９＝\uff10-\uff19），
// 理由见文件头「为什么中文标点必须纳入匹配」。
const CJK_PUNCT = /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/;

function hasChinese(value) {
  return typeof value === 'string' && (CJK.test(value) || CJK_PUNCT.test(value));
}

function isChineseLiteral(node) {
  return node && node.type === 'Literal' && hasChinese(node.value);
}

function isAlertCall(node) {
  return (
    node.type === 'CallExpression'
    && node.callee
    && node.callee.type === 'MemberExpression'
    && node.callee.object
    && node.callee.object.name === 'Alert'
    && node.callee.property
    && node.callee.property.name === 'alert'
  );
}

// throw new Error('中文')：只统计「被抛出」的构造（直接 throw）。
// 作为值传递的 new Error（如错误工厂内部）由调用点决定是否用户可见，不在此列。
function isThrownErrorConstruction(node) {
  return (
    node.type === 'NewExpression'
    && node.callee
    && node.callee.type === 'Identifier'
    && node.callee.name === 'Error'
    && node.parent
    && node.parent.type === 'ThrowStatement'
  );
}

// 数组 join('、')：只看字面量分隔符（join(sep) 变量是调用方的事，不在此列）。
function isJoinCall(node) {
  return (
    node.type === 'CallExpression'
    && node.callee
    && node.callee.type === 'MemberExpression'
    && node.callee.property
    && node.callee.property.name === 'join'
  );
}

// 是否处在**任何函数体**内（含箭头函数、对象方法、类方法、static 块）。
// 用途：把「模块级常量」与「函数体内的常量」分开——后者有意不覆盖（见文件头注释）。
// 判据刻意用「祖先里没有函数」而不是「parent 恰好是 Program」：模块顶层的
// `if (x) { const A = '中文'; }` 同样是模块级数据，不该漏。
const FUNCTION_SCOPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'StaticBlock',
]);
function insideFunctionScope(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (FUNCTION_SCOPES.has(cur.type)) return true;
  }
  return false;
}

// 收集一段 AST 子树里所有含中文的字符串字面量（含对象属性值/数组元素）。
// 正则字面量的 value 是 RegExp 对象而非字符串，天然不计入。
//
// ⚠️ **不下钻函数体**：`const build = () => { const label = '取消'; }` 这种形态里，
// 中文虽然在「模块级常量」的 init 子树内，但它落在函数体里——按本规则「函数体内的
// 普通字符串常量有意不覆盖」的口径，必须跳过；否则上面那条豁免会被外层常量的递归
// 悄悄绕过（`insideFunctionScope` 只看声明自身的位置，看不到这一点）。
function collectChineseLiterals(root, found) {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) {
    root.forEach(item => collectChineseLiterals(item, found));
    return;
  }
  if (FUNCTION_SCOPES.has(root.type)) return;
  if (root.type === 'Literal') {
    if (isChineseLiteral(root)) found.push(root);
    return;
  }
  for (const key of Object.keys(root)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const child = root[key];
    if (child && typeof child === 'object') collectChineseLiterals(child, found);
  }
}

const MESSAGES = {
  hardcoded: '用户可见文案不得硬编码中文，请走 i18n：t(\'<key>\')（见 src/i18n/locales/）。',
  hardcodedJsx: 'JSX 正文不得硬编码中文，请走 i18n：t(\'<key>\')（见 src/i18n/locales/）。',
  hardcodedConst: '模块级导出常量不得硬编码中文文案，请改导出 i18n key，由渲染层 t(key) 取值。',
  hardcodedModuleConst: '模块级常量不得硬编码中文文案（不导出也一样会被渲染层读走），请改存 i18n key，由使用处 t(key) 取值。',
  hardcodedJoin: 'join() 的分隔符不得硬编码中文标点（英文界面下会混入中文），请走 i18n 的列表分隔符 key。',
  hardcodedReturnObject: '函数返回的对象字面量里不得硬编码中文文案（多为被渲染层直接展示的 label/错误信息），请改返回 i18n key，由调用方 t(key) 取值。',
};

export const noHardcodedChinese = {
  meta: {
    type: 'problem',
    docs: { description: '禁止在 Alert/Error 文案中硬编码中文（应走 i18n t()）' },
    messages: MESSAGES,
  },
  create(context) {
    const reportChineseArgs = node => {
      for (const arg of node.arguments) {
        if (isChineseLiteral(arg)) {
          context.report({ node: arg, messageId: 'hardcoded' });
        }
      }
    };
    return {
      CallExpression(node) {
        if (isAlertCall(node)) reportChineseArgs(node);
      },
      NewExpression(node) {
        if (isThrownErrorConstruction(node)) reportChineseArgs(node);
      },
    };
  },
};

export const noHardcodedChineseText = {
  meta: {
    type: 'problem',
    docs: { description: '禁止在 JSX 正文、模块级常量（含非导出）、join() 分隔符与返回对象字面量里硬编码中文（应走 i18n t()）' },
    messages: MESSAGES,
  },
  create(context) {
    // 同一个字面量可能同时落在两种形态里（`return { sep: x.join('、') }`、
    // `export const SEP = x.join('、')`）：按节点去重，一处只报一次，
    // 否则冻结清单会以为多了一处、实际是同一处被两条路径各报一遍。
    const reported = new Set();
    const reportOnce = (node, messageId) => {
      if (reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId });
    };

    return {
      // JSX 正文里的中文（<Text>你好</Text>）。JSXText 会带上缩进空白，只挑含中文的。
      JSXText(node) {
        if (hasChinese(node.value)) {
          reportOnce(node, 'hardcodedJsx');
        }
      },
      // 模块级常量：export const X = '中文' / export const M = { a: '中文' }，
      // 以及**非导出**的 const FIELD_LABELS = { name: '角色名' }（不导出也一样能被
      // 同仓模块 import 走、照样渲染到界面上）。
      // 只认「模块级」：函数体内的普通字符串常量有意不覆盖——那里面绝大多数是模型
      // 提示词（imageDescriptionPrompt.js 记录过这条口径），实测塞进来只会是噪音。
      VariableDeclaration(node) {
        const exported = Boolean(node.parent) && node.parent.type === 'ExportNamedDeclaration';
        if (!exported && insideFunctionScope(node)) return;
        const messageId = exported ? 'hardcodedConst' : 'hardcodedModuleConst';
        for (const declarator of node.declarations) {
          const found = [];
          collectChineseLiterals(declarator.init, found);
          found.forEach(literal => reportOnce(literal, messageId));
        }
      },
      // join() 的中文分隔符：list.join('、') / list.join('　')。
      CallExpression(node) {
        if (!isJoinCall(node)) return;
        for (const arg of node.arguments) {
          if (isChineseLiteral(arg)) reportOnce(arg, 'hardcodedJoin');
        }
      },
      // 函数返回的对象字面量：return { tier, label: '内存未知' }。
      // 只认「直接返回的对象字面量」，不认函数体内的普通字符串常量——
      // 后者绝大多数是模型提示词（imageDescriptionPrompt.js 一类），有意不覆盖。
      ReturnStatement(node) {
        if (!node.argument || node.argument.type !== 'ObjectExpression') return;
        const found = [];
        collectChineseLiterals(node.argument, found);
        found.forEach(literal => reportOnce(literal, 'hardcodedReturnObject'));
      },
    };
  },
};

export default noHardcodedChinese;
