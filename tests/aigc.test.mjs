import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  AIGC_EXPORT_NOTICE,
  AIGC_META_FIELD,
  AIGC_NOTICE_TEXT,
  appendExportNotice,
  buildAigcMeta,
  findIpKeywords,
  ipKeywordNotice,
  isValidAigcMeta,
} from '../src/aigc/attribution.js';
import { DISCLAIMER_SECTIONS, DISCLAIMER_TEXT } from '../src/onboarding/disclaimerContent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSource = name => readFileSync(path.join(HERE, '..', ...name), 'utf8');
const FORGE_SCREEN = readSource(['src', 'CardForgeScreen.js']);
const FORGE_EDITOR = readSource(['src', 'CardForgeEditor.js']);
const CHARACTER_SCREEN = readSource(['src', 'character', 'CharacterLibraryScreen.js']);
const CARD_EXPORTER = readSource(['src', 'character', 'cardExporter.js']);
const MOMENTS_VIEW = readSource(['src', 'MomentsView.js']);
const IMAGE_GEN = readSource(['src', 'ImageGenScreen.js']);
const STORAGE_SETTINGS = readSource(['src', 'storage', 'settings.js']);
const README = readSource(['README.md']);
const DISCLAIMER = DISCLAIMER_TEXT;

test('生成标识元数据：字段完整、来源可自定义、编号可追溯', () => {
  const meta = buildAigcMeta({ model: 'deepseek-chat', generatedAt: 1700000000000 });
  assert.equal(meta.label, AIGC_NOTICE_TEXT);
  assert.equal(meta.producer, 'EasyChat2');
  assert.equal(meta.producerCode, 'easychat2');
  assert.equal(meta.source, 'easychat2-card-forge');
  assert.equal(meta.model, 'deepseek-chat');
  assert.equal(meta.generatedAt, 1700000000000);
  assert.match(meta.contentCode, /^AIGC-[A-Z0-9]+-[A-Z0-9]+$/);
  // 字段级辅助生成使用独立来源
  const assisted = buildAigcMeta({ source: 'easychat2-field-assist' });
  assert.equal(assisted.source, 'easychat2-field-assist');
  // 合法性校验：缺 producer/source 的对象不算标识
  assert.equal(isValidAigcMeta(meta), true);
  assert.equal(isValidAigcMeta(null), false);
  assert.equal(isValidAigcMeta({ producer: 'x' }), false);
  assert.equal(isValidAigcMeta([meta]), false);
  assert.equal(AIGC_META_FIELD, 'aigcMeta');
});

test('导出显式标识：追加到 creator_notes 尾部且不重复叠加', () => {
  assert.equal(appendExportNotice(''), AIGC_EXPORT_NOTICE);
  assert.equal(appendExportNotice('备注'), `备注\n\n${AIGC_EXPORT_NOTICE}`);
  // 重复导出不叠加
  const once = appendExportNotice('备注');
  assert.equal(appendExportNotice(once), once);
  assert.ok(AIGC_EXPORT_NOTICE.includes('本卡片内容由 AI 生成'));
});

test('知名 IP 关键词扫描：命中、大小写与多字段输入', () => {
  assert.deepEqual(findIpKeywords('一个叫晚星的原创角色'), []);
  assert.ok(findIpKeywords('她是原神里的角色').includes('原神'));
  assert.ok(findIpKeywords('设定参考 FATE 的从者').includes('fate'));
  // 多字段拼接、去重
  const hits = findIpKeywords(['名字里有皮卡丘', '场景是宝可梦世界']);
  assert.ok(hits.includes('皮卡丘'));
  assert.ok(hits.includes('宝可梦'));
  assert.deepEqual(findIpKeywords([null, '', undefined]), []);
});

test('IP 命中提示：列出来词并声明责任自负', () => {
  const text = ipKeywordNotice(['原神', '皮卡丘']);
  assert.ok(text.includes('原神、皮卡丘'));
  assert.ok(text.includes('版权风险'));
  assert.ok(text.includes('责任由你自行承担'));
  assert.ok(text.includes('真实人物'));
});

test('制卡 AI 路径统一打标并做 IP 提示', () => {
  // 两条整卡 AI 路径（生成、问答改写）都经过 applyAigcAttribution
  assert.ok(FORGE_SCREEN.includes('applyAigcAttribution(draft, model)'));
  assert.equal((FORGE_SCREEN.match(/applyAigcAttribution\(draft, model\)/g) || []).length, 2);
  assert.ok(FORGE_SCREEN.includes('activeForgeModel'));
  assert.ok(FORGE_SCREEN.includes("Alert.alert('版权风险提示'"));
  // 字段辅助生成同样写生成标识（source 区分）
  assert.ok(FORGE_EDITOR.includes("source: 'easychat2-field-assist'"));
  // 编辑器界面有显式标识提示（引用 AIGC_NOTICE_TEXT 常量）与内容编号徽标
  assert.ok(FORGE_EDITOR.includes('${AIGC_NOTICE_TEXT}'));
  assert.ok(FORGE_EDITOR.includes('内容编号'));
});

