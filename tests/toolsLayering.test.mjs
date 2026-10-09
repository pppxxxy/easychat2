// 工具定义分层测试（质量建议 ① 的验收）。
//
// 拆分的意义全在「加载代价」上：加载工作区工具定义（tools.js）不该拖进
// Word 导出的 fflate、子代理背后的网络链路、原生桥……验证方式是把这些依赖
// 在加载器里**变成炸弹**——谁还敢静态引用它，加载就会炸。
// （本地 node_modules 齐全时「能加载」证明不了任何事；装了炸弹才证明。）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const SRC_DIR = path.resolve('src');

// 这些依赖在「工具定义」的加载路径上出现 = 分层被破坏。
const FORBIDDEN_LOAD_PATTERNS = ['fflate', 'parsecard', 'text-encoding', 'expo-file-system', 'expo-sqlite'];

function loadModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

const loaded = [];
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  for (const pattern of FORBIDDEN_LOAD_PATTERNS) {
    if (request.includes(pattern)) {
      const error = new Error(`分层破坏：工具定义加载路径上禁止依赖 "${request}"`);
      error.__layerViolation = request;
      throw error;
    }
  }
  if (request.endsWith('/network/api.js')) {
    const error = new Error('分层破坏：工具定义加载路径上禁止拉网络层（子代理已惰性化）');
    error.__layerViolation = request;
    throw error;
  }
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (request === 'react-native') {
    return { Platform: { OS: 'android' }, NativeModules: {} };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          loaded.push(path.relative(SRC_DIR, candidate).replace(/\\/g, '/'));
          return loadModule(candidate);
        }
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

function clearCache() {
  loaded.length = 0;
  Object.keys(Module._cache).forEach(key => {
    if (key.startsWith(`${SRC_DIR}${path.sep}`)) delete Module._cache[key];
  });
}

test('加载 tools.js（索引层）不触发 fflate / 网络层 / expo 系：分层炸弹下仍能加载', () => {
  clearCache();
  const tools = loadModule(path.resolve('src/workspace/tools.js'));
  // 加载成功即证明静态链干净（炸弹见 FORBIDDEN_LOAD_PATTERNS）。
  assert.deepEqual([...tools.WORKSPACE_TOOL_NAMES], [
    'list_workspace_files',
    'read_workspace_file',
    'update_plan',
    'materialize_repo',
    'get_build_log',
    'run_subagent',
    'create_workspace_dir',
    'write_workspace_file',
    'edit_workspace_file',
    'run_remote_build',
    'export_workspace_docx',
  ], '索引层聚合顺序是契约（只读 → 计划 → 物化 → 子代理 → 写 → 导出）');
  assert.equal(loaded.includes('workspace/docx.js'), false, 'docx.js 必须惰性（不随定义加载）');
});

test('只读域（readTools.js）自足：不拉 hooks / 子代理 / docx / 执行域', () => {
  clearCache();
  const mod = loadModule(path.resolve('src/workspace/toolDefs/readTools.js'));
  assert.equal(mod.READ_ONLY_TOOL_DEFINITIONS.length, 2);
  for (const forbidden of ['workspace/hooks.js', 'agent/subagent.js', 'workspace/docx.js', 'workspace/shell.js', 'workspace/python.js']) {
    assert.equal(loaded.includes(forbidden), false, `只读域不该加载 ${forbidden}`);
  }
  assert.equal(typeof mod.formatWorkspaceReadResult, 'function', '格式化仍在只读域导出（tools.js 再 re-export）');
});

test('docx 惰性：定义加载时不含 fflate；注入模块后导出可用（无需 require）', async () => {
  clearCache();
  const docxTool = loadModule(path.resolve('src/workspace/toolDefs/docxTool.js'));
  // 惰性：加载定义本身不触发 fflate（炸弹没响）。
  // 无注入 + 纯 ESM（无 require）→ 报「组件不可用」而不是崩溃。
  const definitions = docxTool.DOCX_TOOL_DEFINITION;
  assert.equal(definitions.name, 'export_workspace_docx');

  const written = [];
  const fakeStore = {
    async writeWorkspaceBinaryFile({ path: file, base64 }) {
      written.push({ file, base64 });
      return { path: file };
    },
  };
  // execute 是同步函数（同步 throw）——必须包 async 让 rejects 收得住。
  await assert.rejects(
    async () => { await definitions.execute({ store: fakeStore }, { path: 'a.docx', content: 'x' }, {}); },
    /error\.workspace\.docxUnsupported/,
    '没有注入也没有 require 时如实报不可用'
  );
  // 注入真实模块后正常导出。注意用 **ESM import** 载入真实 docx（带真 fflate）——
  // 走 CJS require 会被上面的加载器炸弹拦下（那是给「工具定义加载路径」准备的）。
  docxTool.setDocxModule(await import('../src/workspace/docx.js'));
  const output = await definitions.execute({ store: fakeStore }, { path: 'a.docx', content: '第一段\n第二段', title: 'T' }, {});
  assert.match(String(output), /已导出 a\.docx/);
  assert.equal(written.length, 1);
  assert.ok(written[0].base64.length > 0);
});

test('结构防线：索引层不得静态 import 重依赖（防回退）；定义一律来自 toolDefs/', () => {
  const source = fs.readFileSync(path.resolve('src/workspace/tools.js'), 'utf8');
  // docx（fflate）与子代理（可能拉网络）必须惰性/隔离；shell / python 只允许
  // 取超时常量——它们自身已惰性取原生模块，留在链里是干净的。
  for (const forbidden of ["from './docx.js'", "from '../agent/subagent.js'"]) {
    assert.equal(source.includes(forbidden), false, `索引层不得静态 import：${forbidden}`);
  }
  assert.ok(source.includes('SHELL_TOOL_TIMEOUT_MS') && source.includes('PYTHON_TOOL_TIMEOUT_MS'), '超时常量仍从执行域取');
  assert.ok(source.includes("./toolDefs/readTools.js") && source.includes("./toolDefs/execTools.js"), '定义一律从 toolDefs/ 聚合');
});
