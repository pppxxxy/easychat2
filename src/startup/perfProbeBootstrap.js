// 启动时把**持久化**的卡顿取证开关同步到探针（perfProbe 的 enabled 是内存态）。
//
// 为什么需要这一步：用户在诊断面板里打开开关、重启 App 去复现卡顿——若启动时不同步，
// 重启后探针又回到默认关闭，复现出来一条样本都没有，取证工具等于无效。
//
// read / apply 可注入：这让本模块能在没有 AsyncStorage、也没有界面的 Node 环境里直测
// （与 startup/ 下其它模块同口径：只做接线，逻辑尽量薄）。
import { setPerfProbeEnabled } from '../logging/perfProbe.js';
import { getPerfProbeEnabled } from '../storage/settings/perfProbe.js';

export async function bootstrapPerfProbe({
  read = getPerfProbeEnabled,
  apply = setPerfProbeEnabled,
} = {}) {
  try {
    const enabled = await read();
    apply(enabled === true);
    return enabled === true;
  } catch (error) {
    // 读不出来就**明确关掉**（而不是保持原状）：确定性的「关闭」好过让探针停在一个
    // 说不清的状态。探针是取证工具，它自己失败绝不能影响启动，所以这里吞掉异常。
    try {
      apply(false);
    } catch (applyError) {}
    return false;
  }
}
