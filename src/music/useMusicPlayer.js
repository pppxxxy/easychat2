// 一起听歌播放器的**订阅适配层**（FEAT-AC2 P0-1 之后）。
//
// 此前这个 hook 自己持有播放器（useRef），于是播放器随音乐页生灭——
// 人在别的页面/别的 app 时没有实例，工具驱动不了。现在播放器归
// ./playerService.js 单例所有，本 hook 只做两件事：
//   ① 把单例的状态推送给调用方（挂载订阅 / 卸载退订）；
//   ② 把动作转发给单例。
// **卸载不销毁播放**——这是本轮的关键语义变化（页面关掉，歌继续放）。
//
// 同时把「播完续接 / playMode / rate」的驱动也搬进了服务，所以本 hook 不再需要
// finished 处理（MusicScreen 里那套 useEffect 简化见其注释）。

import { useCallback, useEffect, useState } from 'react';

import * as playerService from './playerService.js';

const EMPTY_STATUS = { playing: false, positionMs: 0, durationMs: 0, loaded: false, finished: false };

export function useMusicPlayer() {
  const [status, setStatus] = useState(EMPTY_STATUS);
  // FEAT-AC2：也订阅「当前曲目」。服务会自动续接（sequential/shuffle 播完切下一首），
  // 那时页面必须知道换歌了——**这个信息只能来自服务**（页面不再自己管队列）。
  const [track, setTrack] = useState(null);

  useEffect(() => {
    // 订阅 = 挂载期间收状态推送；返回的函数 = 退订。
    // ⚠️ 这里**不 release**：页面关掉不该掐掉正在放的歌（旧实现在这里 remove 播放器，
    // 正是「播放器随屏生灭」的根因）。真正释放走 playerService.release()，
    // 由「用户明确停止并关闭」或 app 退出触发。
    const unsubscribe = playerService.subscribe((next, snap) => {
      setStatus(next);
      setTrack(snap && snap.current ? snap.current : null);
    });
    return unsubscribe;
  }, []);

  const load = useCallback((item, options) => playerService.load(item, options), []);
  const toggle = useCallback(() => playerService.toggle(), []);
  const pause = useCallback(() => playerService.pause(), []);
  const play = useCallback(() => playerService.play(), []);
  const seekToSeconds = useCallback(seconds => playerService.seekToSeconds(seconds), []);
  const setRate = useCallback(value => playerService.setRate(value), []);
  const stop = useCallback(() => playerService.stop(), []);

  return { status, track, load, toggle, pause, play, seekToSeconds, setRate, stop };
}
