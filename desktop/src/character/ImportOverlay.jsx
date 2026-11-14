// 导入进度遮罩（桌面）：对应手机 CharacterEntryModals 的 importOverlay。
//
// 为什么需要它：解析一张大角色卡（PNG 内嵌 base64 / 大 JSON）要读文件、解 base64、
// 解析 JSON、写媒体与角色，期间界面没有任何反馈，用户会以为点坏了再点一次。
// 手机有阶段遮罩（读取 → 保存），桌面此前完全没有。
//
// 阶段文案直接复用手机词条（character.detail.importStatus.*），四档：
//   reading / saving          普通卡
//   largeReading / largeSaving 大卡（另带体积标签）
// 判定「大卡」与阶段推进都由调用方给，本组件只负责呈现——不做业务判断。
import { useTranslation } from '../../../src/i18n/I18nContext.js';

export default function ImportOverlay({ status, palette, fonts }) {
  const { t } = useTranslation();
  if (!status) return null;

  const large = status.large === true;
  const phase = status.phase === 'saving' ? 'saving' : 'reading';
  const title = large
    ? t(phase === 'saving'
      ? 'character.detail.importStatus.largeSaving'
      : 'character.detail.importStatus.largeReading')
    : t(phase === 'saving'
      ? 'character.detail.importStatus.saving'
      : 'character.detail.importStatus.reading');
  const sizeLabel = status.sizeLabel ? ` · ${status.sizeLabel}` : '';
  const hint = large
    ? t(phase === 'saving'
      ? 'character.detail.importStatus.hintWritingLarge'
      : 'character.detail.importStatus.hintParsingLarge', { size: sizeLabel })
    : t(phase === 'saving'
      ? 'character.detail.importStatus.hintSaving'
      : 'character.detail.importStatus.hintReading');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-busy="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 70,
      }}
    >
      <div style={{
        width: 'min(320px, 100%)',
        background: palette.surface,
        color: palette.text,
        border: `1px solid ${palette.divider}`,
        borderRadius: 14,
        padding: '20px 18px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        textAlign: 'center',
      }}
      >
        {/* 纯 CSS 转圈：不引入依赖，也不依赖动画库。 */}
        <span style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          border: `3px solid ${palette.divider}`,
          borderTopColor: palette.primary,
          animation: 'easychat-import-spin 0.8s linear infinite',
        }}
        />
        <div style={{ fontSize: fonts.scaled(13), fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.6 }}>{hint}</div>
      </div>
    </div>
  );
}
