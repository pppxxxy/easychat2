// 桌面外壳结构守卫（S14）：自动备份 + 群聊 @提及。
//
// 这两项都是「共享层早有、桌面缺界面」：
//   · 自动备份：backup/autoBackupRun.js 的 runAutoBackup + policy 的到期判定，
//     桌面只差设置卡与一个应用内定时器；
//   · @提及：chat/groupMentions.js 的 parseMentions 一直在 useChatSend 的群聊路径里，
//     桌面缺的只是「往输入框插 @名字」的面板。
// 本文件钉住二者都已接线，且**没有**在桌面重写共享层的判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

const SETTINGS = read(DESKTOP, 'src', 'settings', 'SettingsScreen.jsx');
const AUTO_BACKUP = read(DESKTOP, 'src', 'settings', 'AutoBackupCard.jsx');
const PANE = read(DESKTOP, 'src', 'provider', 'ChatPane.jsx');
const MENTION = read(DESKTOP, 'src', 'group', 'MentionPicker.jsx');
const MOBILE_ORDER = read(ROOT, 'src', 'settings', 'sectionOrder.js');

test('自动备份在设置页，且位置与手机 SECTION_RENDER_ORDER 一致', () => {
  assert.ok(SETTINGS.includes("id: 'autoBackup', key: 'settings.autoBackup.title'"), '设置页缺自动备份分区');
  // 手机顺序：… security → autoBackup → language → about。桌面没有 security/language 分区，
  // 但相对位置必须保持：autoBackup 在 about 之前。
  assert.ok(MOBILE_ORDER.includes("'autoBackup'"), '手机侧自动备份分区不存在了，请复核');
  const ids = [...SETTINGS.matchAll(/id: '([a-zA-Z]+)', key:/g)].map(m => m[1]);
  assert.ok(ids.indexOf('autoBackup') >= 0, '缺 autoBackup 分区');
  assert.ok(ids.indexOf('autoBackup') < ids.indexOf('about'), 'autoBackup 必须在 about 之前');
});

test('自动备份复用共享执行器，不自己实现导出/淘汰/到期判定', () => {
  assert.ok(AUTO_BACKUP.includes("from '../../../src/backup/autoBackupRun.js'"), '未复用共享执行器');
  assert.ok(AUTO_BACKUP.includes("from '../../../src/backup/autoBackupPolicy.js'"), '未复用共享策略');
  assert.ok(AUTO_BACKUP.includes('runAutoBackup('), '缺实际执行入口');
  // 依赖装配已外提到 desktopAutoBackupDeps.js（卡片与调度器共用一份，避免漂移）：
  // 判据改成「卡片经那份装配接线」，比直接找 createAutoBackupDeps( 更准。
  assert.ok(AUTO_BACKUP.includes('createDesktopAutoBackupDeps'), '未按共享层的依赖装配方式接线');
  assert.ok(read(DESKTOP, 'src', 'settings', 'desktopAutoBackupDeps.js').includes('createAutoBackupDeps('),
    '装配模块未调用共享 createAutoBackupDeps');
  // 到期判定必须用 isAutoBackupDue（唯一口径），不能在界面里自己算时间差。
  assert.ok(AUTO_BACKUP.includes('isAutoBackupDue('), '缺共享层到期判定');
  assert.equal(
    /lastBackupAt \|\| 0\) \+ Number\(current\.intervalMs/.test(AUTO_BACKUP),
    false,
    '不应在界面里重算到期（会与调度器口径漂移）'
  );
  // 设置读写走 storage/autoBackup（patch 语义，不整表覆盖）。
  assert.ok(AUTO_BACKUP.includes('patchAutoBackupSettings'), '未用 patch 语义写设置');
});

test('自动备份如实说明桌面只支持应用私有目录', () => {
  // 手机有 SAF（content:// 目录授权）；桌面没有可长期持有的目录句柄，
  // 界面必须说明这一点而不是给出一个会静默失败的「选择文件夹」。
  assert.ok(AUTO_BACKUP.includes("t('desktop.autoBackup.hint')"), '缺桌面差异说明');
  assert.ok(AUTO_BACKUP.includes("t('settings.autoBackup.folder.app')"), '未标明目标为应用私有目录');
  // 「选择文件夹」按钮在这里是「打开该目录」，不是手机那种 SAF 选择器。
  assert.equal(
    /pickAutoBackupDirectory|selectDirectory/.test(AUTO_BACKUP),
    false,
    '不应假装支持 SAF 目录选择'
  );
});

test('群聊 @ 提及复用共享解析，且只在群聊出现', () => {
  assert.ok(MENTION.includes("t('chat.mention.title')"), '提及面板缺标题');
  // 面板只负责插入文本；@ → 角色 id 的映射在共享层 parseMentions（发送路径里）。
  // 只查 import 行：注释里提到 parseMentions 是允许的（说明职责归属）。
  assert.equal(
    /import .*from '.*groupMentions\.js'/.test(MENTION),
    false,
    '提及面板不应自己解析 @ 名字（共享层已负责）'
  );
  // 只在群聊渲染（单聊没有「成员」概念）。
  const mentionMount = PANE.slice(PANE.indexOf('<MentionPicker'));
  assert.ok(mentionMount.length > 0, '聊天面板未挂载提及面板');
  assert.ok(
    PANE.indexOf('{isGroup ? (') < PANE.indexOf('<MentionPicker'),
    '提及面板必须在 isGroup 分支内'
  );
  // 插入的文本要能被 parseMentions 的正则命中：@名字 后跟空格。
  assert.ok(MENTION.includes('`@${name}`'), '插入格式应为 @名字');
});

test('扩展子页面没有绕过共享层的损坏保护（复核全局）', () => {
  const dir = path.join(DESKTOP, 'src', 'extension', 'screens');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsx')) continue;
    const full = path.join(dir, name);
    if (!statSync(full).isFile()) continue;
    const source = readFileSync(full, 'utf8');
    assert.equal(
      /AsyncStorage\.setItem/.test(source),
      false,
      `${name} 直接写 AsyncStorage，绕过了串行队列与读坏守卫`
    );
  }
});