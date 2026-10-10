const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// 定时主动消息（WorkManager/AlarmManager + 本地通知）的预构建配置插件。
// android/ 是 expo prebuild --clean 生成的 gitignored 目录，不能直接手改，
// 所以 Kotlin 源码保存在 plugins/proactiveMessage/android/，prebuild 时拷贝，
// 并通过本插件完成 Manifest 声明、Gradle 依赖和 MainApplication 包注册。

const PACKAGE_ID = 'com.pppxxxy.easychat2';
const PROACTIVE_PACKAGE = `${PACKAGE_ID}.proactive`;

const PERMISSIONS = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
];

const BOOT_ACTIONS = [
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.TIME_SET',
  'android.intent.action.TIMEZONE_CHANGED',
  'android.intent.action.MY_PACKAGE_REPLACED',
  'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
];

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
    throw new Error('withProactiveMessage: 未找到 application 节点');
  }
  app.receiver = app.receiver || [];
  app.service = app.service || [];

  const receiverNames = new Set(app.receiver.map(r => r.$ && r.$['android:name']));
  if (!receiverNames.has('.proactive.AlarmReceiver')) {
    app.receiver.push({
      $: { 'android:name': '.proactive.AlarmReceiver', 'android:exported': 'false' },
    });
  }
  if (!receiverNames.has('.proactive.BootReceiver')) {
    app.receiver.push({
      $: { 'android:name': '.proactive.BootReceiver', 'android:exported': 'false' },
      'intent-filter': [
        { action: BOOT_ACTIONS.map(name => ({ $: { 'android:name': name } })) },
      ],
    });
  }

  const serviceNames = new Set(app.service.map(s => s.$ && s.$['android:name']));
  if (!serviceNames.has('.proactive.MessageForegroundService')) {
    app.service.push({
      $: {
        'android:name': '.proactive.MessageForegroundService',
        'android:exported': 'false',
        'android:foregroundServiceType': 'dataSync',
      },
    });
  }
  // 定时 Agent 任务：HeadlessJsTaskService 承载无界面 JS（多轮工具循环），
  // 同样以前台服务运行（dataSync），避免被后台回收。
  if (!serviceNames.has('.proactive.AgentTaskForegroundService')) {
    app.service.push({
      $: {
        'android:name': '.proactive.AgentTaskForegroundService',
        'android:exported': 'false',
        'android:foregroundServiceType': 'dataSync',
      },
    });
  }
  return manifest;
}

function applyGradleDependencies(contents) {
  let out = contents;
  if (!out.includes('androidx.work:work-runtime-ktx')) {
    out = out.replace(
      /dependencies\s*\{/,
      deps => `${deps}\n    implementation("androidx.work:work-runtime-ktx:2.9.1")`
    );
  }
  // 主动消息的 apiKey 存 EncryptedSharedPreferences，避免明文落盘。
  // 逐依赖独立判重：任一已存在时只补缺失的那条。
  if (!out.includes('androidx.security:security-crypto')) {
    out = out.replace(
      /dependencies\s*\{/,
      deps => `${deps}\n    implementation("androidx.security:security-crypto:1.1.0-alpha06")`
    );
  }
  return out;
}

function applyMainApplicationPatch(contents) {
  if (/packages\.add\(ProactiveMessagePackage\(\)\)|\badd\(ProactiveMessagePackage\(\)\)/.test(contents)) {
    return contents;
  }
  let out = contents.replace(
    /import expo\.modules\.ReactNativeHostWrapper/,
    'import expo.modules.ReactNativeHostWrapper\nimport com.pppxxxy.easychat2.proactive.ProactiveMessagePackage'
  );
  // SDK 50 模板：getPackages() 直接 `return PackageList(this).packages`。
  if (/return PackageList\(this\)\.packages/.test(out)) {
    out = out.replace(
      /return PackageList\(this\)\.packages/,
      'val packages = PackageList(this).packages\n            packages.add(ProactiveMessagePackage())\n            return packages'
    );
  } else if (/PackageList\(this\)\.packages\.apply\s*\{/.test(out)) {
    // SDK 53+ 模板：`PackageList(this).packages.apply { ... }`（无 return），
    // 必须把 add(...) 插进 apply 块内，否则只会 import 而不注册，且守卫被 import 骗过。
    out = out.replace(
      /PackageList\(this\)\.packages\.apply\s*\{/,
      match => `${match}\n              add(ProactiveMessagePackage())`
    );
  }
  // 守卫必须校验「注册语句」而非仅类名：只 import 未 add 的静默失效必须抛错。
  if (!/packages\.add\(ProactiveMessagePackage\(\)\)|\badd\(ProactiveMessagePackage\(\)\)/.test(out)) {
    throw new Error('withProactiveMessage: MainApplication 补丁未生效');
  }
  return out;
}

// 单色通知小图标（聊天气泡），vector drawable，纯文本便于版本管理。
// Android 通知小图标只取 alpha 通道，故用白色填充即可。
const NOTIFICATION_ICON_XML = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <path
      android:fillColor="#FFFFFF"
      android:pathData="M4,4h16a2,2 0 0 1 2,2v9a2,2 0 0 1 -2,2H8l-4,4V6a2,2 0 0 1 2,-2z" />
</vector>
`;

// ---------- 预构建 mod ----------

function withManifest(config) {
  return withAndroidManifest(config, cfg => {
    applyPermissions(cfg.modResults.manifest);
    applyComponents(cfg.modResults.manifest);
    return cfg;
  });
}

function withGradle(config) {
  return withAppBuildGradle(config, cfg => {
    if (cfg.modResults.language === 'groovy') {
      cfg.modResults.contents = applyGradleDependencies(cfg.modResults.contents);
    }
    return cfg;
  });
}

function withSources(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const projectRoot = cfg.modRequest.platformProjectRoot;
      const srcDir = path.join(__dirname, 'proactiveMessage', 'android');
      const destDir = path.join(
        projectRoot,
        'app', 'src', 'main', 'java',
        ...PROACTIVE_PACKAGE.split('.')
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        if (file.endsWith('.kt')) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        }
      }

      // 单色通知小图标：默认 setSmallIcon 用系统内置图标（带圈 i），
      // 注入一个聊天气泡 vector 作为通知小图标，避免角标突兀。
      const drawableDir = path.join(projectRoot, 'app', 'src', 'main', 'res', 'drawable');
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.writeFileSync(
        path.join(drawableDir, 'ic_stat_proactive.xml'),
        NOTIFICATION_ICON_XML
      );

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

module.exports = function withProactiveMessage(config) {
  config = withManifest(config);
  config = withGradle(config);
  config = withSources(config);
  return config;
};

// 供 node --test 直接断言的纯函数出口
module.exports.__testables = {
  PERMISSIONS,
  BOOT_ACTIONS,
  applyPermissions,
  applyComponents,
  applyGradleDependencies,
  applyMainApplicationPatch,
};
