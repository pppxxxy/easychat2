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
      // 单个条目查不到（readdir 与 lstat 之间被删、或后端只给了一半）不能让整个
      // status 掀掉——跳过它，其余照常如实报告。
      let info = null;
      try {
        info = await fs.lstat(path);
      } catch (error) {
        continue;
      }
      if (info && info.isDirectory()) out.push(...await walkWorkdir(path));
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

  // 某个提交的父提交 oid（第一个提交没有父 → ''）。
  const parentOf = async oid => {
    if (!oid) return '';
    try {
      const { commit } = await git.readCommit({ fs, dir, oid });
      const parents = Array.isArray(commit && commit.parent) ? commit.parent : [];
      return parents[0] || '';
    } catch (error) {
      return '';
    }
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
    // 某文件在**指定提交**里的内容（那个提交里没有这个文件 → ''）。
    async fileAt(oid, path) {
      if (!oid) return '';
      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: path });
        return Buffer.from(blob).toString('utf8');
      } catch (error) {
        return '';
      }
    },
    // 某个提交相对**其父提交**改了哪些文件。第一个提交（无父）→ 全部算新增。
    // 用两棵树并走（git.walk）而不是逐文件读：目录节点两边 oid 不同不算改动，
    // 只有 blob 侧的 oid 变化才是真改动。
    async changedInCommit(oid) {
      if (!oid) return [];
      const parent = await parentOf(oid);
      const changed = [];
      // 两个实测坑（spike 探针踩出来的，别"顺手简化"）：
      // 1. WalkerEntry 的 type()/oid() 是**异步方法**，不是属性——按属性读会全是 undefined，
      //    于是「两边 oid 相同」恒成立，改动列表永远为空；
      // 2. map 返回 null 会让 walker **停止下钻**（只剩根节点），必须返回非 null 值。
      const typeOf = async entry => (entry ? entry.type() : null);
      const oidOf = async entry => (entry ? entry.oid() : null);
      try {
        const trees = parent
          ? [git.TREE({ ref: parent }), git.TREE({ ref: oid })]
          : [git.TREE({ ref: oid })];
        await git.walk({
          fs,
          dir,
          trees,
          map: async (filepath, entries) => {
            if (filepath !== '.') {
              const before = parent ? entries[0] : null;
              const after = entries[parent ? 1 : 0];
              const beforeType = await typeOf(before);
              const afterType = await typeOf(after);
              if (beforeType === 'blob' && afterType === 'blob') {
                if (await oidOf(before) !== await oidOf(after)) changed.push({ path: filepath, status: 'modified' });
              } else if (afterType === 'blob') {
                changed.push({ path: filepath, status: 'added' });
              } else if (beforeType === 'blob') {
                changed.push({ path: filepath, status: 'deleted' });
              }
            }
            // 必须返回非 null：返回 null 会停止下钻，目录里的文件就都看不见了。
            return true;
          },
        });
      } catch (error) {
        // 树走不动（对象缺失等）→ 返回已经拿到的部分，不把整个面板打挂。
      }
      return changed.sort((a, b) => a.path.localeCompare(b.path));
    },
    // 某个提交里某文件相对父提交的**文本对**——UI 直接喂 DiffView（模型由它自己算，
    // 不在这里拼第二套 diff 口径）。
    async diffTextsInCommit(oid, path) {
      const parent = await parentOf(oid);
      return {
        before: parent ? await this.fileAt(parent, path) : '',
        after: await this.fileAt(oid, path),
      };
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
    // HEAD 的父提交 oid（用于「撤销本轮」：回到本轮之前的样子）。没有提交 → ''。
    async parentOfHead() {
      if (!(await hasAnyCommit())) return '';
      const entries = await git.log({ fs, dir, depth: 1 });
      if (!entries.length) return '';
      return parentOf(entries[0].oid);
    },
    // 把指定文件恢复成**某个提交**里的样子（撤销一轮的地基）。该提交里没有这个文件 →
    // 说明它那时还不存在 → 删掉它（否则「撤销」会留下一堆本轮新建的文件）。
    // 不碰历史、不重写提交：调用方随后照常提交一次「回滚」，于是回滚本身也是可追溯的。
    async restorePathsFrom(oid, filepaths) {
      const paths = (Array.isArray(filepaths) ? filepaths : []).filter(Boolean).map(String);
      if (!oid || paths.length === 0) return { restored: 0, removed: 0 };
      const present = [];
      const missing = [];
      for (const path of paths) {
        let exists = false;
        try {
          await git.readBlob({ fs, dir, oid, filepath: path });
          exists = true;
        } catch (error) {
          exists = false;
        }
        if (exists) present.push(path);
        else missing.push(path);
      }
      if (present.length > 0) await git.checkout({ fs, dir, ref: oid, force: true, filepaths: present });
      for (const path of missing) {
        try {
          await fs.unlink(path);
        } catch (error) {
          // 单条失败不影响其余；下一次 status 会如实报出来。
        }
      }
      return { restored: present.length, removed: missing.length };
    },
    // 丢弃未提交的改动，回到上一次提交（只动沙盒里的文件，不碰外部）。
    //
    // 为什么不是直接 git.checkout：checkout 只还原**已跟踪**文件，未跟踪/新加的文件它会
    // 原样留在工作区——那样「丢弃全部改动」就是假的（新文件还在，下次提交又进去了）。
    // 所以这里分两路：已跟踪的 checkout 还原，未跟踪/新加的删掉。
    // filepaths 传了就只处理这些路径（单个文件级撤销）。
    async discard({ filepaths = null } = {}) {
      const changed = await this.changedFiles();
      const scoped = Array.isArray(filepaths) && filepaths.length > 0
        ? changed.filter(row => filepaths.includes(row.path))
        : changed;
      const tracked = scoped.filter(row => row.status === 'modified' || row.status === 'deleted').map(row => row.path);
      const untracked = scoped.filter(row => row.status === 'untracked' || row.status === 'added').map(row => row.path);
      if (tracked.length > 0) await git.checkout({ fs, dir, force: true, filepaths: tracked });
      for (const path of untracked) {
        try {
          await fs.unlink(path);
        } catch (error) {
          // 单条删除失败不影响其余（下一次 status 仍会如实报出来）。
        }
      }
      return { restored: tracked.length, removed: untracked.length };
    },
  };
}
