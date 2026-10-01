// expo-audio / expo-file-system 的惰性加载器。
//
// 原生模块在被 require 时会同步调用 requireNativeModule，模块未注册（如 Web/测试
// 环境）会直接抛错。因此禁止在模块顶层 require，必须延迟到首次实际使用。
// 录音、播放、TTS 共用同一份加载结果。

let audioModule;
let audioLoaded = false;

export function getAudioModule() {
  if (!audioLoaded) {
    audioLoaded = true;
    try {
      audioModule = require('expo-audio');
    } catch (error) {
      audioModule = null;
    }
  }
  return audioModule;
}

let fileSystemModule;
let fileSystemLoaded = false;

export function getFileSystem() {
  if (!fileSystemLoaded) {
    fileSystemLoaded = true;
    try {
      fileSystemModule = require('expo-file-system/legacy');
    } catch (error) {
      fileSystemModule = null;
    }
  }
  return fileSystemModule;
}
