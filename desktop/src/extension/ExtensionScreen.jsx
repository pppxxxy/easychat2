// 扩展页（桌面）：与手机 ExtensionHome 同一套分组入口。
//
// 手机版是 4 个分组（创作 / 日常陪伴 / 内容库 / 小游戏）共 13 个入口，每个入口
// 有自己的页面。桌面此前把这一页做成了「暂不支持」清单——**那是错的**：
// 逐条核对过依赖，其中绝大多数数据层与判定都在共享层，不依赖 Android 原生能力：
//   · 作息 / 日记 / 动态 / 主动消息 / 小游戏 / 音乐 / 书籍 / 世界地图 / 制卡 / 生图
//     的存储与纯逻辑全在 src/ 下，桌面只需 DOM 界面；
//   · 真正不可移植的只有依赖 Android 系统的少数几项（见 UNSUPPORTED 列表）。
//
// 入口一律「点了就进得去」，不再区分「可用 / 不支持」两态——做成灰条只能让用户
// 以为功能丢了。不可用项单独成一组并附原因说明。
import { useEffect, useMemo, useState } from 'react';

import { useApp } from '../../../src/context/AppContext.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { GAMES } from '../../../src/games/games.js';
import { getBooks } from '../../../src/books/library.js';
import { getDiaries } from '../../../src/storage/diary.js';
import { getMomentsSettings, getProactiveSettings } from '../../../src/storage/moments.js';
import { getAllCharacterSchedules } from '../../../src/storage/schedule.js';
import { getMusicItems } from '../../../src/music/library.js';
import { getWorldMap } from '../../../src/storage/worldMap.js';
import { unsupportedReason } from './unsupportedReasons.js';
import { Card } from '../settings/ui.jsx';

// 分组与顺序照抄手机 ExtensionHome 的 GROUPS（icon 在桌面用 emoji 表现）。
const GROUPS = [
  {
    id: 'create',
    items: [
      { id: 'forge', icon: '🪪', labelKey: 'ext.home.forge', descKey: 'ext.home.forge.desc' },
      { id: 'image', icon: '🎨', labelKey: 'ext.home.image', descKey: 'ext.home.image.desc' },
    ],
  },
  {
    id: 'companion',
    items: [
      { id: 'moments', icon: '🪐', labelKey: 'ext.home.moments', descKey: 'ext.home.moments.desc' },
      { id: 'proactive', icon: '🔔', labelKey: 'ext.home.proactive', descKey: 'ext.home.proactive.desc' },
      { id: 'schedule', icon: '🕒', labelKey: 'ext.home.schedule', descKey: 'ext.home.schedule.desc' },
      { id: 'diary', icon: '📖', labelKey: 'ext.home.diary', descKey: 'ext.home.diary.desc' },
      // 看屏幕：桌面只做「截本应用画面」（手机 v1 同一段）；跨应用悬浮窗另属不可用清单。
      { id: 'screenWatch', icon: '👁', labelKey: 'ext.home.screen', descKey: 'ext.home.screen.desc' },
    ],
  },
  {
    id: 'library',
    items: [
      { id: 'music', icon: '🎵', labelKey: 'ext.home.music', descKey: 'ext.home.music.desc' },
      { id: 'books', icon: '📚', labelKey: 'ext.home.books', descKey: 'ext.home.books.desc' },
      { id: 'map', icon: '🗺', labelKey: 'ext.home.map', descKey: 'ext.home.map.desc' },
    ],
  },
  {
    id: 'games',
    items: [
      { id: 'games', icon: '🎮', labelKey: 'ext.home.games', descKey: 'ext.home.games.desc' },
    ],
  },
];

