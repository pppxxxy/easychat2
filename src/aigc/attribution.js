// AI 生成合成内容标识（对应《人工智能生成合成内容标识办法》与
// GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》）：
// - 显式标识：界面可见的「本内容由 AI 生成」提示
// - 隐式标识：随角色卡导出的元数据（生成属性、制作工具、内容编号），可被识别追溯
// EasyChat2 是本地开源客户端，模型服务来自用户自行配置的 API——隐式标识里的
// producer 记录生成工具（EasyChat2），不冒充模型服务提供者。

export const AIGC_NOTICE_TEXT = '本内容由 AI 生成';
export const AIGC_META_FIELD = 'aigcMeta';

// 导出文件内的显式标识行：追加在 creator_notes 尾部（SillyTavern 等卡查看器可见）
export const AIGC_EXPORT_NOTICE = '—— 本卡片内容由 AI 生成（EasyChat2 制卡）';

export function buildAigcMeta({ model = '', generatedAt = Date.now(), contentCode = '', source = 'easychat2-card-forge' } = {}) {
  const timestamp = Number(generatedAt) || Date.now();
  return {
    label: AIGC_NOTICE_TEXT,
    producer: 'EasyChat2',
    producerCode: 'easychat2',
    source: String(source || 'easychat2-card-forge'),
    model: String(model || ''),
    contentCode: String(contentCode || makeContentCode(timestamp)),
    generatedAt: timestamp,
  };
}

// 内容编号：生成时间 + 随机段，同一工具产出的卡可唯一定位
function makeContentCode(generatedAt) {
  return `AIGC-${generatedAt.toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export function isValidAigcMeta(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value)
    && String(value.producer || '') && String(value.source || ''));
}

// creator_notes 尾部追加显式标识行；重复导出不叠加
export function appendExportNotice(creatorNotes) {
  const base = String(creatorNotes || '').trim();
  if (base.includes(AIGC_EXPORT_NOTICE)) return base;
  return base ? `${base}\n\n${AIGC_EXPORT_NOTICE}` : AIGC_EXPORT_NOTICE;
}

// ---- 知名 IP 关键词提示（降低侵权风险的提示层，不阻断同人创作）----
// 命中仅提醒用户自行确认责任，与免责条款的「用户责任自负」呼应；
// 黑名单不求穷尽——它挡不住刻意规避，只把最常见的误碰拦下来提示。
const IP_KEYWORDS = [
  // 米哈游
  '原神', '崩坏：星穹铁道', '崩坏星穹铁道', '星穹铁道', '崩坏3', '崩坏三', '绝区零',
  // 其他知名游戏
  '明日方舟', '少女前线', '碧蓝航线', '蔚蓝档案', 'fate', 'fgo', '型月', '东方project',
  '宝可梦', '精灵宝可梦', '口袋妖怪', '皮卡丘', '任天堂', '塞尔达', '马里奥',
  '最终幻想', '克劳德', '艾尔登法环', '黑暗之魂', '赛博朋克2077', '巫师3', '杰洛特',
  '英雄联盟', '王者荣耀', '和平精英', '蛋仔派对', '我的世界',
  // 知名动漫/影视 IP
  '火影忍者', '海贼王', '咒术回战', '进击的巨人', '鬼灭之刃', '名侦探柯南', '哆啦A梦',
  '龙珠', '蜡笔小新', '灌篮高手', '新世纪福音战士', 'eva', '刀剑神域', '辉夜大小姐',
  '迪士尼', '皮克斯', '漫威', 'marvel', 'dc漫画', '蝙蝠侠', '超人', '蜘蛛侠',
  '哈利波特', '星球大战', '霍格沃茨', '指环王', '魔戒',
  // 虚拟歌手/偶像
  '初音未来', 'miku', '洛天依', '嘉然', '向晚', '乃琳', '贝拉', '珈乐',
];

export function findIpKeywords(texts) {
  const source = (Array.isArray(texts) ? texts : [texts])
    .map(item => String(item || '').toLowerCase())
    .join('\n');
  if (!source.trim()) return [];
  const hits = new Set();
  for (const keyword of IP_KEYWORDS) {
    if (keyword && source.includes(keyword.toLowerCase())) hits.add(keyword);
  }
  return [...hits];
}

// 命中提示文案：明确「不阻断、责任自负」与真实人物风险
export function ipKeywordNotice(hits) {
  const list = (Array.isArray(hits) ? hits : []).slice(0, 8).join('、');
  return `生成的卡片中检测到可能与知名 IP 相似的名称：${list}。`
    + 'AI 生成内容与既有作品相似可能存在版权风险，请自行确认有权使用后再保存或传播，相关责任由你自行承担。'
    + '若内容涉及真实人物姓名，请额外注意肖像权与名誉风险。';
}
