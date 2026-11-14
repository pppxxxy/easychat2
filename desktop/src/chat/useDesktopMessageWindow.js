// 消息窗口化（桌面）：只渲染尾部 N 条，更早的按需放开。
//
// 与手机 MessageList 的窗口化**同一语义、同一组常量**（src/chat/chatConstants.js：
// 初始 80 条、每次放开 200 条）。手机那层在 RN 组件里；桌面的列表是纯展示组件，
// 所以把「窗口大小 + 放开一步 + 切会话重置」这三件事收进这里，既不撑爆 ChatPane，
// 也让语义只有一处。
//
// 为什么必须做：上千条会话若全量挂载，每次输入/滚动都会重算全部气泡的 markdown，
// 长会话卡顿的根源在这里，而不在滚动本身。
import { useCallback, useEffect, useState } from 'react';

import {
  MESSAGE_WINDOW_INITIAL,
  MESSAGE_WINDOW_STEP,
} from '../../../src/chat/chatConstants.js';

export default function useDesktopMessageWindow(sessionId = '') {
  const [windowSize, setWindowSize] = useState(MESSAGE_WINDOW_INITIAL);

  // 切会话回到初始窗口：否则上一个会话放开到 500 条的状态会带过来，
  // 新会话一进去就是全量渲染。
  useEffect(() => {
    setWindowSize(MESSAGE_WINDOW_INITIAL);
  }, [sessionId]);

  const expand = useCallback(() => {
    setWindowSize(size => size + MESSAGE_WINDOW_STEP);
  }, []);

  return { windowSize, expand };
}