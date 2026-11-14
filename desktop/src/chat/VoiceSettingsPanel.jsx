// 聊天内语音设置（桌面）：对应手机 chat/VoiceSettingsModal.js。
//
// 手机这一层把三件事放在一起：
//   ① 自动播报开关（与「更多 → 自动播报」同一状态，只是换个入口）；
//   ② 全语音模式（voiceDisplay === 'voice'：只显示语音气泡，不显示正文）；
//   ③ 语音转文字设置的入口。
// 桌面此前只有 ①（在更多菜单里）与 ③（在设置页），② 只能在角色编辑页改。
// 这里补齐成一个面板，让三项在同一处可见——这正是手机放这个面板的理由。
//
// prop 推导也放在本文件：ChatPane 已到 800 行棘轮，调用方只传 chat 与两个回调。
// 判定复用共享层：voiceDisplay 的合法值由 character/cardHelpers 规范化，
// 自动播报走共享 useChatTts（手动播报不受它限制）。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';

export default function VoiceSettingsPanel({
  open,
  onClose,
  isGroup,
  chat,
  onOpenTranscription,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  if (!open || !chat) return null;

  const autoBroadcast = !!(chat.ttsSettings && chat.ttsSettings.autoBroadcast === true);
  // 全语音模式：单聊角色的 voiceDisplay === 'voice'（与手机同一判据）。
  const voiceMode = !isGroup && !!(chat.character && chat.character.voiceDisplay === 'voice');

  const toggleBroadcast = value => {
    // 共享 toggleBroadcast 是自取反、无参的：先比对当前值，避免「看着受控实则不控」。
    if (!!value === autoBroadcast) return;
    chat.toggleBroadcast().catch(() => {
      Alert.alert(t('chat.tts.saveFailed.title'), t('chat.tts.saveFailed.body'));
    });
  };

  const toggleVoiceMode = next => {
    if (!chat.character || typeof chat.updateCharacter !== 'function') return;
    // 写回角色卡字段：voiceDisplay 的合法值与规范化由共享层负责。
    const voiceDisplay = next ? 'voice' : 'text';
    Promise.resolve(chat.updateCharacter({ ...chat.character, voiceDisplay }))
      .catch(() => Alert.alert(t('chat.tts.saveFailed.title'), t('chat.tts.saveFailed.body')));
  };

  const row = (key, title, hint, checked, onChange) => (
    <div
      key={key}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 0',
        borderBottom: `1px solid ${palette.divider}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fonts.scaled(12), fontWeight: 600, color: palette.text }}>{title}</div>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6, marginTop: 2 }}>
          {hint}
        </div>
      </div>
      <input
        type="checkbox"
        checked={checked === true}
        onChange={event => onChange(event.target.checked)}
        aria-label={title}
        style={{ marginTop: 4, flex: 'none' }}
      />
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('chat.voiceSettings.title')}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 55,
      }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={{
        width: 'min(440px, 100%)',
        maxHeight: '80vh',
        overflow: 'auto',
        background: palette.surface,
        color: palette.text,
        border: `1px solid ${palette.divider}`,
        borderRadius: 14,
        padding: 18,
      }}
      >
        <div style={{ fontSize: fonts.scaled(14), fontWeight: 700, marginBottom: 8 }}>
          {t('chat.voiceSettings.title')}
        </div>

        {row(
          'broadcast',
          t('chat.voice.broadcast.label'),
          t('chat.voice.broadcast.hint'),
          autoBroadcast,
          toggleBroadcast
        )}

        {/* 群聊没有单个角色的 voiceDisplay，整行不显示（与手机 !isGroup 判据一致）。 */}
        {isGroup ? null : row(
          'fullMode',
          t('chat.voiceSettings.fullMode'),
          t('chat.voiceSettings.fullModeHint'),
          voiceMode,
          toggleVoiceMode
        )}

        <button
          type="button"
          onClick={() => { onClose(); if (typeof onOpenTranscription === 'function') onOpenTranscription(); }}
          style={{
            marginTop: 10,
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            color: palette.primary,
            border: `1px solid ${palette.divider}`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: fonts.scaled(12),
            cursor: 'pointer',
          }}
        >
          {t('chat.voiceSettings.transcription')}
        </button>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: palette.primary,
              color: palette.primaryContrast,
              border: 'none',
              borderRadius: 8,
              padding: '6px 14px',
              fontSize: fonts.scaled(12),
              cursor: 'pointer',
            }}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