export default function ExtensionScreen({ palette, fonts, onOpen }) {
  const { t } = useTranslation();
  const { characters } = useApp();
  const [summary, setSummary] = useState({});
  const [reasonOpenId, setReasonOpenId] = useState('');

  // 摘要行（与手机 getSummary 同源）：进入页面重读一次，纯展示。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      const read = async (key, loader) => {
        try {
          const value = await loader();
          if (!cancelled) next[key] = value;
        } catch (error) {
          // 摘要只是锦上添花：读失败就不显示这一行，不影响入口本身可用。
        }
      };
      const characterIds = new Set((Array.isArray(characters) ? characters : []).map(item => item && item.id));
      await Promise.all([
        read('moments', async () => {
          const settings = await getMomentsSettings();
          return settings && settings.enabled === true;
        }),
        read('proactive', async () => {
          const settings = await getProactiveSettings();
          return (settings && Array.isArray(settings.slots) ? settings.slots : []).length;
        }),
        read('schedule', async () => {
          const all = await getAllCharacterSchedules();
          return Object.values(all || {}).filter(item => item && item.enabled).length;
        }),
        read('music', async () => (await getMusicItems()).length),
        read('books', async () => (await getBooks()).length),
        read('map', async () => {
          const map = await getWorldMap();
          return (map && Array.isArray(map.houses) ? map.houses : []).length;
        }),
        read('diary', async () => {
          const list = await getDiaries();
          return list.filter(item => item && characterIds.has(item.characterId)).length;
        }),
      ]);
      if (!cancelled) setSummary(next);
    })();
    return () => { cancelled = true; };
  }, [characters]);

  const summaryText = useMemo(() => itemId => {
    switch (itemId) {
      case 'moments':
        return summary.moments ? t('ext.home.moments.on') : t('ext.home.moments.off');
      case 'proactive':
        return t('ext.home.proactive.summary', { count: summary.proactive || 0 });
      case 'schedule':
        return summary.schedule ? t('ext.home.schedule.summary', { count: summary.schedule }) : '';
      case 'music':
        return summary.music ? t('ext.home.music.summary', { count: summary.music }) : '';
      case 'books':
        return summary.books ? t('ext.home.books.summary', { count: summary.books }) : '';
      case 'map':
        return summary.map ? t('ext.home.map.summary', { count: summary.map }) : '';
      case 'diary':
        return summary.diary ? t('ext.home.diary.summary', { count: summary.diary }) : '';
      case 'games':
        return t('ext.home.games.summary', { count: GAMES.length });
      default:
        return '';
    }
  }, [summary, t]);

  const entryCard = (item, unavailable) => {
    const reason = unavailable ? unsupportedReason(item.id) : '';
    const open = reasonOpenId === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => {
          if (unavailable) {
            setReasonOpenId(current => (current === item.id ? '' : item.id));
            return;
          }
          if (typeof onOpen === 'function') onOpen(item.id);
        }}
        style={{
          textAlign: 'left',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          width: '100%',
          background: palette.surface,
          color: palette.text,
          border: `1px solid ${unavailable ? palette.divider : palette.primaryMuted}`,
          borderRadius: 12,
          padding: '12px 14px',
          cursor: 'pointer',
          opacity: unavailable ? 0.75 : 1,
        }}
      >
        <span style={{
          width: 38,
          height: 38,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 10,
          background: unavailable ? palette.surfaceAlt : palette.primary,
          color: palette.primaryContrast,
          fontSize: 18,
        }}
        >
          {item.icon}
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: fonts.scaled(14), fontWeight: 700 }}>
            {t(item.labelKey)}
          </span>
          <span style={{
            fontSize: fonts.scaled(11),
            color: palette.textFaint,
            whiteSpace: open ? 'normal' : 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            lineHeight: 1.6,
          }}
          >
            {open ? reason : t(item.descKey)}
          </span>
          {!unavailable && summaryText(item.id) ? (
            <span style={{ fontSize: fonts.scaled(11), color: palette.primaryMuted || palette.primary, fontWeight: 600 }}>
              {summaryText(item.id)}
            </span>
          ) : null}
        </span>
        <span style={{ color: palette.textFaint, flex: 'none', lineHeight: 1.5 }}>
          {unavailable ? '·' : '›'}
        </span>
      </button>
    );
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      {GROUPS.map(group => (
        <Card key={group.id} title={t(`ext.home.group.${group.id}`)} palette={palette} fonts={fonts}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {group.items.map(item => entryCard(item, false))}
          </div>
        </Card>
      ))}
      <Card title={t('desktop.group.unavailable')} palette={palette} fonts={fonts}>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.7 }}>
          {t('desktop.group.unavailable.hint')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { id: 'plugins', icon: '🧩', labelKey: 'desktop.entry.plugins' },
            { id: 'scheduledTasks', icon: '⏱', labelKey: 'desktop.entry.scheduled' },
            { id: 'localModels', icon: '🧠', labelKey: 'desktop.entry.localModels' },
            { id: 'workspaceTools', icon: '🛠', labelKey: 'desktop.entry.workspace' },
          ].map(item => entryCard(item, true))}
        </div>
      </Card>
    </div>
  );
}