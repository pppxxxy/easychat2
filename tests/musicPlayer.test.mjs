// 播放器与导入链路的源码断言：expo-audio 与 expo-file-system 依赖原生运行时，
// Node 测试进不去，用源码断言锁定关键调用（沿用 mediaActions.test.mjs 的做法）。
// 这些断言不是摆设：setActiveForLockScreen 缺失会让 Android 后台播放数分钟内被
// 系统回收（无前台服务撑着）；cameraPermission 教训同款——关键平台行为必须有回归钉。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('useMusicPlayer：expo-audio 关键调用齐全（非 expo-av 旧 API）', () => {
  const source = readSource('src/music/useMusicPlayer.js');
  assert.ok(!/from\s+'expo-av'/.test(source), '不得引用已废弃的 expo-av');
  assert.ok(source.includes("createAudioPlayer("), '应使用 createAudioPlayer 建播放器');
  assert.ok(source.includes("'playbackStatusUpdate'"), '状态事件名是 playbackStatusUpdate（1.1.1 事件键）');
  assert.ok(/UPDATE_INTERVAL_MS\s*=\s*\d+/.test(source) && source.includes('updateInterval: UPDATE_INTERVAL_MS'),
    '必须设置 updateInterval（进度事件频率），否则进度条与触发判定都不工作');
  assert.ok(source.includes('setAudioModeAsync'), '应设置全局音频模式');
  assert.ok(/shouldPlayInBackground:\s*true/.test(source), '后台播放必须显式开启');
  assert.ok(source.includes("'doNotMix'"), '听歌语义：不与其他音频混音');
  // 必须匹配「真实调用行」而非文档注释：注释里提了方法名不算数（注入验证抓过这个洞）。
  assert.ok(/^\s*player\.setActiveForLockScreen\(/m.test(source), 'Android 后台播放必须调 setActiveForLockScreen，否则进程会被回收');
  assert.ok(/^\s*player\.clearLockScreenControls\(\)/m.test(source), '卸载应清理锁屏控制');
  assert.ok(source.includes('.remove()'), '卸载应释放播放器');
  assert.ok(source.includes('.replace('), '换曲应复用同一播放器（replace），避免每次切歌泄漏播放器');
});

test('importMusic：SAF 选文件、零新权限、失败清理半成品', () => {
  const source = readSource('src/music/importMusic.js');
  assert.ok(source.includes("type: 'audio/*'"), '选择器限定音频类型');
  assert.ok(source.includes('copyToCacheDirectory: true'), '先复制到缓存再转存');
  assert.ok(source.includes('expo-file-system/legacy'), '与代码库一致走 legacy 文件 API');
  const markIndex = source.indexOf('markMediaWrite(dest)');
  const copyIndex = source.indexOf('copyAsync({ from: asset.uri, to: dest })');
  assert.ok(markIndex >= 0 && copyIndex > markIndex, '复制前必须登记媒体保护，孤儿回收才不会误删');
  const catchBlock = source.slice(source.indexOf('catch (error)'));
  assert.ok(catchBlock.includes('deleteAsync(dest'), '复制失败必须清理半成品文件');
  assert.ok(!/READ_MEDIA_AUDIO|requestPermissions/.test(source), '只做选文件导入，不申请任何存储权限');
});

test('MusicScreen：接线完整（曲库/导入/打点/删除链路）', () => {
  const source = readSource('src/music/MusicScreen.js');
  assert.ok(source.includes('importMusicFromPicker'), '导入入口接线');
  assert.ok(source.includes('getMusicItems'), '曲库读取接线');
  assert.ok(source.includes('saveMusicTriggers'), '打点保存接线');
  assert.ok(source.includes('deleteMusicItems'), '删除记录接线');
  assert.ok(source.includes('deleteMusicCommentsForSongs'), '删除歌曲时同步清理其评论键');
  assert.ok(source.includes('saveMusicDuration'), '首播时长回填接线');
  assert.ok(source.includes('useMusicPlayer'), '播放器 hook 接线');
  assert.ok(source.includes('在此打点'), '打点按钮存在');
  assert.ok(source.includes('formatPlaybackPosition'), '时间显示复用统一的 mm:ss 格式化');
});
