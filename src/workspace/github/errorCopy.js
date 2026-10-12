// R0-4：错误码 → 一句话人话（纯函数 + 注入 t，Node 直测）。
//
// 旧版 describeError 只有一个 code→键映射：NETWORK（断流/超时）落到 generic
// 「GitHub 操作失败，请检查网络后重试」——用户不知道**已经自动重试过 3 次**，
// 于是人肉再重试；RATE_LIMIT 不折算 Retry-After；REPO_LIMIT_*（压缩包/条目/
// 解压总量超限）与网络问题文案相同。四类各自给可操作的一句话。
//
// 本模块零 RN 依赖：t 由调用方注入（UI 传 useTranslation 的 t，测试传查表函数）。

import { ZIP_RETRIES } from './restApi.js';

// 错误码 → i18n 文案键（后端只给 code，文案在这一层收口）。
export const GITHUB_ERROR_KEYS = {
  AUTH: 'workspace.github.err.auth',
  FORBIDDEN: 'workspace.github.err.forbidden',
  NOT_FOUND: 'workspace.github.err.notFound',
  RATE_LIMIT: 'workspace.github.err.rateLimit',
  INVALID: 'workspace.github.err.invalid',
  CONFLICT: 'workspace.github.err.conflict',
  INVALID_NAME: 'workspace.github.err.invalidName',
  DELETE_CONFIRM_REQUIRED: 'workspace.github.err.deleteConfirm',
};

export const GENERIC_ERROR_KEY = 'workspace.github.err.generic';

// 纯函数：带 code 的错误 → 界面文案。
//  · NETWORK：说明「已自动重试 {retries} 次」+ 整包重下语义（重试预算见 ZIP_RETRIES）；
//  · RATE_LIMIT：基础文案 + Retry-After 折算的「约 N 秒后可重试」（错误对象由
//    mapGithubError 挂 retryAfterMs；解析不出就不附）；
//  · REPO_LIMIT_* / REPO_EMPTY：仓库超限 → 建议缩小范围（换小仓库/快速检出）。
export function describeGithubError(caught, t) {
  const code = caught && caught.code;
  if (code === 'NETWORK') {
    return t('workspace.github.pull.retryHint', { retries: ZIP_RETRIES });
  }
  if (code === 'RATE_LIMIT') {
    const base = t('workspace.github.err.rateLimit');
    const afterMs = Number(caught && caught.retryAfterMs);
    if (Number.isFinite(afterMs) && afterMs > 0) {
      return `${base}${t('workspace.github.err.rateLimitWait', { seconds: Math.ceil(afterMs / 1000) })}`;
    }
    return base;
  }
  if (typeof code === 'string' && (code.startsWith('REPO_LIMIT_') || code === 'REPO_EMPTY')) {
    return t('workspace.github.err.repoLimit');
  }
  return t(GITHUB_ERROR_KEYS[code] || GENERIC_ERROR_KEY);
}
