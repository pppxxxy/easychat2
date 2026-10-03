// 工作区文件读写。fileSystem 由调用方注入（原生用 expo-file-system/legacy，
// 测试用内存实现），故本模块零原生依赖、可 Node 直测。

import {
  assertAllowedWorkspaceFile,
  isAllowedWorkspaceFile,
  normalizeWorkspacePath,
  sandboxDirectory,
} from './paths.js';

const MAX_FILES = 2000;
const MAX_DEPTH = 6;
const MAX_READ_CHARS = 1024 * 1024;

function assertFileSystem(fileSystem) {
  if (!fileSystem || typeof fileSystem.readAsStringAsync !== 'function') {
    throw new Error('工作区缺少 fileSystem 注入。');
  }
}

async function getInfo(fileSystem, uri) {
  try {
    return await fileSystem.getInfoAsync(uri);
  } catch (error) {
    return { exists: false };
  }
}

async function ensureDirectory(fileSystem, uri) {
  const info = await getInfo(fileSystem, uri);
  if (!info || !info.exists) {
    await fileSystem.makeDirectoryAsync(uri, { intermediates: true });
  }
}

async function walk(fileSystem, directoryUri, prefix, results, depth) {
  if (results.length >= MAX_FILES || depth > MAX_DEPTH) return;
  let entries = [];
  try {
    entries = await fileSystem.readDirectoryAsync(directoryUri);
  } catch (error) {
    return;
  }
  for (const entry of entries) {
    if (results.length >= MAX_FILES) return;
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const uri = `${directoryUri}${entry}`;
    const info = await getInfo(fileSystem, uri);
    if (info && info.isDirectory) {
      results.push(`${relative}/`);
      await walk(fileSystem, `${uri}/`, relative, results, depth + 1);
    } else if (isAllowedWorkspaceFile(relative)) {
      results.push(relative);
    }
  }
}

export async function listWorkspaceFiles({ root, characterId, fileSystem, subdir = '' } = {}) {
  assertFileSystem(fileSystem);
  const base = sandboxDirectory(root, characterId);
  const relBase = String(subdir || '').trim() ? normalizeWorkspacePath(subdir) : '';
  const start = relBase ? `${base}${relBase}/` : base;
  const results = [];
  await walk(fileSystem, start, relBase, results, 0);
  return results.sort();
}

export async function readWorkspaceFile({ root, characterId, path, fileSystem, maxChars = MAX_READ_CHARS } = {}) {
  assertFileSystem(fileSystem);
  const relative = normalizeWorkspacePath(path);
  assertAllowedWorkspaceFile(relative);
  const uri = `${sandboxDirectory(root, characterId)}${relative}`;
  const info = await getInfo(fileSystem, uri);
  if (!info || !info.exists) throw new Error(`文件不存在：${relative}`);
  if (info.isDirectory) throw new Error(`目标是目录，不是文件：${relative}`);
  const text = String(await fileSystem.readAsStringAsync(uri));
  if (text.length > maxChars) {
    return { path: relative, content: text.slice(0, maxChars), truncated: true };
  }
  return { path: relative, content: text, truncated: false };
}

export async function writeWorkspaceFile({ root, characterId, path, content, fileSystem } = {}) {
  assertFileSystem(fileSystem);
  const relative = normalizeWorkspacePath(path);
  assertAllowedWorkspaceFile(relative);
  const sandbox = sandboxDirectory(root, characterId);
  const uri = `${sandbox}${relative}`;
  const parent = uri.slice(0, uri.lastIndexOf('/') + 1);
  await ensureDirectory(fileSystem, sandbox);
  await ensureDirectory(fileSystem, parent);
  const text = typeof content === 'string'
    ? content
    : String(content === undefined || content === null ? '' : content);
  await fileSystem.writeAsStringAsync(uri, text);
  return { path: relative, length: text.length };
}

export const WORKSPACE_LIMITS = Object.freeze({ MAX_FILES, MAX_DEPTH, MAX_READ_CHARS });