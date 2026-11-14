// 首启门禁（桌面）：免责声明 → 教程 → 主界面。
//
// 顺序与手机 App.js 的 StartupFlow 完全一致：
//   未同意免责条款 → 'disclaimer'
//   同意但没看完教程 → 'onboarding'
//   都完成 → 'done'
// 读失败一律回落到 'disclaimer'（fail-closed：宁可让用户再看一次条款，
// 也不要在他没同意时直接放进主界面）。
//
// 抽成 hook 的理由与 useDesktopNotificationJump 相同：主壳已到 800 行棘轮，
// 而这段与「主界面长什么样」无关。
import { useEffect, useState } from 'react';

import {
  isDisclaimerAcknowledged,
  isOnboardingDone,
} from '../../../src/storage/settings/onboarding.js';

export default function useDesktopFirstRunGate() {
  const [stage, setStage] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const acknowledged = await isDisclaimerAcknowledged();
        if (cancelled) return;
        if (!acknowledged) {
          setStage('disclaimer');
          return;
        }
        const done = await isOnboardingDone();
        if (cancelled) return;
        setStage(done ? 'done' : 'onboarding');
      } catch (error) {
        if (!cancelled) setStage('disclaimer');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { stage, setStage };
}
