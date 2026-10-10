// 工作区本地 git 内核（W7，纯 JS / isomorphic-git）。
//
// 定位：给 agent 与 UI 提供**本地版本控制**——Android 上没有 git 二进制，`run_shell`
// 调不到 git，所以在此之前 agent 没有任何办法把「我改了什么」变成一份可回滚的历史。
// 本模块只做内核（init/status/diff/log/commit/checkout），工具与 UI 接线在下一层。
//
// 两条实测结论决定了这里的形状（spike 2026-10-10，见 spec workspace-gui-parity）：
// 1. **isomorphic-git 1.43.3 没有 `git.diff`**（`typeof git.diff === 'undefined'`）。
//    「改了什么」= 取 HEAD 旧 blob + 当前文件，交给**已有的** `lineDiff.js` 出模型，
//    不另写一套 diff 算法。
// 2. git 的对象写入依赖「父目录已存在」，而 expo-file-system 不会替你建父目录——
//    这层由 `gitFs.js` 的 ensureParent 兜住（store.js 的 ensureDirectory 同款）。
//
// 门控（谁调用谁负责）：只在**应用私有沙盒根**可用；SAF 外部文件夹下不注册、不调用
//（content:// 撑不起 .git 的原子重命名与锁语义）。

import git from 'isomorphic-git';
import { Buffer } from 'buffer';

import { createGitFs } from './gitFs.js';
import { buildLineDiff } from './lineDiff.js';

// 仓库根固定为 '/'：路径映射由 gitFs 独占（见其注释），调用方不要再拼沙盒前缀。
const REPO_DIR = '/';
export const GIT_DEFAULT_AUTHOR = Object.freeze({ name: 'easychat', email: 'agent@easychat.local' });
export const GIT_DEFAULT_DEPTH = 20;

// isomorphic-git 的 [filepath, head, workdir, stage] 三元组 → 可读状态。
// 1 = 存在且一致，2 = 存在但不同，0 = 不存在。
export function classifyStatusRow([filepath, head, workdir, stage]) {
  if (head === 1 && workdir === 1 && stage === 1) return { path: filepath, status: 'unmodified', head, workdir, stage };
  if (head === 0 && stage === 0) return { path: filepath, status: 'untracked', head, workdir, stage };
  if (head === 0 && stage !== 0) return { path: filepath, status: 'added', head, workdir, stage };
  if (workdir === 0) return { path: filepath, status: 'deleted', head, workdir, stage };
  return { path: filepath, status: 'modified', head, workdir, stage };
}

export function createWorkspaceGit({ root, characterId, fileSystem, author = GIT_DEFAULT_AUTHOR } = {}) {
  const fs = createGitFs({ root, characterId, fileSystem });
  const dir = REPO_DIR;

  // 还没有任何提交时 HEAD 指向不存在的 ref，statusMatrix / log 都会抛 NotFoundError。
  // 这不是错误状态——**每个新工作区第一次调用就走这条路**，必须当成「一切都是新的」。
  const hasAnyCommit = async () => {
    try {
      await git.resolveRef({ fs, dir, ref: 'HEAD' });
      return true;
    } catch (error) {
      return false;
    }
  };

  // 空仓库时的状态：工作区里的一切都是 untracked（不碰 .git 自身）。
  const walkWorkdir = async (prefix = '') => {
    const out = [];
    let entries = [];
    try {
      entries = await fs.readdir(prefix === '' ? '/' : prefix);
    } catch (error) {
      return out;
    }
    for (const name of entries) {
      if (prefix === '' && name === '.git') continue;
      const path = prefix === '' ? name : `${prefix}/${name}`;
      const info = await fs.lstat(path);
      if (info.isDirectory()) out.push(...await walkWorkdir(path));
      else out.push(path);
    }
    return out;
  };

  const statusRows = async () => {
    if (!(await hasAnyCommit())) {
      const files = await walkWorkdir();
      return files.map(path => ({ path, status: 'untracked', head: 0, workdir: 2, stage: 0 }));
    }
    const rows = await git.statusMatrix({ fs, dir });
    return rows.map(classifyStatusRow);
  };

  const readFileOr = async (path, fallback = '') => {
    try {
      return await fs.readFile(path, { encoding: 'utf8' });
    } catch (error) {
      return fallback;
    }
  };

  return {
    async isRepo() {
      return fs.exists('.git/HEAD');
    },
    async init() {
      await git.init({ fs, dir });
      return true;
    },
    // 全量状态（含 unmodified；调用方通常只关心 changed）。
    async status() {
      return statusRows();
    },
    // 只看变更——回合小结、压缩扫描、UI 徽标都用这个口径。
    async changedFiles() {
      return (await statusRows()).filter(row => row.status !== 'unmodified');
    },
    async log({ depth = GIT_DEFAULT_DEPTH } = {}) {
      if (!(await hasAnyCommit())) return [];
      const entries = await git.log({ fs, dir, depth });
      return entries.map(entry => ({
        oid: entry.oid,
        message: String(entry.commit.message || '').trim(),
        author: entry.commit.author,
        at: (Number(entry.commit.author && entry.commit.author.timestamp) || 0) * 1000,
      }));
    },
    // 某文件在 HEAD 的版本（新文件返回 ''）。「改了什么」的旧侧。
    async readFileAtHead(path) {
      if (!(await hasAnyCommit())) return '';
      const entries = await git.log({ fs, dir, depth: 1 });
      if (!entries.length) return '';
      try {
        const { blob } = await git.readBlob({ fs, dir, oid: entries[0].oid, filepath: path });
        return Buffer.from(blob).toString('utf8');
      } catch (error) {
        return '';
      }
    },
    // 单个文件的改动模型（交给 DiffView / buildDiffHtml 渲染，不在这里拼 HTML）。
    async diffModel(path) {
      const before = await this.readFileAtHead(path);
      const after = await readFileOr(path);
      return buildLineDiff(before, after);
    },
    // 暂存全部变更并提交一次。返回 oid；没有变更返回 null（不产生空提交）。
    async commitAll(message, { author: commitAuthor = author } = {}) {
      const changed = await this.changedFiles();
      if (changed.length === 0) return null;
      for (const row of changed) {
        if (row.status === 'deleted') {
          await git.remove({ fs, dir, filepath: row.path });
        } else {
          await git.add({ fs, dir, filepath: row.path });
        }
      }
      return git.commit({ fs, dir, message: String(message || ''), author: commitAuthor });
    },
    // 回合回滚：丢弃工作区改动回到 HEAD（只动沙盒里的文件，不碰外部）。
    async checkoutAll({ filepaths = null } = {}) {
      const options = { fs, dir, force: true };
      if (Array.isArray(filepaths) && filepaths.length > 0) options.filepaths = filepaths;
      await git.checkout(options);
      return true;
    },
  };
}
