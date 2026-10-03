// 尽力而为的格式兜底：真正的保障是 registerSecretValues 登记表。这里覆盖常见前缀，
// 并放宽字符集——`sk-` 后允许 `-`（OpenAI sk-proj-/sk-svcacct-、Anthropic sk-ant-），
// Bearer/Bot 允许 base64 的 +/=。Bearer/Bot 要求后接 ≥8 字符 token，避免误伤散文。
export const SECRET_PATTERN = /(\bsk-[A-Za-z0-9_-]{8,}|\bAIza[0-9A-Za-z\-_]{20,}|\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}|\bBot\s+[A-Za-z0-9\-._~:=]{8,}|\bxox[baprs]-[A-Za-z0-9-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bhf_[A-Za-z0-9]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\bya29\.[A-Za-z0-9_-]+|\bAKIA[0-9A-Z]{16})/gi;

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
  [...registeredSecrets]
    .sort((left, right) => right.length - left.length)
    .forEach(secret => {
      if (secret && output.includes(secret)) {
        output = output.split(secret).join('[API_KEY已隐藏]');
      }
    });
  return output.replace(SECRET_PATTERN, '[API_KEY已隐藏]');
}
