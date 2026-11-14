// 聊天页的「信息类」弹层集合：会话统计 / 对话导出 / 语音设置。
//
// 为什么单独成组件：ChatPane 已顶到 800 行棘轮，而这三块是纯粹的「按开关挂面板」，
// 与消息流、输入区、分支逻辑都不相干。抽出来之后 ChatPane 只保留一行挂载，
// 新增同类面板也不必再挤 ChatPane 的行数。
//
// 三个面板的开关仍由 ChatPane 的 overlays 状态控制（传 open / onClose 进来），
// 本组件不持有状态——否则「关闭面板」会出现两处真相。
import ConversationExportPanel from './ConversationExportPanel.jsx';
import SessionStatsPanel from './SessionStatsPanel.jsx';
import VoiceSettingsPanel from './VoiceSettingsPanel.jsx';

export default function ChatInfoPanels({
  overlays,
  onCloseOverlay,
  activeSessionId,
  messageCount,
  messages,
  title,
  characterName,
  userName,
  isGroup,
  chat,
  onOpenTranscription,
  palette,
  fonts,
}) {
  return (
    <>
      <SessionStatsPanel
        open={overlays.stats}
        onClose={() => onCloseOverlay('stats')}
        sessionId={activeSessionId || ''}
        messageCount={messageCount}
        palette={palette}
        fonts={fonts}
      />
      <ConversationExportPanel
        open={overlays.export}
        onClose={() => onCloseOverlay('export')}
        messages={messages}
        title={title}
        characterName={characterName}
        userName={userName}
        isGroup={isGroup}
        palette={palette}
        fonts={fonts}
      />
      <VoiceSettingsPanel
        open={overlays.voiceSettings}
        onClose={() => onCloseOverlay('voiceSettings')}
        isGroup={isGroup}
        chat={chat}
        onOpenTranscription={onOpenTranscription}
        palette={palette}
        fonts={fonts}
      />
    </>
  );
}
