// 设置页「图片来源」的全部接线（state / 加载 / 增删）——设置页只 spread 返回值，
// 避免设置页（行数棘轮文件）为这块表单再长三十多行。
//
// 语义与错误原因见 storage/settings/imageDownloadSources.js 与
// chat/imageDownloadSources.js；本 hook 只负责把「成功/失败原因」翻译成 UI 可用形态：
// add 返回 { ok, reason }，reason ∈ invalid | limit | storage。

import { useCallback, useEffect, useState } from 'react';

import {
  addImageDownloadSource as addImageDownloadSourceEntry,
  getImageDownloadSources,
  removeImageDownloadSource as removeImageDownloadSourceEntry,
} from '../storage/settings/imageDownloadSources.js';

export function useImageDownloadSources() {
  const [imageDownloadSources, setImageDownloadSources] = useState([]);

  const refresh = useCallback(async () => {
    try {
      const sources = await getImageDownloadSources();
      setImageDownloadSources(Array.isArray(sources) ? sources : []);
    } catch (error) {
      // 读失败保持现状（列表不清空，避免误导成「一个都没有」）。
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addImageDownloadSource = useCallback(async payload => {
    try {
      const added = await addImageDownloadSourceEntry(payload);
      if (!added || !added.host) return { ok: false, reason: 'invalid' };
      await refresh();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error && error.code === 'IMAGE_SOURCE_LIMIT' ? 'limit' : 'storage' };
    }
  }, [refresh]);

  const removeImageDownloadSource = useCallback(async host => {
    try {
      const removed = await removeImageDownloadSourceEntry(host);
      await refresh();
      return removed === true;
    } catch (error) {
      return false;
    }
  }, [refresh]);

  return { imageDownloadSources, addImageDownloadSource, removeImageDownloadSource };
}
