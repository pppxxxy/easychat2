export const SECRET_PATTERN = /(sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9\-_]+)/g;

export function maskSecrets(text) {
  return String(text || '').replace(SECRET_PATTERN, '[API_KEY已隐藏]');
}
