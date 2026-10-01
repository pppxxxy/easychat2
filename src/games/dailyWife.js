// 「今日老婆/老公」纯函数：按「本地日期 + 称呼」稳定抽取一位角色。
// 同一天同称呼固定同一位（今日语义），跨天或换称呼各自独立。

// 稳定字符串 hash（djb2）：seed 相同结果恒定。
export function hashSeed(text) {
  const source = String(text || '');
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = (Math.imul(hash, 33) ^ source.charCodeAt(index)) >>> 0;
  }
  return hash;
}

// 本地日期 YYYY-MM-DD（非 UTC），跨天自动换人。
export function buildDailyDateStr(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// 按日期 + 称呼从角色库抽取一位；空库/非法输入返回 null。
// 抽取范围是传入的全部角色（含初始卡），过滤非法项后稳定取模。
export function pickDailyCharacter(characters, dateStr, mode = 'wife') {
  const list = (Array.isArray(characters) ? characters : [])
    .filter(item => item && typeof item === 'object');
  if (list.length === 0) return null;
  const seed = hashSeed(`${buildDailyDateStrSafe(dateStr)}\u0000${mode === 'husband' ? 'husband' : 'wife'}`);
  return list[seed % list.length];
}

function buildDailyDateStrSafe(dateStr) {
  const value = String(dateStr || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : buildDailyDateStr(new Date());
}
