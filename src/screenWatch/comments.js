// 看屏幕的陪伴评论存储：单一全局键（@easychat2_screen_watch_comments）。
// 与听歌/看书同一裁决：评论只在面板内呈现、接话才进会话引用；
// 看屏幕没有「目标对象」（不像歌/书按对象分键），因此整条流一个键，上限 30 条。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../storage/io.js';
import { tActive } from '../i18n/index.js';

export const SCREEN_WATCH_COMMENTS_KEY = '@easychat2_screen_watch_comments';
const COMMENTS_MAX = 30;
const COMMENT_TEXT_MAX = 2000;

const commentsMutation = createMutationQueue();

export function normalizeScreenWatchComment(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || ''),
    characterId: String(source.characterId || ''),
    characterName: String(source.characterName || '').trim(),
    text: String(source.text || '').trim().slice(0, COMMENT_TEXT_MAX),
    // imageUri 记录评论针对的截图（重试与回看用）；文件本身按滚动清扫维护。
    imageUri: String(source.imageUri || ''),
    createdAt: Math.floor(Number(source.createdAt)) || 0,
  };
}

// 读评论列表 → { status, list }：status **必须一路传到调用方**。
// 以前这里把「读不到」直接压成 []，于是（与 books/music 两份同形缺口）：
//   ① appendScreenWatchComment 以 [] 为底写回，把备份里的原评论整段覆盖掉；
//   ② getScreenWatchComments 把 [] 交给面板，用户看到「还没有一起看屏幕」，
//      而数据其实在备份里。
// 口径照正面模板 src/books/comments.js:49-76 与 src/music/comments.js:49-75（同修），
// 更上游的先例是 src/screenWatch/threads.js:80-88（corrupt → status 透出）+ :99（读路径拒绝）。
async function readCommentListStatus() {
  const stored = await readJsonStatus(SCREEN_WATCH_COMMENTS_KEY);
  if (stored.status === 'missing') return { status: 'ok', list: [] };
  if (stored.status === 'corrupt' || !Array.isArray(stored.value)) {
    await backupCorruptValue(SCREEN_WATCH_COMMENTS_KEY);
    return { status: 'corrupt', list: [] };
  }
  return {
    status: 'ok',
    list: stored.value
      .map(normalizeScreenWatchComment)
      .filter(comment => comment.id && comment.text),
  };
}

// 读路径拒绝：损坏时不把 [] 当成「还没有一起看屏幕」交给面板。
// 错误码沿用 src/screenWatch/threads.js:99 的「裸 code」写法（storage 层的拒绝，
// 文案由界面层决定）。
export function getScreenWatchComments() {
  return commentsMutation.enqueue(async () => {
    const result = await readCommentListStatus();
    if (result.status === 'corrupt') throw new Error('screen-watch-comments-read-failed');
    return result.list;
  });
}

export function appendScreenWatchComment(comment) {
  return commentsMutation.enqueue(async () => {
    const normalized = normalizeScreenWatchComment(comment);
    if (!normalized.id || !normalized.text) throw new Error(tActive('error.comments.incomplete'));
    const result = await readCommentListStatus();
    // 读失败**拒绝写回**：以 [] 为底写回会把损坏备份里的原评论覆盖掉
    // （先例：src/storage/worldMap.js:37「读失败就抛错中止：绝不用空列表覆盖已有地图」）。
    if (result.status === 'corrupt') throw new Error('screen-watch-comments-read-failed');
    const existing = result.list;
    if (existing.some(entry => entry.id === normalized.id)) return existing;
    const next = [...existing, normalized].slice(-COMMENTS_MAX);
    await AsyncStorage.setItem(SCREEN_WATCH_COMMENTS_KEY, JSON.stringify(next));
    return next;
  });
}

// 单条删除（幂等，对照 threads.deleteScreenWatchThread 的风格）：
// id 为空或不存在时原样返回当前列表，不报错。只动 comments 存储——
// 对话线程（threads）不级联删除，两者的管理入口不同（线程在记忆页）。
// 读失败同样拒绝（同 threads.deleteScreenWatchThread:167）：损坏时若按 [] 处理，
// 面板会以为「已经删空了」，把真实评论从界面上抹掉。
export function deleteScreenWatchComment(id) {
  return commentsMutation.enqueue(async () => {
    const targetId = String(id || '');
    const result = await readCommentListStatus();
    if (result.status === 'corrupt') throw new Error('screen-watch-comments-read-failed');
    const existing = result.list;
    if (!targetId) return existing;
    if (!existing.some(entry => entry.id === targetId)) return existing;
    const next = existing.filter(entry => entry.id !== targetId);
    if (next.length === 0) await AsyncStorage.removeItem(SCREEN_WATCH_COMMENTS_KEY);
    else await AsyncStorage.setItem(SCREEN_WATCH_COMMENTS_KEY, JSON.stringify(next));
    return next;
  });
}

export function clearScreenWatchComments() {
  return commentsMutation.enqueue(async () => {
    await AsyncStorage.removeItem(SCREEN_WATCH_COMMENTS_KEY);
  });
}
