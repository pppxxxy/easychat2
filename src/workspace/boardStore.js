// 跨会话黑板持久化：把一块黑板序列化到工作区文件，下次运行再播种回来。
//
// 语义：黑板本身是内存态（agent/blackboard.js）；本模块负责「落盘 / 播种」——
// run_team（默认）与 run_workflow（remember:true）在跑之前 loadPersistentBlackboard
// 播种、跑完 savePersistentBlackboard 落盘，于是同一团队的发现能跨会话沉淀。
//
// 文件是内部态（.easychat/board/board.json）：store 的列表枚举把它隐藏（同 file-history），
// 模型走 board_read 读，不看原始 JSON。空黑板不落盘、也不覆盖已有文件。

import {
  BLACKBOARD_MAX_ENTRIES,
  BLACKBOARD_MAX_TOPICS,
  BLACKBOARD_TEXT_MAX,
  createBlackboard,
} from '../agent/blackboard.js';

export const BOARD_DIR = '.easychat/board';
export const BOARD_FILE = `${BOARD_DIR}/board.json`;
// 读上限：按黑板**最大体量**推导（主题 × 每条 × (正文 + JSON 字段开销)），再留一倍余量。
// 定小了会截断文件 → JSON 解析失败 → 静默清空（丢全部沉淀），故与 blackboard.js 的边界同源。
export const BOARD_FILE_MAX_CHARS = BLACKBOARD_MAX_TOPICS * BLACKBOARD_MAX_ENTRIES * (BLACKBOARD_TEXT_MAX + 64) * 2;

// IO：读黑板文件并播种成一块黑板；不存在/坏文件 → 空黑板（不打扰）。
export async function loadPersistentBlackboard(store, characterId) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return createBlackboard();
  let content = '';
  try {
    const result = await store.readWorkspaceFile({ characterId, path: BOARD_FILE, maxChars: BOARD_FILE_MAX_CHARS });
    content = String((result && result.content) || '');
  } catch (error) {
    return createBlackboard();
  }
  let data = null;
  try {
    data = JSON.parse(content);
  } catch (error) {
    data = null;
  }
  return createBlackboard({ initial: data });
}

// IO：把黑板落盘。空黑板（无任何条目）不写、也不覆盖已有文件。返回是否写入。
export async function savePersistentBlackboard(store, characterId, board) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return false;
  if (!board || typeof board.serialize !== 'function') return false;
  const data = board.serialize();
  const topics = (data && data.topics) || {};
  if (Object.keys(topics).length === 0) return false;
  try {
    await store.writeWorkspaceFile({ characterId, path: BOARD_FILE, content: JSON.stringify(data, null, 2) });
    return true;
  } catch (error) {
    return false;
  }
}

// IO：清空持久化黑板（供宿主提供「忘记团队沉淀」入口）。返回是否删除。
export async function clearPersistentBlackboard(store, characterId) {
  if (!store || typeof store.deleteFile !== 'function') return false;
  try {
    await store.deleteFile({ characterId, path: BOARD_FILE });
    return true;
  } catch (error) {
    return false;
  }
}
