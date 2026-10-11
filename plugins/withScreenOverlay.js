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

// 无障碍服务（声明式骨架，见 plugins/screenOverlay/android/ScreenAccessibilityService.kt）。
// 它只用于「无障碍是否已开启」状态查询 + 给用户一条更省事的授权路径，
// **不接管屏幕采集**（采集仍走 OverlayService 的 MediaProjection）。
const ACCESSIBILITY_SERVICE_NAME = '.screenoverlay.ScreenAccessibilityService';
const ACCESSIBILITY_CONFIG_RES = '@xml/accessibility_service_config';
// 无障碍服务在系统设置里的说明文案走字符串资源（android:description 只收资源引用）。
const ACCESSIBILITY_DESCRIPTION_RES = '@string/screen_overlay_accessibility_description';

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
  if (!serviceNames.has(ACCESSIBILITY_SERVICE_NAME)) {
    app.service.push({
      $: {
        'android:name': ACCESSIBILITY_SERVICE_NAME,
        // 无障碍服务必须由系统绑定，导出给系统；访问由 BIND_ACCESSIBILITY_SERVICE
        // 这一签名级权限把关（只有系统能持有），所以 exported=true 是必需且安全的。
        'android:exported': 'true',
        'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
        'android:label': '@string/app_name',
      },
      'intent-filter': [
        { action: [{ $: { 'android:name': 'android.accessibilityservice.AccessibilityService' } }] },
      ],
      'meta-data': [
        {
          $: {
            'android:name': 'android.accessibilityservice',
            'android:resource': ACCESSIBILITY_CONFIG_RES,
          },
        },
      ],
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

// 递归复制插件自带 res 资源到主模块 res/。纯函数化便于 node --test 直接断言
// （沙箱没有 Android SDK，prebuild 跑不起来，只能对文件树搬运本身做验证）。
// rootDir 只用于算返回的相对路径：递归时必须一路带着最初那层，否则深层文件
// 会返回 `values/x.xml` 之外的错误路径（漏掉中间目录）。
function copyResTree(sourceDir, destDir, fsImpl = fs, rootDir = sourceDir) {
  const copied = [];
  fsImpl.mkdirSync(destDir, { recursive: true });
  for (const entry of fsImpl.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyResTree(from, to, fsImpl, rootDir));
      continue;
    }
    fsImpl.copyFileSync(from, to);
    copied.push(path.relative(rootDir, from).split(path.sep).join('/'));
  }
  return copied;
}

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
      // 只搬 .kt：`android/` 下同时放着 res/（资源树），它的去向是主模块 res/，
      // 不能跟着 Kotlin 源码落进 java/ 目录（那里放 res 不会被 aapt 识别）。
      for (const file of fs.readdirSync(srcDir)) {
        if (file.endsWith('.kt')) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        }
      }

      // res/（无障碍服务配置 XML + 说明文案字符串资源）按目录结构复制到主模块的
      // res/ 下：<plugin>/android/res/** → android/app/src/main/res/**。
      // 只覆盖插件自带的资源文件名（accessibility_service_config.xml /
      // screen_overlay_strings.xml），不触碰 expo prebuild 生成的其他资源。
      // 说明文案故意放在**独立文件** screen_overlay_strings.xml 而不是 strings.xml：
      // 后者是 expo 生成的（含 @string/app_name），同名覆盖会连 app_name 一起丢掉。
      const resSrc = path.join(__dirname, 'screenOverlay', 'android', 'res');
      const resDest = path.join(projectRoot, 'app', 'src', 'main', 'res');
      if (fs.existsSync(resSrc)) {
        copyResTree(resSrc, resDest);
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
  ACCESSIBILITY_SERVICE_NAME,
  ACCESSIBILITY_CONFIG_RES,
  ACCESSIBILITY_DESCRIPTION_RES,
  applyPermissions,
  applyComponents,
  applyMainApplicationPatch,
  copyResTree,
};
