// 桌面外壳结构守卫（S26）：聊天页三处页内比对（附件 / 搜索栏 / 群聊调度）。
//
// 结论：
//   · 搜索栏 **完全对齐**（词条与上下条跳转都在，桌面还多 Shift+Enter 反向查找）；
//   · 群聊调度 **已覆盖**（发言人选择/合议/简介生成全走共享 groupChat/*，
//     useChatSend 里 speakerIds → selectSpeakers 那条链桌面已在用）；
//   · 附件 **有一处真缺口**：桌面是三个常亮按钮，不按当前模型能力门控。
//     手机 AttachmentMenuModal 会把「拍照/相册/拍视频/视频」置灰并当场说明原因；
//     桌面要等用户选完文件、点发送时才被 useChatSend 拒掉（白选一次）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const COMPOSER = read('src', 'provider', 'ChatComposer.jsx');
const CAPS = read('src', 'chat', 'useDesktopAttachmentCaps.js');
const SEARCH_BAR = read('src', 'chat', 'ChatSearchBar.jsx');
const GROUP_MODEL = read('src', 'group', 'groupModel.js');
const GROUP_SETTINGS = read('src', 'group', 'GroupSettingsPanel.jsx');

// ---------------------------------------------------------------------------
// 三处面的控件清单
// ---------------------------------------------------------------------------
const CHAT_SURFACE = Object.freeze([
  // 附件：手机 OPTION_KEYS 五项
  { mobile: 'attach:text', status: 'done' },
  { mobile: 'attach:image', status: 'ported', note: '本轮补能力门控' },
  { mobile: 'attach:video', status: 'ported', note: '本轮补能力门控' },
  { mobile: 'attach:camera', status: 'denied', reason: 'no-camera' },
  { mobile: 'attach:video-camera', status: 'denied', reason: 'no-camera' },
  // 搜索栏
  { mobile: 'search:input', status: 'done' },
  { mobile: 'search:prev', status: 'done' },
  { mobile: 'search:next', status: 'done' },
  { mobile: 'search:close', status: 'done' },
  // 群聊调度
  { mobile: 'group:mode', status: 'done' },
  { mobile: 'group:members', status: 'done' },
  { mobile: 'group:mention', status: 'done' },
  { mobile: 'group:speakerName', status: 'done' },
  { mobile: 'group:profiles', status: 'done' },
]);

test('三处面的每个控件都有明确归属（denied 只允许是「无摄像头」）', () => {
  const denied = CHAT_SURFACE.filter(item => item.status === 'denied');
  assert.deepEqual(denied.map(item => item.mobile), ['attach:camera', 'attach:video-camera'],
    '排除项只能是拍照/拍视频（桌面无摄像头）');
  for (const item of denied) assert.equal(item.reason, 'no-camera');
});

test('附件：三入口（文本/图片/视频）都在，拍照两入口确实缺席', () => {
  for (const key of ['chat.attach.text.title', 'chat.attach.image.title', 'chat.attach.video.title']) {
    assert.ok(COMPOSER.includes(key), `附件缺 ${key}`);
  }
  // 拍照/拍视频依赖摄像头：桌面不提供，也不该假装有按钮。
  assert.ok(!/chat\.attach\.camera\.title/.test(COMPOSER), '不应出现拍照入口');
  assert.ok(!/chat\.attach\.videoCamera\.title/.test(COMPOSER), '不应出现拍视频入口');
});

