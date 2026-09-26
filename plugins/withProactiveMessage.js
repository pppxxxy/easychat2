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
  return manifest;
}

function applyGradleDependencies(contents) {
  if (contents.includes('androidx.work:work-runtime-ktx')) {
    return contents;
  }
  return contents.replace(
    /dependencies\s*\{/,
    deps => `${deps}\n    implementation("androidx.work:work-runtime-ktx:2.9.1")`
  );
}

function applyMainApplicationPatch(contents) {
  if (contents.includes('ProactiveMessagePackage')) {
    return contents;
  }
  let out = contents.replace(
    /import expo\.modules\.ReactNativeHostWrapper/,
    'import expo.modules.ReactNativeHostWrapper\nimport com.pppxxxy.easychat2.proactive.ProactiveMessagePackage'
  );
  out = out.replace(
    /return PackageList\(this\)\.packages/,
    'val packages = PackageList(this).packages\n            packages.add(ProactiveMessagePackage())\n            return packages'
  );
  if (!out.includes('ProactiveMessagePackage')) {
    throw new Error('withProactiveMessage: MainApplication 补丁未生效');
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
