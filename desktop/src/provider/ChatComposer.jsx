// 输入区（桌面）：附件/表情/语音图标 + 输入框 + 发送/停止。
//
// 从 provider/ChatPane.jsx 外提（那里撞到 800 行棘轮）。纯展示：所有状态与动作
// 由宿主传入；发送/停止分别走 submit 与 chat.stop（与手机「生成中发送键变停止键」一致）。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import CameraDialog from '../attachments/CameraDialog.jsx';

import useDesktopAttachmentCaps from '../chat/useDesktopAttachmentCaps.js';

export default function ChatComposer({
  input,
  onInputChange,
  submit,
  chat,
  attach,
  stickersApi,
  isSending,
  ready,
  composerDisabled,
  canSend,
  iconButton,
  search,
  messages,
  onOpenMore,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  // 附件能力位（当前模型）：把「识图/看视频」不可用的入口置灰并说明原因，
  // 而不是让用户选完文件才在发送侧被拒。口径与 useChatSend 完全一致。
  // 放在本组件内部而不是宿主：这样 ChatPane 只传 chat/attach，不必再传能力位。
  const attachCaps = useDesktopAttachmentCaps({ characterId: chat && chat.character && chat.character.id });
  // 相机对话框：'photo' | 'video' | ''（关闭）。
  const [cameraMode, setCameraMode] = useState('');
  // 还没读出来时不禁用（避免闪一下灰）；读出来后按真实能力判断。
  const visionBlocked = attachCaps.ready === true && attachCaps.vision !== true;
  const videoBlocked = attachCaps.ready === true && attachCaps.video !== true;
  return (
    <>
      <div style={{ borderTop: `1px solid ${palette.divider}`, padding: 12, display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <button
          type="button"
          title={t('chat.menu.search')}
          onClick={() => (search.open ? search.closeSearch() : search.openSearch())}
          disabled={!ready || messages.length === 0}
          style={{ ...iconButton, background: search.open ? palette.surfaceAlt : 'transparent' }}
        >
          🔍
        </button>
        {/* 图片/视频按当前模型能力置灰（手机 AttachmentMenuModal 同款）：
            title 直接说明原因，用户不必选完文件才在发送侧被拒。 */}
        <button
          type="button"
          title={visionBlocked ? t('chat.attach.visionRequired') : t('chat.attach.image.title')}
          onClick={attach.pickImages}
          disabled={composerDisabled || visionBlocked}
          style={{ ...iconButton, opacity: visionBlocked ? 0.4 : 1 }}
        >
          🖼
        </button>
        <button
          type="button"
          title={videoBlocked ? t('chat.attach.videoRequired') : t('chat.attach.video.title')}
          onClick={attach.pickVideos}
          disabled={composerDisabled || videoBlocked}
          style={{ ...iconButton, opacity: videoBlocked ? 0.4 : 1 }}
        >
          🎬
        </button>
        {/* 拍照 / 拍摄视频：手机用相机，桌面用 getUserMedia（见 attachments/CameraDialog.jsx）。
            与「选图/选视频」写进同一目录、走同一套校验与媒体保护。 */}
        <button
          type="button"
          title={visionBlocked ? t('chat.attach.visionRequired') : t('chat.attach.camera.title')}
          onClick={() => setCameraMode('photo')}
          disabled={composerDisabled || visionBlocked}
          style={{ ...iconButton, opacity: visionBlocked ? 0.4 : 1 }}
        >
          📷
        </button>
        <button
          type="button"
          title={videoBlocked ? t('chat.attach.videoRequired') : t('chat.attach.videoCamera.title')}
          onClick={() => setCameraMode('video')}
          disabled={composerDisabled || videoBlocked}
          style={{ ...iconButton, opacity: videoBlocked ? 0.4 : 1 }}
        >
          🎥
        </button>
        <button
          type="button"
          title={t('chat.attach.text.title')}
          onClick={attach.pickText}
          disabled={composerDisabled}
          style={iconButton}
        >
          📄
        </button>
        <button
          type="button"
          title={t('chat.sticker.title')}
          onClick={stickersApi.togglePanel}
          disabled={composerDisabled}
          style={{ ...iconButton, background: stickersApi.panelOpen ? palette.surfaceAlt : 'transparent' }}
        >
          😀
        </button>
        <button
          type="button"
          title={t('chat.attach.voice.title')}
          onClick={() => Alert.alert(t('chat.attach.voice.title'), t('chat.attach.voiceUnsupported'))}
          style={iconButton}
        >
          🎤
        </button>
        {/* 「更多」：手机上这些动作都在 ⋯ 菜单里（搜索/总结/统计/导出/重选开场白）。
            放在最右而不是中间，避免把输入区挤得太窄。 */}
        <button
          type="button"
          title={t('chat.menu.more.a11y')}
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMore(rect);
          }}
          disabled={!ready}
          style={iconButton}
        >
          ⋯
        </button>
        <textarea
          value={input}
          onChange={event => onInputChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          onPaste={event => {
            const files = event.clipboardData && event.clipboardData.files;
            if (files && files.length > 0) {
              event.preventDefault();
              attach.addFiles(files);
            }
          }}
          placeholder={t('chat.composer.placeholder')}
          rows={2}
          style={{
            flex: 1,
            resize: 'none',
            background: palette.surface,
            color: palette.text,
            border: `1px solid ${palette.divider}`,
            borderRadius: 10,
            padding: '10px 12px',
            fontSize: fonts.scaled(14),
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        {/* 与手机一致：生成中「发送」变「停止」（abort 走共享层同一个 abortRef，
            已生成的部分照常落盘，未完成的一轮不会丢）。 */}
        <button
          type="button"
          onClick={isSending ? chat.stop : submit}
          disabled={!isSending && !canSend}
          title={isSending ? t('chat.composer.a11y.stop') : t('chat.send.action')}
          style={{
            background: isSending ? palette.surfaceAlt : palette.primary,
            color: isSending ? palette.text : palette.primaryContrast,
            border: isSending ? `1px solid ${palette.divider}` : 'none',
            borderRadius: 10,
            padding: '10px 16px',
            fontWeight: 700,
            cursor: !isSending && !canSend ? 'default' : 'pointer',
            fontSize: fonts.scaled(13),
            flex: 'none',
          }}
        >
          {isSending ? t('chat.composer.a11y.stop') : t('chat.send.action')}
        </button>
      </div>
      <CameraDialog
        open={!!cameraMode}
        mode={cameraMode === 'video' ? 'video' : 'photo'}
        onClose={() => setCameraMode('')}
        onCaptured={item => attach.addCaptured(item)}
        palette={palette}
        fonts={fonts}
      />
    </>
  );
}