test('附件：按当前模型能力置灰，口径与 useChatSend 完全一致', () => {
  assert.ok(COMPOSER.includes('useDesktopAttachmentCaps'), '未接入附件能力位');
  // 视觉/视频各一个阻塞位，且都要求 ready（避免加载期间闪灰）。
  assert.ok(/visionBlocked\s*=/.test(COMPOSER) && /videoBlocked\s*=/.test(COMPOSER),
    '缺视觉/视频阻塞位');
  assert.ok(/disabled=\{composerDisabled \|\| visionBlocked\}/.test(COMPOSER), '图片按钮未按能力禁用');
  assert.ok(/disabled=\{composerDisabled \|\| videoBlocked\}/.test(COMPOSER), '视频按钮未按能力禁用');
  // 置灰时 title 要说明原因（手机同款：visionRequired / videoRequired）。
  assert.ok(COMPOSER.includes('chat.attach.visionRequired'), '缺识图不可用说明');
  assert.ok(COMPOSER.includes('chat.attach.videoRequired'), '缺视频不可用说明');

  // 能力口径：must 与发送侧一致（video 还要 openai 协议）。
  assert.ok(CAPS.includes('capabilitiesForModel'), '未复用共享能力表');
  assert.ok(CAPS.includes('getActiveModel'), '未按当前模型解析');
  assert.ok(/supportsVision === true/.test(CAPS), '视觉口径应与发送侧一致');
  assert.ok(/supportsVideo === true[\s\S]{0,80}protocol/.test(CAPS),
    '视频口径必须含 openai 协议限定（video_url 是 OpenAI 兼容扩展）');
  // 走角色解析层：角色专属 API/模型会改变「当前模型是谁」。
  assert.ok(CAPS.includes('getCharacterApiConfigs'), '未走角色专属配置解析');
});

test('搜索栏：输入 / 上一条 / 下一条 / 关闭 四件齐全', () => {
  // 手机端搜索栏只有一个词条（输入框 placeholder），上/下/关闭都是图标按钮 +
  // 无障碍标签。桌面同理：placeholder 用 chat.search.*，关闭按钮复用 common.close。
  assert.ok(SEARCH_BAR.includes('chat.search.placeholder'), '搜索栏缺 placeholder');
  assert.ok(SEARCH_BAR.includes('common.close'), '搜索栏缺关闭按钮文案');
  assert.ok(/onPrev/.test(SEARCH_BAR) && /onNext/.test(SEARCH_BAR), '缺上下条跳转');
  assert.ok(/onClose/.test(SEARCH_BAR), '缺关闭');
  // 与手机词条完全一致（本轮 diff 为空）。
  const mobile = readRoot('src', 'chat', 'ChatSearchBar.js');
  const mobileKeys = [...mobile.matchAll(/t\('(chat\.search[a-zA-Z.]*)'\)/g)].map(m => m[1]);
  const desktopKeys = new Set([...SEARCH_BAR.matchAll(/t\('(chat\.search[a-zA-Z.]*)'\)/g)].map(m => m[1]));
  assert.ok(mobileKeys.length > 0, '手机搜索栏词条解析异常');
  for (const key of mobileKeys) assert.ok(desktopKeys.has(key), `搜索栏缺词条 ${key}`);
});

test('群聊调度：沿用共享实现，不在桌面重写选人/合议判定', () => {
  // 发言人选择与合议在共享 useChatSend 里（selectSpeakers / groupMode）。
  const send = readRoot('src', 'chat', 'useChatSend.js');
  assert.ok(send.includes('selectSpeakers'), '共享层应负责选人');
  assert.ok(/groupMode/.test(send), '共享层应负责合议/轮流分支');
  // 桌面的 speakerNameOf 只是**展示兜底**（消息自带 speakerName 优先），
  // 与共享 groupChat/profile.js 的「生成角色简介」是两件事 —— 不是重复实现。
  assert.ok(GROUP_MODEL.includes('message.speakerName'), '发言人显示应优先用消息自带的 speakerName');
  assert.ok(readRoot('src', 'chat', 'groupChat', 'profile.js').includes('needsProfile'),
    '简介生成应在共享层');
  // 群设置的发言人模式（合议/轮流）与成员增删都在。
  assert.ok(GROUP_SETTINGS.includes('group.mode.ensemble'), '缺合议/轮流切换');
  assert.ok(GROUP_SETTINGS.includes('setGroupMembers'), '缺成员增删');
  // 成员简介缓存由共享 useChatSend 驱动（桌面只提供 ref）。
  assert.ok(read('src', 'provider', 'useDesktopChat.js').includes('memberProfilesRef'),
    '缺成员简介缓存接线');
});