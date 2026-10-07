// 向量索引对账：清掉孤儿 / 无归属 / 张冠李戴的分段。
// 从 src/storage/sessionList.js 原样外提（纯搬运，无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { shouldIndexSession } from '../../vectorMemory/scope.js';
import {
  VECTOR_INDEX_PREFIX,
  readVectorIndexStatus,
  updateVectorIndex,
} from '../vector.js';
import { CORRUPT_BACKUP_SUFFIX } from '../io.js';
import { tActive } from '../../i18n/index.js';
import { readSessionsStatus } from '../sessionCore.js';

export async function reconcileVectorIndexes() {
  const sessionsStatus = await readSessionsStatus();
  if (sessionsStatus.status === 'corrupt') {
    throw new Error(tActive('error.storage.sessionListReadFailed'));
  }
  const sessionMap = new Map(
    sessionsStatus.sessions.map(session => [String(session.id || ''), session])
  );
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    throw new Error(tActive('error.storage.vectorIndexListReadFailed'));
  }
  const prefix = `${VECTOR_INDEX_PREFIX}::`;
  const vectorKeys = (Array.isArray(keys) ? keys : [])
    // 排除损坏备份键：其形状是 `@easychat2_vector_index::<id>__corrupt_backup`，
    // 若不排除会被当成角色 id，readVectorIndexStatus 又会再备份一层，逐次启动无限嵌套。
    .filter(key => typeof key === 'string' && key.startsWith(prefix) && !key.endsWith(CORRUPT_BACKUP_SUFFIX));
  const report = {
    scannedKeys: vectorKeys.length,
    removed: 0,
    legacyRemoved: 0,
    foreignRemoved: 0,
    failedKeys: [],
  };
  for (const key of vectorKeys) {
    const characterId = key.slice(prefix.length);
    if (!characterId) continue;
    const status = await readVectorIndexStatus(characterId);
    if (status.status === 'missing') continue;
    if (status.status === 'corrupt') {
      report.failedKeys.push(key);
      continue;
    }
    let legacyRemoved = 0;
    let foreignRemoved = 0;
    try {
      const result = await updateVectorIndex(characterId, current => {
        const next = current.filter(item => {
          const sessionId = String(item.sessionId || '');
          // 无会话归属的 legacy 分段：无法判定它属于谁。历史版本用 'default' 兜底把
          // 无归属写入沉淀进了某些桶（典型是内置助手的桶），保留只会让它被合法召回，
          // 一律清除。
          if (!sessionId) {
            legacyRemoved += 1;
            return false;
          }
          const session = sessionMap.get(sessionId);
          if (!shouldIndexSession(session)) return false;
          // 归属校验：分段所属会话的 characterId 必须等于桶主人。只检查「会话还在」的话，
          // 修复前写错桶的分段（张冠李戴）只要原会话活着就永远不会被清掉。
          if (String(session.characterId || '') !== characterId) {
            foreignRemoved += 1;
            return false;
          }
          return true;
        });
        if (next.length === current.length) return undefined;
        return next.length > 0 ? next : null;
      });
      report.removed += Math.max(0, status.index.length - result.length);
      report.legacyRemoved += legacyRemoved;
      report.foreignRemoved += foreignRemoved;
    } catch (error) {
      report.failedKeys.push(key);
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[vector] reconciliation failed', error);
    }
  }
  return report;
}
