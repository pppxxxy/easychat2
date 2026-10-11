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
// 不计入：注释（AST 只看字面量）、console.*/诊断日志（不算用户可见）、正则字面量、
// 未导出的模块内部常量（多为匹配用关键词或模型提示词，不是给用户看的文案）。
//
// 仍不覆盖（已知盲区，靠 review）：函数体内未导出的字符串常量、Alert 按钮配置对象
// 内的文案（{ text: '取消' }）、setNotice 类提示的实参、非导出对象/数组里的中文字面量。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function hasChinese(value) {
  return typeof value === 'string' && CJK.test(value);
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

// 收集一段 AST 子树里所有含中文的字符串字面量（含对象属性值/数组元素）。
// 正则字面量的 value 是 RegExp 对象而非字符串，天然不计入。
function collectChineseLiterals(root, found) {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) {
    root.forEach(item => collectChineseLiterals(item, found));
    return;
  }
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
    docs: { description: '禁止在 JSX 正文与模块级导出常量里硬编码中文（应走 i18n t()）' },
    messages: MESSAGES,
  },
  create(context) {
    return {
      // JSX 正文里的中文（<Text>你好</Text>）。JSXText 会带上缩进空白，只挑含中文的。
      JSXText(node) {
        if (hasChinese(node.value)) {
          context.report({ node, messageId: 'hardcodedJsx' });
        }
      },
      // 模块级**导出**常量：export const X = '中文' / export const M = { a: '中文' }。
      VariableDeclaration(node) {
        if (!node.parent || node.parent.type !== 'ExportNamedDeclaration') return;
        for (const declarator of node.declarations) {
          const found = [];
          collectChineseLiterals(declarator.init, found);
          found.forEach(literal => context.report({ node: literal, messageId: 'hardcodedConst' }));
        }
      },
    };
  },
};

export default noHardcodedChinese;
