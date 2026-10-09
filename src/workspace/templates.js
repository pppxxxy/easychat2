// 工作区模板（spec 2026-10-09-agent-extensibility T9，收官项）：
// 一键给工作区铺一套起始文件——空白（文档/笔记起点）、Python 脚本、静态网页。
//
// 与「环境配置」（catalog.js 的 .gitignore/.gitconfig 等工程配置）互补：
// 那边是"配置文件模板"，这边是"项目脚手架"。
//
// 安装语义：**幂等且绝不覆盖**——已存在的文件一律跳过（用户或 agent 改过的内容
// 就是它存在的意义），返回值区分 created / skipped / failed 让界面如实汇报，
// 不做"一键覆盖重装"这种会毁掉劳动成果的便利。
//
// 模板文件内容是**项目文件**（用户随后自由编辑），与示例技能/命令同款处理：
// 不进 i18n 词条表；只有模板名与描述（界面文案）走词条。

export const TEMPLATE_IDS = Object.freeze(['blank', 'python', 'web']);

export const WORKSPACE_TEMPLATES = Object.freeze([
  {
    id: 'blank',
    nameKey: 'workspace.templates.blank.name',
    descriptionKey: 'workspace.templates.blank.description',
    files: [
      {
        path: 'README.md',
        content: [
          '# 工作区',
          '',
          '这是你和助手共用的文件空间：助手在「可改」模式下能读写这里的文件，',
          '命令执行（run_shell）与 Python（run_python）也都在这个目录里跑。',
          '',
          '## 怎么用',
          '',
          '- 把资料丢进来（面板上的导入按钮），然后让助手整理；',
          '- 需要一套项目骨架时，去「工作区设置 → 工作区模板」选 Python 或静态网页；',
          '- 长期约定写进 `AGENTS.md`，助手每轮都会读到。',
          '',
          '（这个文件可以随意删改。）',
          '',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'python',
    nameKey: 'workspace.templates.python.name',
    descriptionKey: 'workspace.templates.python.description',
    files: [
      {
        path: 'main.py',
        content: [
          '"""项目入口：让助手「运行 main.py」，或自己在终端执行 python main.py。"""',
          '',
          '',
          'def main():',
          '    print("Hello from EasyChat2 工作区")',
          '',
          '',
          'if __name__ == "__main__":',
          '    main()',
          '',
        ].join('\n'),
      },
      {
        path: 'requirements.txt',
        content: [
          '# 依赖清单（记录用）。',
          '# 注意：手机端 Python（Chaquopy）没有运行时 pip，这里列出的库不会自动安装；',
          '# 能直接 from ... import 的是打包进 APK 的那批常用库（标准库、requests、numpy 等）。',
          '',
        ].join('\n'),
      },
      {
        path: '.gitignore',
        content: [
          '__pycache__/',
          '*.pyc',
          '.venv/',
          '',
        ].join('\n'),
      },
      {
        path: 'README.md',
        content: [
          '# Python 项目',
          '',
          '## 怎么跑',
          '',
          '- 让助手「运行 main.py」，或自己进终端执行 `python main.py`；',
          '- 依赖写进 `requirements.txt`（手机端没有运行时 pip，见文件里的说明）。',
          '',
          '## 结构',
          '',
          '- `main.py` — 入口',
          '- `requirements.txt` — 依赖清单',
          '',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'web',
    nameKey: 'workspace.templates.web.name',
    descriptionKey: 'workspace.templates.web.description',
    files: [
      {
        path: 'index.html',
        content: [
          '<!DOCTYPE html>',
          '<html lang="zh-CN">',
          '<head>',
          '  <meta charset="utf-8" />',
          '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
          '  <title>我的网页</title>',
          '  <link rel="stylesheet" href="style.css" />',
          '</head>',
          '<body>',
          '  <main class="card">',
          '    <h1 id="title">你好，世界</h1>',
          '    <p>点下面的按钮试试。</p>',
          '    <button id="action">点我</button>',
          '  </main>',
          '  <script src="script.js"></script>',
          '</body>',
          '</html>',
          '',
        ].join('\n'),
      },
      {
        path: 'style.css',
        content: [
          ':root {',
          '  color-scheme: light dark;',
          '  --bg: #f6f7fb;',
          '  --fg: #1d1d1f;',
          '  --accent: #4c6fff;',
          '}',
          '',
          '* { box-sizing: border-box; }',
          '',
          'body {',
          '  margin: 0;',
          '  min-height: 100vh;',
          '  display: grid;',
          '  place-items: center;',
          '  background: var(--bg);',
          '  color: var(--fg);',
          '  font-family: system-ui, -apple-system, "Noto Sans SC", sans-serif;',
          '}',
          '',
          '.card {',
          '  padding: 32px 28px;',
          '  border-radius: 16px;',
          '  background: #fff;',
          '  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);',
          '  text-align: center;',
          '}',
          '',
          'button {',
          '  margin-top: 12px;',
          '  padding: 10px 18px;',
          '  border: 0;',
          '  border-radius: 10px;',
          '  background: var(--accent);',
          '  color: #fff;',
          '  font-size: 15px;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'script.js',
        content: [
          "const button = document.getElementById('action');",
          'let count = 0;',
          '',
          "button.addEventListener('click', () => {",
          '  count += 1;',
          "  document.getElementById('title').textContent = `点了 ${count} 次`;",
          '});',
          '',
        ].join('\n'),
      },
      {
        path: 'README.md',
        content: [
          '# 静态网页',
          '',
          '- 用手机浏览器直接打开 `index.html`，或让助手改完再预览；',
          '- 三个文件各管一摊：结构（html）/ 样式（css）/ 交互（js）。',
          '',
        ].join('\n'),
      },
    ],
  },
]);

export function getWorkspaceTemplate(id) {
  const wanted = String(id || '').trim();
  return WORKSPACE_TEMPLATES.find(item => item.id === wanted) || null;
}

// IO：安装模板（幂等：已有文件跳过，绝不覆盖）。单个文件写失败计入 failed 继续装别的
// ——模板是增强项，一个失败不该让整次安装停摆。
export async function installWorkspaceTemplate(store, characterId, templateId) {
  const template = getWorkspaceTemplate(templateId);
  const result = { templateId: template ? template.id : String(templateId || ''), created: [], skipped: [], failed: [] };
  if (!template || !store || typeof store.writeWorkspaceFile !== 'function') return result;
  for (const file of template.files) {
    let exists = false;
    if (typeof store.readWorkspaceFile === 'function') {
      try {
        await store.readWorkspaceFile({ characterId, path: file.path });
        exists = true;
      } catch (error) {
        exists = false;
      }
    }
    if (exists) {
      result.skipped.push(file.path);
      continue;
    }
    try {
      await store.writeWorkspaceFile({ characterId, path: file.path, content: file.content });
      result.created.push(file.path);
    } catch (error) {
      result.failed.push(file.path);
    }
  }
  return result;
}
