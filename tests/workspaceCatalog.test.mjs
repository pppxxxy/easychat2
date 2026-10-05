// 环境与配置下载中心：目录纯数据测试 + 面板/设置页接线源码断言 + paths 白名单扩展。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CATALOG_CATEGORIES, CATALOG_ITEMS, buildCatalogContent, findCatalogItem } from '../src/workspace/catalog.js';
import { isAllowedWorkspaceFile, isAllowedWorkspaceOutputFile } from '../src/workspace/paths.js';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('目录：id/文件名唯一，内容或生成函数必有其一，文件名必须在写入白名单内', () => {
  const ids = CATALOG_ITEMS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复');
  const files = CATALOG_ITEMS.map(item => item.file);
  assert.equal(new Set(files).size, files.length, '目标文件名不得重复');
  for (const item of CATALOG_ITEMS) {
    assert.ok(CATALOG_CATEGORIES.includes(item.category), `分类非法：${item.category}`);
    assert.ok(typeof item.content === 'string' || typeof item.build === 'function', `${item.id} 缺内容`);
    assert.ok(item.titleKey && item.descKey, `${item.id} 缺词条键`);
    assert.ok(
      isAllowedWorkspaceOutputFile(item.file),
      `${item.file} 必须在 paths.js 写入白名单内（否则下载中心写不进沙盒）`
    );
    assert.ok(isAllowedWorkspaceFile(item.file));
  }
});

test('生成器：.gitconfig 吃输入，留空落占位值；静态项返回内置内容', () => {
  const gitconfig = findCatalogItem('gitconfig');
  const filled = buildCatalogContent(gitconfig, { userName: 'zh', userEmail: 'zh@example.com' });
  assert.match(filled, /name = zh/);
  assert.match(filled, /email = zh@example\.com/);
  const empty = buildCatalogContent(gitconfig, {});
  assert.match(empty, /name = 你的名字/);
  const gitignore = findCatalogItem('gitignore');
  assert.match(buildCatalogContent(gitignore, {}), /node_modules\//);
  assert.throws(() => buildCatalogContent(null, {}), /catalog item/);
});

test('paths 黑名单（m1005m2 合并后的语义）：目录文件全部可写，二进制仍拒绝', () => {
  // 合并裁决：工作区文本写入采用二进制黑名单（m1005m2 的「可写项目」模型），
  // 它覆盖了下载中心全部目标文件（点文件/无扩展名/非白名单扩展名都是文本）。
  for (const name of ['.gitignore', '.gitconfig', '.npmrc', 'pip.conf', '.editorconfig']) {
    assert.equal(isAllowedWorkspaceFile(name), true, name);
    assert.equal(isAllowedWorkspaceOutputFile(name), true, name);
  }
  assert.equal(isAllowedWorkspaceFile('src/app.js'), true, '源码可写（项目化）');
  assert.equal(isAllowedWorkspaceFile('Makefile'), true, '无扩展名文本可写');
  assert.equal(isAllowedWorkspaceFile('logo.png'), false, '图片是二进制');
  assert.equal(isAllowedWorkspaceFile('backup.zip'), false, '压缩包是二进制');
  assert.equal(isAllowedWorkspaceOutputFile('report.docx'), true, 'docx 仍只写不读');
});

test('面板接线：下载中心入口/写入走 store/自定义下载的三道闸', () => {
  const source = readSource('src/WorkspacePanel.js');
  assert.ok(source.includes("t('workspace.panel.catalog.entry')"), '动作行有下载中心入口');
  assert.ok(source.includes('store.writeWorkspaceFile({ characterId, path, content })'), '写入与手写同一路径（自动进历史改动）');
  // 自定义下载的三道闸：https、512KB 上限、命名清洗
  assert.ok(source.includes('/^https:\\/\\//.test(url)'), '仅 https');
  assert.ok(source.includes('512 * 1024'), '大小上限');
  assert.ok(source.includes('isAllowedWorkspaceOutputFile(rawName)'), '白名单名原样保留，其余清洗');
});

test('设置页接线：PAT 与网页认证两条路 + 断开 + 错误码映射', () => {
  const source = readSource('src/SettingsScreen.js');
  assert.ok(source.includes('connectGithubMcpWithToken'), '连接入口');
  assert.ok(source.includes('runOAuthWebFlow'), '网页认证流');
  assert.ok(source.includes('captureOAuthCallback()'), '回调捕获');
  assert.ok(source.includes("redirectUri: GITHUB_OAUTH_REDIRECT"), '回调走 app scheme');
  assert.ok(source.includes('clearGithubMcpCredentials'), '断开清理');
  assert.ok(source.includes('GITHUB_ERROR_KEYS'), '错误码 → t() 映射表存在');
});

test('OAuth 回跳依赖 app.json 的 scheme（深链回调的载体）', () => {
  const appJson = JSON.parse(readSource('app.json'));
  assert.equal(appJson.expo.scheme, 'easychat2');
  const bridge = readSource('src/mcp/oauthBridge.js');
  assert.ok(bridge.includes("GITHUB_OAUTH_REDIRECT = 'easychat2://github-mcp-callback'"), '回跳 URI 与 scheme 对齐');
});
