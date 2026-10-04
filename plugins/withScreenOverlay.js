const {
  withAndroidManifest,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// 看屏幕悬浮窗（MediaProjection 跨应用截屏 + WindowManager 覆盖窗 + 前台服务）的
// 预构建配置插件。android/ 是 expo prebuild --clean 生成的 gitignored 目录，不能直接
// 手改：Kotlin 源码保存在 plugins/screenOverlay/android/，prebuild 时拷贝，并由本插件
// 完成 Manifest 声明与 MainApplication 包注册。

const PACKAGE_ID = 'com.pppxxxy.easychat2';
const SCREEN_OVERLAY_PACKAGE = `${PACKAGE_ID}.screenoverlay`;

const PERMISSIONS = [
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  // Android 13+ 前台服务的常驻通知需要运行时通知权限才可见；清单声明 + 模块内
  // startOverlay 时的运行时请求（ScreenOverlayModule.requestNotificationPermissionIfNeeded）。
  'android.permission.POST_NOTIFICATIONS',
];

const SERVICE_NAME = '.screenoverlay.OverlayService';

// ---------- 可独立测试的纯函数 ----------

function applyPermissions(manifest) {
  manifest['uses-permission'] = manifest['uses-permission'] || [];
  const existing = new Set(
    manifest['uses-permission'].map(p => p && p.$ && p.$['android:name'])
  );
  for (const name of PERMISSIONS) {
    if (!existing.has(name)) {
      manifest['uses-permission'].push({ $: { 'android:name': name } });
    }
  }
  return manifest;
}

function applyComponents(manifest) {
  const app = manifest.application && manifest.application[0];
  if (!app) {
    throw new Error('withScreenOverlay: 未找到 application 节点');
  }
  app.service = app.service || [];
  const serviceNames = new Set(app.service.map(s => s.$ && s.$['android:name']));
  if (!serviceNames.has(SERVICE_NAME)) {
    app.service.push({
      $: {
        'android:name': SERVICE_NAME,
        'android:exported': 'false',
        'android:foregroundServiceType': 'mediaProjection',
      },
    });
  }
  return manifest;
}

function applyMainApplicationPatch(contents) {
  if (/packages\.add\(ScreenOverlayPackage\(\)\)|\badd\(ScreenOverlayPackage\(\)\)/.test(contents)) {
    return contents;
  }
  let out = contents.replace(
    /import expo\.modules\.ReactNativeHostWrapper/,
    'import expo.modules.ReactNativeHostWrapper\nimport com.pppxxxy.easychat2.screenoverlay.ScreenOverlayPackage'
  );
  if (/return PackageList\(this\)\.packages/.test(out)) {
    out = out.replace(
      /return PackageList\(this\)\.packages/,
      'val packages = PackageList(this).packages\n            packages.add(ScreenOverlayPackage())\n            return packages'
    );
  } else if (/PackageList\(this\)\.packages\.apply\s*\{/.test(out)) {
    out = out.replace(
      /PackageList\(this\)\.packages\.apply\s*\{/,
      match => `${match}\n              add(ScreenOverlayPackage())`
    );
  }
  if (!/packages\.add\(ScreenOverlayPackage\(\)\)|\badd\(ScreenOverlayPackage\(\)\)/.test(out)) {
    throw new Error('withScreenOverlay: MainApplication 补丁未生效');
  }
  return out;
}

// ---------- 预构建 mod ----------

function withManifest(config) {
  return withAndroidManifest(config, cfg => {
    applyPermissions(cfg.modResults.manifest);
    applyComponents(cfg.modResults.manifest);
    return cfg;
  });
}

function withSources(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const projectRoot = cfg.modRequest.platformProjectRoot;
      const srcDir = path.join(__dirname, 'screenOverlay', 'android');
      const destDir = path.join(
        projectRoot,
        'app', 'src', 'main', 'java',
        ...SCREEN_OVERLAY_PACKAGE.split('.')
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        if (file.endsWith('.kt')) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        }
      }

      const mainAppPath = path.join(
        projectRoot, 'app', 'src', 'main', 'java',
        ...PACKAGE_ID.split('.'), 'MainApplication.kt'
      );
      const mainApp = fs.readFileSync(mainAppPath, 'utf8');
      fs.writeFileSync(mainAppPath, applyMainApplicationPatch(mainApp));
      return cfg;
    },
  ]);
}

module.exports = function withScreenOverlay(config) {
  config = withManifest(config);
  config = withSources(config);
  return config;
};

// 供 node --test 直接断言的纯函数出口
module.exports.__testables = {
  PERMISSIONS,
  SERVICE_NAME,
  applyPermissions,
  applyComponents,
  applyMainApplicationPatch,
};
