// 制卡图片（头像 / 背景图）与「按图片生成角色」的守卫测试。
//
// 分两层：
// 1) 纯函数层（mediaPaths.js / forge.js 的 buildImageCardPrompt）——可直接断言行为；
// 2) 接线层（CardForgeEditor / CardForgeScreen / storage 归一化）——RN+FileSystem
//    无法在 Node 执行，按仓库惯例用源码断言锁链，防「加了字段但没落盘/没接线」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';

import {
  AVATAR_DIRECTORY,
  FORGE_MEDIA_DIRECTORY,
  buildForgeImageName,
  buildPromotedAvatarName,
  forgeImageExtension,
  forgeImageNamesToDelete,
  forgeMediaDirectory,
  isForgeMediaUri,
  isForgePayloadFileName,
} from '../src/cardForge/mediaPaths.js';
import { buildImageCardPrompt, createForgeDraft, draftFromCharacter, draftToCharacterPatch } from '../src/cardForge/forge.js';

const read = relPath => fs.readFileSync(path.resolve(relPath), 'utf8');
const DOC = 'file:///data/user/0/com.pppxxxy.easychat2/files/';

test('草稿图目录与 avatars 分离：只认草稿目录，绝不误删角色头像', () => {
  const forgeDir = forgeMediaDirectory(DOC);
  assert.equal(forgeDir, `${DOC}${FORGE_MEDIA_DIRECTORY}/`);
  assert.equal(forgeDir.includes(AVATAR_DIRECTORY), false, '草稿目录不得落在 avatars/ 下');

  assert.equal(isForgeMediaUri(`${forgeDir}avatar-1.jpg`, DOC), true);
  assert.equal(isForgeMediaUri(`${DOC}${AVATAR_DIRECTORY}old.jpg`, DOC), false, 'avatars/ 里的图不是草稿图');
  assert.equal(isForgeMediaUri('', DOC), false);
  assert.equal(isForgeMediaUri(null, DOC), false);
  // avatars/ 的路径不得被判成草稿图（否则导入时的提升与清理会误删用户头像）
  assert.equal(isForgeMediaUri(`${DOC}avatar-something/1.jpg`, DOC), false);
});

test('草稿图文件名可读且唯一，扩展名跟随 mime/uri', () => {
  assert.equal(buildForgeImageName({ key: 'avatarUri', now: 1000, random: () => 0, extension: '.png' }), 'avatar-1000-0.png');
  assert.equal(buildForgeImageName({ key: 'bgUri', now: 2000, random: () => 0, extension: '.jpg' }), 'bg-2000-0.jpg');
  const a = buildForgeImageName({ key: 'avatarUri', now: 1, random: () => 0.1 });
  const b = buildForgeImageName({ key: 'avatarUri', now: 2, random: () => 0.2 });
  assert.notEqual(a, b, '随机 + 时间戳必须保证不重名');
  assert.equal(forgeImageExtension('image/png', 'x.jpg'), '.png', 'mime 优先');
  assert.equal(forgeImageExtension('', `${DOC}a.PNG?t=1`), '.png', 'uri 后缀（忽略查询串）');
  assert.equal(forgeImageExtension('image/jpeg', 'a.jpg'), '.jpg');
  assert.equal(forgeImageExtension('', ''), '.jpg', '无法判定时退回 jpg');

  assert.match(buildPromotedAvatarName({ now: 5, random: () => 0, extension: '.png' }), /^forge-5-0\.png$/);
});

test('清理草稿图时跳过 .json 草稿载荷', () => {
  assert.equal(isForgePayloadFileName('forge-abc.json'), true);
  assert.equal(isForgePayloadFileName('avatar-1.jpg'), false);
  assert.deepEqual(
    forgeImageNamesToDelete(['a.jpg', 'forge-x.json', 'bg-2.png', '', null]),
    ['a.jpg', 'bg-2.png'],
    '载荷与空名必须被排除'
  );
  assert.deepEqual(forgeImageNamesToDelete(null), []);
});

test('草稿结构带上图片字段，且能往返角色与草稿', () => {
  const draft = createForgeDraft();
  assert.equal(draft.avatarUri, '');
  assert.equal(draft.bgUri, '');

  const fromCharacter = draftFromCharacter({ name: '甲', avatarUri: 'file:///a.jpg', bgUri: 'file:///b.jpg' });
  assert.equal(fromCharacter.avatarUri, 'file:///a.jpg');
  assert.equal(fromCharacter.bgUri, 'file:///b.jpg');

  const patch = draftToCharacterPatch(fromCharacter, { composedPrompt: 'sys' });
  assert.equal(patch.avatarUri, 'file:///a.jpg');
  assert.equal(patch.bgUri, 'file:///b.jpg');
});

