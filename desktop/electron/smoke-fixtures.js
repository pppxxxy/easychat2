// 冒烟夹具（仅 EASYCHAT2_DESKTOP_SMOKE=1 时使用）：mock 模型回复正文。
//
// 这些中文是**测试数据**（模拟模型输出），不是界面文案，不进 i18n、也不随界面语言
// 切换——同 src/workspace/toolDefs/** 的模型提示词口径。因此本文件在 i18n 规则的
// ignores 里永久豁免；新增冒烟夹具请加在这里，而不是塞回 main.js。
export const SMOKE_REPLY = '桌面流式回复 OK';

export const MARKDOWN_SMOKE_REPLY = [
  '**加粗OK**',
  '',
  '- 列表甲',
  '- 列表乙',
  '',
  '```js',
  'const smoke = 1;',
  '```',
].join(String.fromCharCode(10));

export const RICH_HTML_SMOKE_REPLY = [
  '<style>.smoke-card{background:#123456;color:#ffffff;padding:12px;border-radius:8px;}</style>',
  '<div class="smoke-card" id="smoke-card"><strong>富 HTML OK</strong></div>',
  '<details id="smoke-details"><summary>展开</summary><p>折叠内容</p></details>',
  '<button id="smoke-button" onclick="triggerSlash(\'/send 卡片命令\')">卡片命令按钮</button>',
  '<script>window.__smokePwned = true;</script>',
].join(String.fromCharCode(10));
