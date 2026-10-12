// 网络安全加固的预构建配置插件（禁止自动跟随 3xx + DNS 解析后复核）。
//
// 与 withShellExecutor / withLocalApiServer 同一套路：android/ 是
// `expo prebuild --clean` 生成的 gitignored 目录，**不能直接手改**（改了下次 prebuild
// 就被抹掉）。Kotlin 源码保存在 plugins/networkSecurity/android/，prebuild 时拷进
// android/app/src/main/java/<包名>/，再由本插件把「安装加固 client」的调用注入
// MainApplication.kt。
//
// 为什么注入的是 MainApplication.onCreate，而不是像其它插件那样只注册一个 Package：
// 加固要换掉的是 OkHttpClientProvider 的**全局 factory**，而 NetworkingModule
//（NetworkingModule.kt:132）与 FrescoModule（FrescoModule.kt:155）都在**构造时**
// 就把 client 定下来了 ⇒ 必须在桥 / 原生模块创建**之前**执行，onCreate 是应用代码里
// 最早、且一定有 Application 实例的位置。
// ⚠️ 本仓 5 个同类先例（withShellExecutor / withLocalApiServer / withProactiveMessage /
// withChaquopy / withScreenOverlay）**都只往 getPackages() 里注册 Package，
// 没有任何一个往 MainApplication 注入过代码**（grep `onCreate` 在 plugins/*.js 下 0 命中）
// ⇒ 本插件是本仓第一次注入 onCreate：沿用了先例的「字符串锚点 + 未命中即抛错」手法
// （见 applyMainApplicationPatch），锚点是 SDK 53/54 模板固定的
// `override fun onCreate() {` + `super.onCreate()`，认不出来就抛错而不是静默不生效。
//
// ⚠️ 已知副作用（如实记录，取舍是「宁可失败也不跟到内网」）：
// RN 全局网络栈（fetch / XHR / Fresco 图片加载）从此**不再自动跟随 3xx**——3xx 会直接
// 交给调用方；web_fetch 遇到重定向会以 HTTP 失败告终。若日后要「跟随但逐跳校验」，
// 需要自己写 interceptor 复刻 OkHttp 的重定向逻辑（每跳校验 Location 的解析结果），
// 本波未做。另：只覆盖走 OkHttpClientProvider 的栈，WebView / expo/fetch 不在内。

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PACKAGE_ID = 'com.pppxxxy.easychat2';
const NS_PACKAGE = `${PACKAGE_ID}.networksecurity`;
const INSTALLER_CLASS = 'NetworkSecurityInstaller';
// 注入到 onCreate 里的调用：`applicationContext` 是 Application 自带的属性。
const INSTALL_CALL = `${INSTALLER_CLASS}.install(applicationContext)`;

// ---------- 可独立测试的纯函数 ----------

// 幂等：已经注入过就原样返回。
function applyMainApplicationPatch(contents) {
  if (contents.includes(INSTALL_CALL)) return contents;
  let out = addInstallerImport(contents);
  out = addOnCreateInstall(out);
  // 守卫必须校验**调用语句**而不是仅 import：只 import 不调用等于静默不生效。
  if (!out.includes(INSTALL_CALL)) {
    throw new Error('withNetworkSecurity: MainApplication 补丁未生效');
  }
  return out;
}

function addInstallerImport(contents) {
  const importLine = `import ${NS_PACKAGE}.${INSTALLER_CLASS}`;
  if (contents.includes(importLine)) return contents;
  // 先例用的锚点：Expo 模板固定有 expo.modules.ReactNativeHostWrapper 这一行。
  if (/import expo\.modules\.ReactNativeHostWrapper/.test(contents)) {
    return contents.replace(
      /import expo\.modules\.ReactNativeHostWrapper/,
      `import expo.modules.ReactNativeHostWrapper\n${importLine}`
    );
  }
  // 兜底：插在最后一条 import 之后，保持 import 区连续。
  const imports = contents.match(/^import .*$/gm);
  if (!imports || imports.length === 0) {
    throw new Error('withNetworkSecurity: 找不到 import 区，无法注入加固类');
  }
  const last = imports[imports.length - 1];
  return contents.replace(last, `${last}\n${importLine}`);
}

// 把调用插到 onCreate 的 super.onCreate() 之后（此时 Application 已 attach，
// applicationContext / cacheDir 可用；且仍早于任何桥或原生模块的创建）。
function addOnCreateInstall(contents) {
  const onCreate = /override\s+fun\s+onCreate\s*\(\s*\)\s*\{/.exec(contents);
  if (!onCreate) {
    throw new Error('withNetworkSecurity: 未找到 MainApplication.onCreate，无法注入加固');
  }
  const head = contents.slice(0, onCreate.index + onCreate[0].length);
  const tail = contents.slice(onCreate.index + onCreate[0].length);
  if (/super\.onCreate\(\)/.test(tail)) {
    return head + tail.replace(/super\.onCreate\(\)/, `super.onCreate()\n    ${INSTALL_CALL}`);
  }
  return `${head}\n    ${INSTALL_CALL}${tail}`;
}

// ---------- 预构建 mod ----------

function withSources(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const projectRoot = cfg.modRequest.platformProjectRoot;
      const srcDir = path.join(__dirname, 'networkSecurity', 'android');
      const destDir = path.join(
        projectRoot,
        'app', 'src', 'main', 'java',
        ...NS_PACKAGE.split('.')
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

module.exports = function withNetworkSecurity(config) {
  return withSources(config);
};

// 供 node --test 直接断言的纯函数出口
module.exports.__testables = {
  PACKAGE_ID,
  NS_PACKAGE,
  INSTALLER_CLASS,
  INSTALL_CALL,
  applyMainApplicationPatch,
  addInstallerImport,
  addOnCreateInstall,
};