test('按图生成角色的提示词：说明图片角色（头像/背景）并给出读图要求', () => {
  const onlyAvatar = buildImageCardPrompt({ hasAvatar: true, hasBg: false });
  assert.match(onlyAvatar, /第一张是角色的头像\/立绘/);
  assert.equal(onlyAvatar.includes('第二张'), false);
  assert.match(onlyAvatar, /从图片中读出外貌特征/);
  assert.match(onlyAvatar, /只输出一个 JSON 对象/);
  assert.match(onlyAvatar, /全部使用中文/);

  const both = buildImageCardPrompt({ hasAvatar: true, hasBg: true });
  assert.match(both, /第一张是角色的头像\/立绘/);
  assert.match(both, /第二张是角色的场景或背景/);

  const hint = buildImageCardPrompt({ hasAvatar: false, hasBg: true, hint: '清冷剑客' });
  assert.match(hint, /第一张是角色的场景或背景/, '只有背景时它是第一张');
  assert.match(hint, /用户的补充要求：清冷剑客/);
  // 超长补充要求要截断（与其它提示词同一口径，防注入式塞入）
  const long = buildImageCardPrompt({ hint: 'x'.repeat(1000) });
  assert.ok(long.includes('x'.repeat(400)));
  assert.equal(long.includes('x'.repeat(401)), false, '补充要求应截断到 400 字');
});

