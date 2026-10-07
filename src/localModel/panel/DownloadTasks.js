// 下载任务卡（v5 Stage B/C）：模型库页顶部展示持久化下载队列的任务
// （名称 / 队列序号 / 进度 / 速度 / 保持前台提示 / 取消）。
// 数据来自 downloadQueue 的订阅快照；队列与面板生命周期解耦，关面板/重启后仍在推进。

import React, { useEffect, useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { formatBytes } from '../../utils/format.js';
import {
  cancelQueuedDownload,
  getDownloadQueueSnapshot,
  subscribeDownloadQueue,
} from '../downloadQueue.js';

function useSpeed(current) {
  const [speed, setSpeed] = useState(0);
  const prevRef = useRef({ id: '', bytes: 0, at: 0 });
  const written = current ? Number(current.writtenBytes) || 0 : 0;
  const id = current ? String(current.id || '') : '';
  useEffect(() => {
    if (!id) {
      prevRef.current = { id: '', bytes: 0, at: 0 };
      setSpeed(0);
      return;
    }
    const now = Date.now();
    const prev = prevRef.current;
    if (prev.id === id && prev.at > 0 && now > prev.at) {
      const delta = written - prev.bytes;
      if (delta > 0) setSpeed(delta / ((now - prev.at) / 1000));
    }
    prevRef.current = { id, bytes: written, at: now };
  }, [id, written]);
  return speed;
}

export default function DownloadTasks({ styles, t }) {
  const [snapshot, setSnapshot] = useState(() => getDownloadQueueSnapshot());
  useEffect(() => subscribeDownloadQueue(setSnapshot), []);
  const tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : [];
  const speed = useSpeed(snapshot && snapshot.current);

  if (tasks.length === 0) return null;

  return (
    <View style={styles.downloadTaskWrap}>
      {tasks.map((task, index) => {
        const running = task.status === 'running';
        const failed = task.status === 'error';
        const progress = running ? Math.max(0, Math.min(100, Number(task.progress) || 0)) : 0;
        const written = Number(task.writtenBytes) || 0;
        const total = Number(task.totalBytes) || Number(task.modelExpectedBytes) || 0;
        const sizeText = total > 0
          ? t('localModel.download.progressMeta', {
            written: formatBytes(written),
            total: formatBytes(total),
            speed: running && speed > 0 ? formatBytes(speed) : '—',
          })
          : (written > 0 ? formatBytes(written) : '');
        const footerMeta = failed
          ? t('localModel.download.failed')
          : running
            ? sizeText
            : t('localModel.download.queued');
        return (
          <View key={task.id} style={styles.downloadTaskCard}>
            <View style={styles.downloadTaskHead}>
              <Text style={styles.downloadTaskName} numberOfLines={1}>
                {`\u2b07 ${task.name || task.id}`}
              </Text>
              <Text style={styles.downloadTaskCount}>{`${index + 1}/${tasks.length}`}</Text>
            </View>
            {running ? (
              <View style={styles.downloadProgressRow}>
                <View style={styles.downloadProgressBar}>
                  <View style={[styles.downloadProgressFill, { width: `${progress}%` }]} />
                </View>
                <Text style={styles.downloadProgressText}>{progress}%</Text>
              </View>
            ) : null}
            <View style={styles.downloadTaskFooter}>
              <Text style={styles.downloadTaskFooterMeta} numberOfLines={1}>
                {sizeText ? `${footerMeta}` : footerMeta}
                {running && sizeText ? ` · ${t('localModel.download.keepForeground')}` : ''}
              </Text>
              <TouchableOpacity
                onPress={() => cancelQueuedDownload(task.id).catch(() => {})}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={t('localModel.download.cancel')}
              >
                <Text style={styles.downloadCancelText}>{t('localModel.download.cancel')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}
    </View>
  );
}