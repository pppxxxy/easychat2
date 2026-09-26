import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'SettingsScreen.js'), 'utf8');
const EXTENSION_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'ExtensionScreen.js'), 'utf8');

test('全宽对话默认关闭，开启前弹窗提醒滑动风险', () => {
  // 默认值：存储层与 UI 初始 state 均为关闭（fullWidth === true 才开启）
  assert.ok(SETTINGS_SCREEN_SOURCE.includes('fullWidth: false'));
  // 开启时必须弹窗提醒用户「屏幕滑动」风险，确认后才落盘
  assert.ok(SETTINGS_SCREEN_SOURCE.includes('全宽模式下部分角色卡可能出现屏幕滑动问题'));
  // 确认弹窗：取消可退出，开关回弹；确认后才真正开启
  assert.ok(SETTINGS_SCREEN_SOURCE.includes("text: '取消', style: 'cancel'"));
  assert.ok(SETTINGS_SCREEN_SOURCE.includes("text: '仍然开启'"));
  // 关闭路径不需要确认，直接落盘
  assert.ok(SETTINGS_SCREEN_SOURCE.includes("updateChatOption('fullWidth', false)"));
});

test('世界分组内「互动」初始默认折叠', () => {
  // WorldView 的 openSection 初始为空串：进入页面先看到分组列表，
  // 不默认展开互动编辑面板（注意不能宽泛匹配 useState('')，
  // 同文件的 activeGameId 也用空串初始值）
  assert.ok(EXTENSION_SCREEN_SOURCE.includes("const [openSection, setOpenSection] = useState('')"));
  assert.equal(
    EXTENSION_SCREEN_SOURCE.includes("const [openSection, setOpenSection] = useState('interactive')"),
    false
  );
});
