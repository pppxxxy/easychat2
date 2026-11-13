// 通用弹层外壳（桌面）：居中卡片 + 点击遮罩关闭。
//
// ChatPane 里多个面板只需「一个遮罩 + 一张卡片 + 关闭」，内联写会各占十几行；
// 抽出来后宿主只保留一行挂载。（设置页的 Card 是内容卡，不是弹层，故意不复用。）
export default function PanelShell({ open, onClose, width = 560, children }) {
  if (!open) return null;
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{ width: `min(${width}px, 94vw)`, maxHeight: '86vh', overflow: 'auto' }}
      >
        {children}
      </div>
    </div>
  );
}
