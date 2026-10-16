// FEAT-AC11 P1-3：工具失败结果的**一行摘要**（纯逻辑，零 RN 依赖 → Node 直测）。
//
// 为什么需要它：AC9 起 turn-tool 打点有了 ok=fail，但「**为什么**失败」仍然答不上来。
// 真机 17:40 round 7 两条 read_workspace_file 在 ~100ms 内失败，日志只写 ok=fail，
// 无法分辨「路径不存在」「越界」「被权限规则拒绝」——排查要多走一轮。
// 带上原因首行就能当场定罪。
//
// 为什么单独一个文件（而不是留在 loop.js 里）：loop.js 在 Node 测试里要靠
// Babel + Module._load 桩加载（它的静态链会拖进 expo-file-system）。摘要这条规则
// 值得被**直接**断言（取首行？脱敏？截断？顺序对不对？），所以按本仓既有纪律
// 把纯逻辑抽出来直测——留在 loop 里只能靠源码正则，而正则断言是出了名的会空转
//（本轮注入验证就抓到过：改坏取首行逻辑，日志断言照样通过，因为渲染层也取首行）。

import { maskSecrets } from '../storage/secrets.js';

// 摘要字符上限。为什么是 160：足够放下「路径不存在 / 权限被拒 / 越界」这类一句话原因，
// 又不至于把工具输出正文灌进诊断日志（那是落盘工具的职责）。
export const TOOL_FAILURE_SUMMARY_MAX = 160;

/**
 * 把工具失败结果压成一行可读原因。
 *
 * 处理链（顺序有意）：取 content → 取首行 → 脱敏 → 截断。
 * **先脱敏再截断**：反过来的话，一个跨在截断点上的密钥会被截成半截而躲过掩码。
 * 工具结果里可能夹带 API Key / 令牌（read_workspace_file 读到的正文、run_shell 的报错），
 * 与诊断落盘同一条纪律。**只取首行**：堆栈与多行正文不该进打点。
 *
 * @param {{content?: string}|null} outcome 工具结果
 * @returns {string} 一行摘要；算不出来时返回空串（打点不该因此抛）
 */
export function describeToolFailure(outcome) {
  const raw = outcome && outcome.content !== undefined && outcome.content !== null
    ? String(outcome.content)
    : '';
  if (!raw) return '';
  try {
    const firstLine = raw.split('\n')[0].trim();
    if (!firstLine) return '';
    return maskSecrets(firstLine).slice(0, TOOL_FAILURE_SUMMARY_MAX);
  } catch (error) {
    // 摘要算不出来不该影响打点主流程（宁可没有原因，也不能让打点抛）。
    return '';
  }
}
