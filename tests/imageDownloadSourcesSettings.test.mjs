// 图片来源设置接线契约（2026-10-21）：UI / 存储 / 下载 / 提示词四段必须串起来，
// 且「空名单 = 不限制、非空 = 严格白名单」的语义只在一处纯函数里定义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = rel => readFileSync(path.resolve(rel), 'utf8');

test('图片来源 UI：折叠区、添加/移除、引用页与错误文案都接线', () => {
  const section = read('src/settings/sections/ExtensionsSection.js');
  assert.ok(section.includes("t('settings.downloadImage.sources.title')"), '折叠区标题');
  assert.ok(section.includes('onPress={submitImageSource}'), '添加按钮');
  assert.ok(section.includes('removeImageSource(source.host)'), '移除入口');
  assert.ok(section.includes("t('settings.downloadImage.sources.refererHint')"), '引用页说明');
  assert.ok(section.includes("t('settings.downloadImage.sources.limit')"), '上限文案');
  assert.ok(section.includes('count={Array.isArray(imageDownloadSources)'), '折叠头显示条数');

  const screen = read('src/SettingsScreen.js');
  assert.ok(screen.includes('useImageDownloadSources()'), '设置页只调 hook');
  assert.ok(screen.includes('...imageDownloadSourcesProps'), '整包透传给扩展区');
});

test('来源存储：独立键 / 损坏读侧回落 / 写侧拒绝覆盖 / 上限错误带 code', () => {
  const hook = read('src/settings/useImageDownloadSources.js');
  assert.ok(hook.includes('addImageDownloadSourceEntry'), 'hook 接增');
  assert.ok(hook.includes("error.code === 'IMAGE_SOURCE_LIMIT'"), '上限按 code 区分');

  const storage = read('src/storage/settings/imageDownloadSources.js');
  assert.ok(storage.includes('@easychat2_image_download_sources'), '独立存储键');
  assert.ok(storage.includes("status === 'corrupt'"), '损坏状态保留');
  assert.ok(storage.includes('requireSourcesForMutation'), '写路径守卫');
  assert.ok(storage.includes("'IMAGE_SOURCE_LIMIT'"), '上限错误 code');
});

test('下载链：策略外提 / 白名单拒绝带 code / 请求头真正传进 downloadAsync', () => {
  const chat = read('src/ChatScreen.js');
  assert.ok(chat.includes('downloadImageWithSources(url, { t })'), '聊天页只调策略函数');

  const policy = read('src/chat/imageDownloadPolicy.js');
  assert.ok(policy.includes('isImageDownloadHostAllowed'), '按名单判定');
  assert.ok(policy.includes("denied.code = 'DOWNLOAD_IMAGE_BLOCKED'"), '拒绝原因带 code');
  assert.ok(policy.includes('buildImageDownloadHeaders'), '请求头来自命中来源');

  const attachments = read('src/chat/attachments.js');
  assert.ok(attachments.includes('headers = null'), 'downloadRemoteImage 接受请求头');
  assert.ok(attachments.includes('downloadOptions'), '请求头传进 FileSystem.downloadAsync');

  const runner = read('src/chat/imageDownloadRunner.js');
  assert.ok(runner.includes("error.code === 'DOWNLOAD_IMAGE_BLOCKED'"), '被拒时显示具体原因');
});

test('提示词与注入：名单只在一处生成 / 单聊与群聊都透传', () => {
  const send = read('src/chat/useChatSend.js');
  assert.ok(
    (send.match(/downloadImageSources: (inject|groupInject)\.downloadImageSources/g) || []).length >= 2,
    '单聊 + 群聊各一行透传'
  );

  const injections = read('src/chat/chatInjections.js');
  assert.ok(injections.includes('getImageDownloadSources'), '注入层现读名单');
  assert.ok(injections.includes('downloadImageSources'), '注入结果带名单');

  const group = read('src/chat/groupChat/context.js');
  assert.ok(group.includes('downloadImageSources'), '群聊上下文透传');

  const prompt = read('src/prompt/chatPipeline.js');
  assert.ok(prompt.includes('buildDownloadImageInstruction'), '措辞由名单决定');
  assert.ok(prompt.includes('用户已允许从这些图片来源下载'), '有名单时的授权措辞');
  assert.ok(prompt.includes('只在对话上下文中确实出现过'), '无名单时保留旧严格措辞');
});

test('i18n：中英词条成对存在（漏一个就会在另一种语言下显示 key）', () => {
  const keys = [
    'settings.downloadImage.sources.title',
    'settings.downloadImage.sources.hint',
    'settings.downloadImage.sources.empty',
    'settings.downloadImage.sources.hostLabel',
    'settings.downloadImage.sources.hostPlaceholder',
    'settings.downloadImage.sources.refererLabel',
    'settings.downloadImage.sources.refererPlaceholder',
    'settings.downloadImage.sources.refererHint',
    'settings.downloadImage.sources.refererMeta',
    'settings.downloadImage.sources.add',
    'settings.downloadImage.sources.remove',
    'settings.downloadImage.sources.invalid',
    'settings.downloadImage.sources.limit',
    'settings.downloadImage.sources.failed',
  ];
  const zh = read('src/i18n/locales/zh-CN/settings.js');
  const en = read('src/i18n/locales/en/settings.js');
  keys.forEach(key => {
    assert.ok(zh.includes(`'${key}'`), `zh 缺 ${key}`);
    assert.ok(en.includes(`'${key}'`), `en 缺 ${key}`);
  });
  const zhChat = read('src/i18n/locales/zh-CN/chat.js');
  const enChat = read('src/i18n/locales/en/chat.js');
  assert.ok(zhChat.includes("'chat.downloadImage.blocked'"));
  assert.ok(enChat.includes("'chat.downloadImage.blocked'"));
});
