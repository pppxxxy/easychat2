// 自定义 ESLint 规则：禁止把中文文案硬编码进「会展示给用户」的调用点。
//
// 背景：i18n 框架已就位（zh-CN/en 双语言），但 Alert.alert / throw new Error
// 的用户可见文案仍有数百处硬编码中文，英文用户会看到中英混排。靠人工 review
// 拦不住（新代码会继续加），所以做成可机检的门禁——与 guard:structure 同一思路：
// 先把「新债」冻住，存量按清单分批迁移。
//
// 判定：以下调用点的字符串字面量含 CJK 即报错
//   - Alert.alert(...) 的所有字符串参数
//   - throw new Error('中文')（NewExpression + ThrowStatement）
// 不计入：注释（AST 只看字面量）、console.*/诊断日志（不算用户可见）。
// 说明：`new Error` 在 AST 里是 NewExpression 而非 CallExpression——写成
// CallExpression 匹配会静默漏掉全部 throw（本规则首版即栽在此，注入验证抓出）。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function isChineseLiteral(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string' && CJK.test(node.value);
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

export default {
  meta: {
    type: 'problem',
    docs: {
      description: '禁止在 Alert/Error 文案中硬编码中文（应走 i18n t()）',
    },
    messages: {
      hardcoded: '用户可见文案不得硬编码中文，请走 i18n：t(\'<key>\')（见 src/i18n/locales/）。',
    },
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