test('制卡编辑器：图片选择/清除/按图生成三处接线齐备', () => {
  const editor = read('src/CardForgeEditor.js');
  assert.match(editor, /import \{ deleteForgeImage, pickForgeImage \} from '\.\/cardForge\/media\.js'/, '导入草稿图工具');
  assert.match(editor, /onImageGenerate, visionAvailable = false/, '接收按图生成回调与识图能力开关');
  assert.match(editor, /await pickForgeImage\(\{ key \}\)/, '选择图片走 pickForgeImage');
  assert.match(editor, /await deleteForgeImage\(previous\)/, '换图时删除旧草稿副本');
  assert.match(editor, /pickImage\('avatarUri'\)/, '头像入口');
  assert.match(editor, /pickImage\('bgUri'\)/, '背景入口');
  assert.match(editor, /openImageGenerate\('avatar'\)/, '按头像生成入口');
  assert.match(editor, /openImageGenerate\('bg'\)/, '按背景生成入口');
  // 无识图能力时不展示按钮（避免点了才报错）
  assert.match(editor, /\{visionAvailable \? \(/, '按图生成按钮受识图能力门控');
  // 生成的补丁里图片字段保持不变（模型 JSON 不含图片路径）
  assert.match(editor, /const images = \{ avatarUri: form\.avatarUri \|\| '', bgUri: form\.bgUri \|\| '' \}/, '图片字段不被模型补丁覆盖');
  assert.match(editor, /source: 'easychat2-image-to-card'/, '按图生成应打自己的生成标识来源');
});

test('制卡编辑器选图带三重守卫（monkey 审查点 3）：卸载/换轮/过期结果都不写表单', () => {
  const editor = read('src/CardForgeEditor.js');
  // 闸门必须是 ref：setState 异步，同 tick 两次点击读到的还是旧值会开两个选择器
  assert.match(editor, /if \(imageBusyRef\.current\) return;/, '重入闸门用 ref 而非闭包布尔');
  assert.equal(/if \(imageBusy\) return;/.test(editor), false, '旧的闭包布尔闸门必须不复存在');
  assert.match(editor, /const imageBusyRef = useRef\(false\)/, 'imageBusyRef 声明');
  // 三重守卫：挂载标记 + 会话号 + 操作序号
  assert.match(editor, /const mountedRef = useRef\(true\)/, 'mountedRef 声明');
  assert.match(editor, /const editorSessionRef = useRef\(0\)/, 'editorSessionRef 声明');
  assert.match(editor, /const imageOperationRef = useRef\(0\)/, 'imageOperationRef 声明');
  assert.match(
    editor,
    /mountedRef\.current\s*\n\s*&& imageOperationRef\.current === operation\s*\n\s*&& editorSessionRef\.current === session/,
    'isCurrent 必须同时看挂载、操作序号与会话号'
  );
  // 过期结果：既不能写表单，也不能留下无人引用的草稿副本
  assert.match(
    editor,
    /if \(!isCurrent\(\)\) \{[\s\S]{0,240}deleteForgeImage\(uri\)/,
    '过期结果应丢弃并清理刚写入的草稿副本'
  );
  // 卸载与关闭都要让挂着的这一轮失效（关闭同样丢弃未保存改动，见 onClose 契约）
  assert.match(editor, /mountedRef\.current = false;\s*\n\s*editorSessionRef\.current \+= 1;/, '卸载时失效当前轮');
  assert.match(editor, /if \(wasVisible === visible\) return;/, '开与关都要推进会话号');
  assert.match(editor, /if \(isCurrent\(\)\) Alert\.alert\(t\('forge\.alert\.readImageFailed\.title'\)/, '失败提示只在仍是当前轮时弹');
  assert.equal(zhCN['forge.alert.readImageFailed.title'], '图片读取失败', '语言包中文值正确');
});

test('制卡屏：按图生成走真实多模态请求 + 导入时提升图片目录', () => {
  const screen = read('src/CardForgeScreen.js');
  // 多模态请求：文本 + image_url 一起发
  assert.match(screen, /type: 'image_url', image_url: \{ url: dataUri \}/, '图片必须作为 image_url 发出');
  assert.match(screen, /await readImageDataUri\(source\)/, '读取图片为 data URI');
  assert.match(screen, /buildImageCardPrompt\(\{ hint, hasAvatar, hasBg \}\)/, '提示词走纯函数');
  // 无识图能力明确拒绝，而不是悄悄发纯文字（能力按当前模型解析）
  assert.match(screen, /capabilitiesForModel\(current, current \? getActiveModel\(current\) : ''\)\.supportsVision === true/, '按当前模型解析识图能力');
  assert.match(screen, /t\('forge\.screen\.error\.visionUnsupported'\)/, '缺识图能力应明确报错（走 i18n 键）');
  assert.ok(zhCN['forge.screen.error.visionUnsupported'].includes('无法按图片生成角色'), '语言包中文值正确');
  // 导入角色库时提升目录（草稿目录 → avatars/）
  assert.match(screen, /promoteForgeImageToAvatar\(draft\.avatarUri/, '导入时提升头像');
  assert.match(screen, /promoteForgeImageToAvatar\(draft\.bgUri/, '导入时提升背景');
  assert.match(screen, /patch\.avatarUri = avatarUri/, '提升后的路径写回角色补丁');
  // 顺序必须是「复制到 avatars → 落库成功 → 才删草稿副本」：
  // 先删后落库的话，落库失败时草稿会指向已被删掉的文件（界面变破图）。
  const importBlock = screen.slice(
    screen.indexOf('const [avatarUri, bgUri] = await Promise.all('),
    screen.indexOf("t('forge.screen.note.imported'")
  );
  const promoteAt = importBlock.indexOf('promoteForgeImageToAvatar(draft.avatarUri');
  const createAt = importBlock.indexOf('await addCharacter(patch)');
  const cleanupAt = importBlock.indexOf('deleteForgeImage(draft.avatarUri');
  assert.ok(promoteAt >= 0 && createAt >= 0 && cleanupAt >= 0, '提升/落库/清理三步都应存在');
  assert.ok(promoteAt < createAt && createAt < cleanupAt, '顺序应为 提升 → 落库 → 清理草稿副本');
  assert.match(screen, /await update\(appendTranscript\(nextState/, '草稿路径要换成提升后的路径并落盘');
  // 重新开始时清理草稿图
  assert.match(screen, /await deleteForgeDraftImages\(\)/, '重新开始应清理草稿图');

  // 草稿载荷归一化必须带上图片字段，否则落盘再读回就丢图
  const storage = read('src/storage/cardForge.js');
  assert.match(storage, /draft\.avatarUri = String\(source\.avatarUri \|\| ''\)/, '归一化保留 avatarUri');
  assert.match(storage, /draft\.bgUri = String\(source\.bgUri \|\| ''\)/, '归一化保留 bgUri');
});

test('制卡草稿图不进孤儿回收扫描范围（目录选择的理由必须成立）', () => {
  // 回收器只扫这三个目录：草稿图若放在它们里面，保护窗口一过就会被当孤儿删掉。
  const storage = read('src/storage.js');
  const collect = storage.slice(storage.indexOf('export async function collectAvatarImageFiles'));
  assert.ok(collect.includes("avatars/"), '头像回收器扫 avatars/');
  assert.equal(
    storage.includes(`${FORGE_MEDIA_DIRECTORY}/`),
    false,
    'storage.js 的回收器不得扫描 card-forge/（草稿图要留到导入角色库）'
  );
});
