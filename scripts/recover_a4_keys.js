// 从 git diff 反推缺失键的中文文案：A4 子代理改了代码但没写键清单。
// 对每个文件，git diff 里 '-' 行含中文，'+' 行含 t() 键名；按 hunk 配对。
// 用法：node scripts/recover_a4_keys.js
// 输出：D:\命令提示符\.easychat2-test\i18n-keys\a4-recovered.json

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = 'D:\\命令提示符\\.easychat2-test\\i18n-keys\\a4-recovered.json';

// A4 改过的文件（从 git status 确认）
const A4_FILES = [
  'src/LocalModelPanel.js',
  'src/PresetPanel.js',
  'src/BackupPanel.js',
  'src/TtsPanel.js',
  'src/PluginPanel.js',
  'src/DiagnosticsModal.js',
  'src/SessionRecoveryModal.js',
  'src/OnboardingModal.js',
  'src/TutorialModal.js',
  'src/onboarding/disclaimer.js',
  'src/settings/SamplingCard.js',
  'src/settings/useUserProfile.js',
  'src/settings/useVectorSettings.js',
  'src/localModel/ModelSearchModal.js',
  'src/localModel/ModelLogsModal.js',
];

function extractChinese(text) {
  // 提取引号内的中文文本
  const matches = [];
  for (const m of text.matchAll(/['"`]([^'"`]*[\u4e00-\u9fff][^'"`]*)['"`]/g)) {
    matches.push(m[1]);
  }
  return matches;
}

function extractKeys(text) {
  const keys = [];
  for (const m of text.matchAll(/\bt(?:Active)?\(\s*'([^']+)'/g)) {
    keys.push(m[1]);
  }
  return keys;
}

const result = {};

for (const file of A4_FILES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  const diff = execSync(`git diff HEAD -- "${file}"`, { cwd: ROOT, encoding: 'utf8' });
  // 按 hunk 分割
  const hunks = diff.split(/^@@/m).slice(1);
  for (const hunk of hunks) {
    const lines = hunk.split('\n');
    const removed = [];
    const added = [];
    for (const line of lines) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        removed.push(...extractChinese(line.slice(1)));
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        added.push(...extractKeys(line.slice(1)));
      }
    }
    // 配对：同 hunk 里按键名和中文字符串数量对齐
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i++) {
      const key = added[i];
      const zh = removed[i];
      if (!result[key]) {
        result[key] = { zh, en: '' }; // en 留空，后续手工/AI 翻译
      }
    }
  }
}

// 对 en 为空的键，生成简单翻译（占位，后续可精修）
for (const [key, val] of Object.entries(result)) {
  if (!val.en) {
    // 简单规则：用键名最后一段作为英文基础
    const lastPart = key.split('.').pop();
    val.en = lastPart.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
    val._auto = true; // 标记需要人工精修
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
console.log(`恢复 ${Object.keys(result).length} 个键 → ${OUT}`);
console.log(`其中需要人工精修英文的: ${Object.values(result).filter(v => v._auto).length}`);
