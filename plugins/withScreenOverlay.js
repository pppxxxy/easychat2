const {
  withAndroidManifest,
  withAppBuildGradle,
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
  // M3 耳朵：悬浮窗内直接录音（AudioRecord）需要 RECORD_AUDIO。
  // ⚠️ 这是**运行时**权限（dangerous），清单声明只是必要条件；实际申请走
  // OverlayPermissionActivity（它已是本插件的透明 Activity，顺带承担麦克风申请，
  // 免得再新增一个 Activity 与一套授权流程）。
  'android.permission.RECORD_AUDIO',
  // Android 14（API 34）起：前台服务若在**后台**启动并要访问麦克风，
  // 必须声明 FOREGROUND_SERVICE_MICROPHONE 并以 microphone 类型 startForeground，
  // 否则抛 SecurityException / MissingForegroundServiceTypeException。
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
];

const SERVICE_NAME = '.screenoverlay.OverlayService';

// 投屏授权的**独立透明 Activity**（M1.3，见 plugins/screenOverlay/android/OverlayPermissionActivity.kt）。
// 旧实现把 createScreenCaptureIntent 的 startActivityForResult 绑在 RN 主 Activity 上：
// app 在后台（悬浮窗主场景）时走不了，重新授权还会把主 Activity 拉到前台 → ANR。
// 该 Activity 无界面，故用透明主题；独立 taskAffinity 让它在「最近任务」里不与主
// Activity 归并（否则用户会看到一个空白应用卡片）。exported=false：只允许本应用内部拉起。
const PERMISSION_ACTIVITY_NAME = '.screenoverlay.OverlayPermissionActivity';
const PERMISSION_ACTIVITY_THEME = '@android:style/Theme.Translucent.NoTitleBar';
const PERMISSION_ACTIVITY_AFFINITY = `${PACKAGE_ID}.overlaypermission`;

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
        // M3：两个类型并列——mediaProjection（截屏）与 microphone（窗内录音）。
        // Android 14 起 startForeground 的类型必须是这里声明的子集，多声明一个类型
        // 本身不产生额外要求（只在真的用到该类型时才需要对应权限与运行时授权）。
        'android:foregroundServiceType': 'mediaProjection|microphone',
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
  // 授权透明 Activity（M1.3）：声明式接线，幂等。
  app.activity = app.activity || [];
  const activityNames = new Set(app.activity.map(a => a.$ && a.$['android:name']));
  if (!activityNames.has(PERMISSION_ACTIVITY_NAME)) {
    app.activity.push({
      $: {
        'android:name': PERMISSION_ACTIVITY_NAME,
        'android:exported': 'false',
        // 透明主题：本 Activity 不画任何界面，只负责弹系统授权框，之后立刻 finish()。
        // 用非透明主题会在授权框出现前闪一下白屏/黑屏。
        'android:theme': PERMISSION_ACTIVITY_THEME,
        // 独立 taskAffinity：不与主 Activity 归并，避免「最近任务」里多出一张空白卡片。
        'android:taskAffinity': PERMISSION_ACTIVITY_AFFINITY,
        // 屏幕方向/键盘变化不该重建它（重建会中断正在进行的授权），故自己处理配置变更。
        'android:configChanges': 'orientation|screenSize|keyboardHidden',
        // 不需要在最近任务里留下记录（它是纯工具页）。
        'android:excludeFromRecents': 'true',
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

// M2 大脑搬家：OverlayBrain.kt 的 apiKey 存 EncryptedSharedPreferences（AES256-GCM，
// Keystore 托管），需要 androidx.security 依赖。
// 版本与 withProactiveMessage.js 完全一致 + `includes` 判重：两个插件同时启用时
// 只会注入一条，不会冲突。
function withGradle(config) {
  return withAppBuildGradle(config, cfg => {
    if (cfg.modResults.language === 'groovy' &&
        !cfg.modResults.contents.includes('androidx.security:security-crypto')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        deps => `${deps}\n    implementation("androidx.security:security-crypto:1.1.0-alpha06")`
      );
    }
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
  config = withGradle(config);
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
  PERMISSION_ACTIVITY_NAME,
  PERMISSION_ACTIVITY_THEME,
  PERMISSION_ACTIVITY_AFFINITY,
  applyPermissions,
  applyComponents,
  applyMainApplicationPatch,
  copyResTree,
};
