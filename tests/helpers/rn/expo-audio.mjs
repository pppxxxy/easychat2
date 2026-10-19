// `expo-audio` 的 Node 端桩。
//
// 真实模块经 expo-modules-core（.ts）进来，Node 无法加载；且它做的是真播放，
// 渲染测试不该出声。所有播放动作都只记录调用，不产生副作用。
//
// 纪律：未实现的形状显式抛错，不静默返回假值。

export const calls = [];

export function createAudioPlayer(source) {
  calls.push(['createAudioPlayer', source]);
  return {
    play: () => calls.push(['play']),
    pause: () => calls.push(['pause']),
    seekTo: seconds => calls.push(['seekTo', seconds]),
    remove: () => calls.push(['remove']),
    get currentTime() { return 0; },
    get duration() { return 0; },
    get playing() { return false; },
    loop: false,
    volume: 1,
  };
}

export function useAudioPlayer(source) {
  return createAudioPlayer(source);
}

export function useAudioPlayerStatus() {
  return { currentTime: 0, duration: 0, playing: false, isLoaded: false, didJustFinish: false };
}

export async function setAudioModeAsync() {
  calls.push(['setAudioModeAsync']);
}

export const AudioModule = { setAudioModeAsync };

export default { createAudioPlayer, useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync, AudioModule };