test('AI 生成卡的角色页徽标与导出注入', () => {
  // 角色页：aigcMeta 存在时显示徽标。
  // 2026-10-05 CharacterScreen 拆分为 CharacterStack + character/CharacterLibraryScreen.js
  // （列表页，页头徽标在这里）与 character/CharacterDetailScreen.js（编辑表单），
  // 断言目标随之改指列表页，约束不变。
  assert.ok(CHARACTER_SCREEN.includes('本卡由 AI 生成'));
  // 导出：显式标识进 creator_notes，隐式标识进 extensions.easychat2.aigc_meta
  assert.ok(CARD_EXPORTER.includes('appendExportNotice(String(source.creatorNotes || \'\')'));
  assert.ok(CARD_EXPORTER.includes('aigc_meta: aigcMeta'));
  assert.ok(CARD_EXPORTER.includes('isValidAigcMeta(source.aigcMeta)'));
  // 制卡导入链路把 aigcMeta 带进角色库
  assert.ok(readSource(['src', 'cardForge', 'forge.js']).includes('aigcMeta: source.aigcMeta'));
});

test('动态与生图界面有 AI 生成显式标识', () => {
  assert.ok(MOMENTS_VIEW.includes('动态与回复由 AI 生成'));
  assert.ok(IMAGE_GEN.includes('画廊中的图片由 AI 生成'));
  // 聊天页提示行（既有合规项保持）。文案常量 2026-09-27 随 ChatScreen 拆分
  // 移至 src/chat/chatConstants.js，断言改指向新文件、约束不变。
  assert.ok(readSource(['src', 'chat', 'chatConstants.js']).includes('AI 生成可能有误，仅供参考'));
});

test('免责声明带版本号：条款更新后存量用户需重新确认', () => {
  // 免责声明常量 2026-09-28 随 storage 拆分移至 src/storage/settings.js，断言改指向新文件。
  assert.ok(STORAGE_SETTINGS.includes('export const DISCLAIMER_VERSION = 3;'));
  assert.ok(STORAGE_SETTINGS.includes('return raw === String(DISCLAIMER_VERSION);'));
  assert.ok(STORAGE_SETTINGS.includes('String(DISCLAIMER_VERSION)'));
  // 既有合规项：标识保留、禁止用途、技术局限
  assert.ok(DISCLAIMER.includes('不得擅自删除、篡改或隐匿 AI 生成标识'));
  assert.ok(DISCLAIMER.includes('仅供个人虚构创作与测试使用，不得用于商业用途'));
  assert.ok(DISCLAIMER.includes('受限于现有技术，AI 生成的内容可能不准确'));
  assert.ok(DISCLAIMER.includes('用户对 AI 生成内容的真实性、合法性、准确性自行承担全部责任'));
  // 2026-10-02 补强项：行为规范、隐私事实、按现状、责任限制、第三方可用性、投诉与变更
  assert.ok(DISCLAIMER.includes('不得诱导 AI 生成违反法律法规或社会主义核心价值观的内容'));
  assert.ok(DISCLAIMER.includes('不接入任何分析、广告或遥测 SDK，也不采集设备标识符'));
  assert.ok(DISCLAIMER.includes('按「现状（AS IS）」提供'));
  assert.ok(DISCLAIMER.includes('间接、附带、特殊、惩罚性或后果性损害'));
  assert.ok(DISCLAIMER.includes('开发者不承担由此产生的责任'));
  assert.ok(DISCLAIMER.includes('不代表开发者的观点、立场或建议'));
  assert.ok(DISCLAIMER.includes('个人敏感信息'));
  assert.ok(DISCLAIMER.includes('语音转写（录音音频）'));
  assert.ok(DISCLAIMER.includes('通过仓库 Issues 提交投诉'));
  // 结构化条款与纯文本同源：新增章节必须同时出现在两处
  const titles = DISCLAIMER_SECTIONS.map(section => section.title);
  for (const title of ['用户行为规范', '数据与隐私', '责任限制', '服务变更与投诉']) {
    assert.ok(titles.includes(title), `结构化条款缺少「${title}」节`);
  }
});

test('README 披露功能与风险、提供投诉与 DMCA 声明', () => {
  // 功能说明含 AI 制卡
  assert.ok(README.includes('AI 制卡'));
  // 风险披露
  assert.ok(README.includes('与知名 IP、受版权保护的作品存在相似性'));
  assert.ok(README.includes('删除标识后传播产生的法律后果由用户自行承担'));
  // 侵权投诉入口与 DMCA
  assert.ok(README.includes('侵权投诉'));
  assert.ok(README.includes('github.com/pppxxxy/easychat2/issues'));
  assert.ok(README.includes('DMCA'));
  assert.ok(README.includes('避风港'));
  // 许可证已由 AGPL-3.0 变更为 Apache-2.0：LICENSE 为 Apache 2.0 全文，
  // README 保留变更声明（历史版本仍受 AGPL-3.0 约束）。
  const license = readSource(['LICENSE']);
  assert.ok(license.includes('Apache License'));
  assert.ok(license.includes('Version 2.0, January 2004'));
  assert.ok(README.includes('License Change Notice'));
  assert.ok(README.includes('Apache-2.0'));
});
