// 工作区模板（空白 / Python / 静态网页）测试（spec: 2026-10-09-agent-extensibility T9）。
//
// 覆盖：① 模板结构自检（id 唯一、路径合法、内容非空且有可识别特征）；
// ② 安装幂等（全创建 / 全跳过 / 部分补齐 / 写失败计入 failed 不中断）；
// ③ 非法输入安全降级；④ 接线契约（设置面板行、ChatPanel 转发、i18n 中英）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TEMPLATE_IDS,
  WORKSPACE_TEMPLATES,
  getWorkspaceTemplate,
  installWorkspaceTemplate,
} from '../src/workspace/templates.js';

function makeStore(files = {}, { failWrite = [] } = {}) {
  return {
    files,
    async readWorkspaceFile({ path: file }) {
      if (!(file in files)) throw new Error('fileNotFound');
      return { content: files[file] };
    },
    async writeWorkspaceFile({ path: file, content }) {
      if (failWrite.includes(file)) throw new Error('write failed');
      files[file] = content;
      return { path: file };
    },
  };
}

test('模板结构：3 套、id 唯一且与清单一致、路径合法（相对且无 ..）、内容非空', () => {
  assert.deepEqual(TEMPLATE_IDS, ['blank', 'python', 'web']);
  assert.equal(WORKSPACE_TEMPLATES.length, TEMPLATE_IDS.length);
  assert.deepEqual(WORKSPACE_TEMPLATES.map(item => item.id), [...TEMPLATE_IDS]);
  for (const template of WORKSPACE_TEMPLATES) {
    assert.ok(template.nameKey.startsWith('workspace.templates.'), '名称走词条（界面文案）');
    assert.ok(template.descriptionKey.startsWith('workspace.templates.'));
    assert.ok(template.files.length >= 1, `${template.id} 至少要有一个文件`);
    for (const file of template.files) {
      assert.equal(file.path.startsWith('/'), false, `${file.path} 必须是相对路径`);
      assert.equal(file.path.includes('..'), false, `${file.path} 不得含 ..`);
      assert.ok(String(file.content || '').trim().length > 0, `${file.path} 内容不得为空`);
    }
  }
  assert.equal(getWorkspaceTemplate('nope'), null);
  assert.equal(getWorkspaceTemplate('python').id, 'python');
});

test('模板内容可识别：Python 能跑、网页三件套齐全、README 交代用法', () => {
  const python = getWorkspaceTemplate('python');
  const paths = python.files.map(item => item.path);
  assert.deepEqual(paths.sort(), ['.gitignore', 'README.md', 'main.py', 'requirements.txt'].sort());
  const main = python.files.find(item => item.path === 'main.py').content;
  assert.ok(main.includes('def main()') && main.includes('__main__'), 'Python 模板要能直接运行');
  assert.ok(
    python.files.find(item => item.path === 'requirements.txt').content.includes('没有运行时 pip'),
    '依赖说明必须如实（手机端 Python 无运行时 pip）'
  );

  const web = getWorkspaceTemplate('web');
  const webPaths = web.files.map(item => item.path);
  for (const name of ['index.html', 'style.css', 'script.js']) {
    assert.ok(webPaths.includes(name), `网页模板缺 ${name}`);
  }
  assert.ok(web.files.find(item => item.path === 'index.html').content.includes('<html'));
  assert.ok(web.files.find(item => item.path === 'index.html').content.includes('script.js'), 'HTML 要引用脚本');

  assert.ok(getWorkspaceTemplate('blank').files[0].path === 'README.md');
});

test('安装：首次全部创建；再次全部跳过（绝不覆盖用户改过的内容）', async () => {
  const files = {};
  const store = makeStore(files);
  const first = await installWorkspaceTemplate(store, 'c1', 'python');
  assert.deepEqual(first.created.sort(), ['main.py', 'requirements.txt', '.gitignore', 'README.md'].sort());
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(first.failed, []);

  files['main.py'] = '# 用户改过的入口';
  const second = await installWorkspaceTemplate(store, 'c1', 'python');
  assert.deepEqual(second.created, []);
  assert.equal(second.skipped.length, 4);
  assert.equal(files['main.py'], '# 用户改过的入口', '已有文件绝不覆盖');
});

test('安装：部分存在只补缺的；单个文件写失败计入 failed 且不中断其余文件', async () => {
  const files = { 'main.py': '已有' };
  const store = makeStore(files);
  const partial = await installWorkspaceTemplate(store, 'c1', 'python');
  assert.deepEqual(partial.skipped, ['main.py']);
  assert.equal(partial.created.length, 3);

  const failStore = makeStore({}, { failWrite: ['style.css'] });
  const withFailure = await installWorkspaceTemplate(failStore, 'c1', 'web');
  assert.deepEqual(withFailure.failed, ['style.css']);
  assert.equal(withFailure.created.length, 3, '一个失败不影响其它文件');
});

test('非法输入安全降级：未知模板 / 无 store / 无写入能力 → 空结果不抛错', async () => {
  const store = makeStore({});
  const unknown = await installWorkspaceTemplate(store, 'c1', 'nope');
  assert.deepEqual(unknown, { templateId: 'nope', created: [], skipped: [], failed: [] });
  assert.deepEqual(await installWorkspaceTemplate(null, 'c1', 'blank'), { templateId: 'blank', created: [], skipped: [], failed: [] });
  assert.deepEqual(await installWorkspaceTemplate({}, 'c1', 'blank'), { templateId: 'blank', created: [], skipped: [], failed: [] });
});

test('接线契约：设置面板有模板行与创建按钮；ChatPanel 转发安装；i18n 中英齐', () => {
  const sheet = fs.readFileSync(path.resolve('src/workspace/WorkspaceSettingsSheet.js'), 'utf8');
  assert.ok(sheet.includes("id: 'templates'"), '设置面板有模板行');
  assert.ok(sheet.includes('WORKSPACE_TEMPLATES.map'), '展开区列出三套模板');
  assert.ok(sheet.includes('onInstallTemplate(template.id)'), '创建按钮转发模板 id');

  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(panel.includes('installWorkspaceTemplate(storeRef.current, characterId, templateId)'), '安装走工作区 store');
  assert.ok(panel.includes('onInstallTemplate={handleInstallTemplate}'), '回调接线');

  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/workspace.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/workspace.js'), 'utf8');
  for (const key of [
    "'workspace.settings.templates'",
    "'workspace.templates.blank.name'",
    "'workspace.templates.python.name'",
    "'workspace.templates.web.name'",
    "'workspace.settings.templates.done'",
  ]) {
    assert.ok(zh.includes(key), `中文缺 ${key}`);
    assert.ok(en.includes(key), `英文缺 ${key}`);
  }
  // 模板文件内容不进词条表（是项目文件，不是界面文案）——词条里不应出现模板正文特征串
  assert.equal(zh.includes('Hello from EasyChat2'), false);
});
