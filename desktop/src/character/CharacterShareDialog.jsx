// 角色卡分享弹层（桌面）：CardSharePanel 的弹层外壳。
//
// 单独一层是为了让角色库页只保留「一行挂载 + 一个开关」，内容仍在
// CardSharePanel（纯展示 + 三个动作）。
import CardSharePanel from './CardSharePanel.jsx';

export default function CharacterShareDialog({ character, palette, fonts, onClose, onImportCard }) {
  if (!character) return null;
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 49,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(560px, 94vw)',
          maxHeight: '86vh',
          overflow: 'auto',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 16,
        }}
      >
        <CardSharePanel
          character={character}
          palette={palette}
          fonts={fonts}
          onImportCard={onImportCard}
        />
      </div>
    </div>
  );
}
