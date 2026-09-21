export const SECRET_PATTERN = /(sk-[a-zA-Z0-9]{8,}|AIza[0-9A-Za-z\-_]{20,}|Bearer\s+[a-zA-Z0-9\-_.]+|Bot\s+[a-zA-Z0-9\-_.]+|xox[baprs]-[a-zA-Z0-9\-]+|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})/g;

// 实际使用过的密钥值登记表：只按前缀猜格式一定会漏（很多服务商的 Key 是无前缀的
// 随机串，authScheme 还是用户可自定义的），所以谁用到密钥就登记进来，
// 这样即使密钥以裸串形式出现在报错文本里也能被脱掉。
const registeredSecrets = new Set();
const MIN_SECRET_LENGTH = 8;

export function registerSecretValues(values) {
  const list = Array.isArray(values) ? values : [values];
  list.forEach(value => {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (text.length >= MIN_SECRET_LENGTH) registeredSecrets.add(text);
  });
}

export function clearRegisteredSecrets() {
  registeredSecrets.clear();
}

export function maskSecrets(text) {
  let output = String(text === null || text === undefined ? '' : text);
  if (!output) return output;
  registeredSecrets.forEach(secret => {
    if (secret && output.includes(secret)) {
      output = output.split(secret).join('[API_KEY已隐藏]');
    }
  });
  return output.replace(SECRET_PATTERN, '[API_KEY已隐藏]');
}
