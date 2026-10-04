// 视频附件（上传/拍摄）源码断言：模型「看视频」能力门控与跨文件集成点。
//
// 视频是纯运行时路径（相册/相机/原生解码在 Node 进不去），行为测试覆盖纯函数
// （attachments 的识别/限额/落盘、pipeline 的 video_url 构建、协议转换的丢弃），
// 这里钉住门控与各集成点的接线（先例：locationWiring / chatScreenSplit）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const MENU = read('src/chat/AttachmentMenuModal.js');
const CHAT_SCREEN = read('src/ChatScreen.js');
const SEND = read('src/chat/useChatSend.js');
const BUBBLE = read('src/chat/MessageBubble.js');
const MEDIA = read('src/chat/chatMedia.js');
const SWITCH = read('src/chat/useSessionSwitch.js');
const PARTICIPANT = read('src/chat/useSessionMessages.js');
const COMPOSER = read('src/chat/ChatComposer.js');

test('附件菜单：拍摄视频/上传视频两项入口，带 requiresVideo 锁定与专属原因', () => {
  assert.ok(MENU.includes("id: 'video-camera'"), '拍摄视频入口');
  assert.ok(MENU.includes("id: 'video'"), '上传视频入口');
  assert.equal((MENU.match(/requiresVideo: true/g) || []).length, 2, '两个视频入口都要能力门控');
  assert.ok(MENU.includes('(option.requiresVideo && !videoEnabled)'), '锁定条件必须含视频能力');
  assert.ok(MENU.includes("t(option.requiresVideo ? 'chat.attach.videoRequired' : 'chat.attach.visionRequired')"),
    '锁定原因要区分视频/识图');
  assert.ok(MENU.includes('videoEnabled'), '组件接收 videoEnabled');
});

test('ChatScreen：菜单门控 = supportsVideo 且 OpenAI 兼容协议；添加时复检；草稿清理含视频', () => {
  assert.ok(CHAT_SCREEN.includes('attachmentVideoEnabled'), '视频能力状态存在');
  // 整段表达式钉住（含换行与缩进）：`String(...openai)` 在 addAttachment 的复检里
  // 也出现，只查片段会漏掉「菜单门控被拆掉协议限定」这类回归（注入验证抓出过）。
  assert.ok(
    CHAT_SCREEN.includes(
      "video = !!(current && current.supportsVideo === true)\n          && String(current.protocol || 'openai') === 'openai';"
    ),
    '菜单门控：supportsVideo + openai 协议（整段表达式）'
  );
  assert.equal((CHAT_SCREEN.match(/videoEnabled=\{attachmentVideoEnabled\}/g) || []).length, 1, '门控传给菜单');
  // 添加时复检（菜单可能在门外打开，或能力被改）
  assert.ok(CHAT_SCREEN.includes('const videoAllowed = !!(current && current.supportsVideo === true)'),
    'addAttachment 里按当前配置复检');
  // 草稿生命周期：重置/移除都要删视频文件
  assert.equal((CHAT_SCREEN.match(/if \(item\.kind === 'video'\) deleteLocalVideo\(item\.uri\);/g) || []).length, 1,
    'resetSessionUi 清理视频草稿');
  assert.ok(CHAT_SCREEN.includes("if (target && target.kind === 'video') deleteLocalVideo(target.uri);"),
    '移除附件时删视频文件');
  assert.ok(CHAT_SCREEN.includes('persistVideoAttachment'), '视频落盘走 chat-videos');
  assert.ok(CHAT_SCREEN.includes('recordVideo') && CHAT_SCREEN.includes('pickVideoAttachment'), '拍摄/上传两条入口都接上');
});

test('useChatSend：发送时复检 + includeVideo 标记 + 视频独立数量守卫', () => {
  assert.ok(SEND.includes('let videoEnabled = false;'));
  assert.ok(
    SEND.includes("videoEnabled = !!(current && current.supportsVideo === true)") &&
    SEND.includes("&& String(current.protocol || 'openai') === 'openai';"),
    '发送侧门控与菜单同口径（含协议限定）'
  );
  assert.ok(SEND.includes("if (!videoEnabled) {\n        Alert.alert('不支持看视频'"), '发送时复检，未支持直接拒绝');
  assert.ok(SEND.includes("imageMessages.push({ ...videoMessage, dataUri, includeVideo: videoEnabled });"),
    '视频消息带 includeVideo 标记（管道按它裁剪）');
  assert.ok(SEND.includes('MAX_VIDEO_ATTACHMENTS') && SEND.includes('validateVideoSize'), '数量与大小校验复用附件层');
  assert.ok(SEND.includes("item.kind === 'video'"), '从附件列表分流视频');
});

test('消息层：video kind 贯通（提示词描述、气泡卡片、草稿条图标）', () => {
  assert.ok(MEDIA.includes("export const VIDEO_MESSAGE_KIND = 'video';"));
  assert.ok(MEDIA.includes('【视频：'), '上下文投影用【视频：…】描述');
  assert.ok(MEDIA.includes('kind === VIDEO_MESSAGE_KIND ? VIDEO_MESSAGE_KIND'), 'createMediaMessage 保留 video kind');
  assert.ok(BUBBLE.includes("message.kind === 'video' ? ("), '视频走独立气泡分支');
  assert.ok(BUBBLE.includes('shareVideoFile(message.image)'), '点按交给系统分享（不引播放器依赖）');
  assert.ok(BUBBLE.includes("from 'expo-sharing'"), '分享能力来自既有依赖');
  assert.ok(COMPOSER.includes("item.kind === 'video' ? (") && COMPOSER.includes('videocam-outline'),
    '草稿条给视频独立图标');
});

test('集成点：草稿保护/清理的 image 白名单全部覆盖 video（防漏删）', () => {
  // useSessionSwitch：4 处保护集合 filter + 2 处切换清理
  assert.equal((SWITCH.match(/\(item\.kind === 'image' \|\| item\.kind === 'video'\)/g) || []).length, 4,
    '切换流程的保护集合必须含视频');
  assert.equal((SWITCH.match(/if \(item\.kind === 'video'\) deleteLocalVideo\(item\.uri\);/g) || []).length, 2,
    '切换失败/完成后的草稿清理必须含视频');
  assert.ok(SWITCH.includes('deleteLocalVideo'), '导入了视频删除');
  // useSessionMessages：落盘保护集合
  assert.ok(PARTICIPANT.includes("(item.kind === 'image' || item.kind === 'video')"),
    '写盘时的保护集合必须含视频');
});