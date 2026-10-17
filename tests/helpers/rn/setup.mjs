// Node 里渲染真实 React Native 组件的加载钩子。
//
// 用法（在 .mjs 测试文件最顶部，**必须先于任何 src/ 导入**）：
//     import { setupNativeStubs } from './helpers/rn/setup.mjs';
//     setupNativeStubs();
//     const ChatComposer = (await import('../../src/chat/ChatComposer.js')).default;
//
// 做三件事：
//   1. 把原生包解析到 tests/helpers/rn/ 下的桩（这是主体）；
//   2. 让 src/**/*.js 过一遍 babel：剥 JSX（Node 不认 .js 里的 JSX）。
//      **只剥 JSX，不改模块系统**——源码保持 ESM 交给 Node 原生处理。
//      为什么不像 tests/characterStorage.test.mjs 那样转 CJS：转 CJS 后
//      `src/i18n/I18nContext.js` ↔ `storage/settings.js` 这类互引会被 Node 判
//      「require(esm) 成环」直接抛 ERR_REQUIRE_CYCLE_MODULE；ESM 原生支持循环，
//      保留 ESM 就不必为 loader 的局限去改源码结构。
//   3. 给转换后的文件注入 `require`（createRequire）——仓库里有两处惰性 require 原生包
//      （io.js 的 expo-sqlite 兜底、secretStore.js 的 expo-secure-store），
//      在 ESM 里没有 `require` 会直接 ReferenceError。

import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { needsJsxTransform, transformToEsm } from '../transpile.mjs';

const HELPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HELPER_DIR, '../../..');
const SRC_DIR = path.join(ROOT, 'src');
const APP_ENTRY = path.join(ROOT, 'App.js');

// 原生包 → 桩文件。键是**包名**（已去掉子路径），值是桩的绝对路径。
const NATIVE_STUBS = new Map([
  ['react-native', path.join(HELPER_DIR, 'react-native.mjs')],
  ['@react-native-async-storage/async-storage', path.join(HELPER_DIR, 'async-storage.mjs')],
  ['expo-file-system', path.join(HELPER_DIR, 'expo-file-system.mjs')],
  ['expo-sqlite', path.join(HELPER_DIR, 'expo-sqlite.cjs')],
  ['expo-secure-store', path.join(HELPER_DIR, 'expo-secure-store.cjs')],
]);

// 子路径 → 独立桩。`expo-file-system/legacy` 与 `expo-file-system` 是**两套 API**，
// 不能共用一个文件（legacy 是 readAsStringAsync 那套，新的是 File/Directory 那套）。
const SUBPATH_STUBS = new Map([
  ['expo-file-system/legacy', path.join(HELPER_DIR, 'expo-file-system-legacy.mjs')],
]);

// @expo/vector-icons 是一族包：`@expo/vector-icons/Ionicons`、`/MaterialIcons` 等。
// 全部映射到同一个图标桩（渲染成占位宿主节点 + name/color/size 属性）。
const VECTOR_ICONS_PREFIX = '@expo/vector-icons';
const VECTOR_ICONS_STUB = path.join(HELPER_DIR, 'vector-icons.mjs');

// 主题 / i18n 的**无 Provider** 桩模块。
//
// 为什么需要：`src/theme/ThemeContext.js` 与 `src/i18n/I18nContext.js` 为了持久化外观
// 设置，各自 import 了 `../storage/settings.js` —— 于是**渲染任何一个用
// useTheme()/useTranslation() 的组件**，都会把整条原生存储栈（AsyncStorage +
// FileSystem + SecureStore + SQLite、9 个设置子模块）拖进进程。渲染测试根本不需要它。
//
// 关键点：这两个模块自己就写了 fallback，而且是**明确为「单独渲染某个组件」准备的**：
//   useTheme(): 无 Provider 时返回 getTheme(DEFAULT_THEME_ID) 的完整默认主题 + tokens
//   useTranslation(): 无 Provider 时返回基准语言（zh-CN）的 translate
// 所以把这些文件整体替换成「只保留 hook + 真默认值」的桩，测到的仍是**真实默认外观
// 与真实词条**，不是假数据——区别仅在于不跑设置加载副作用。
//
// 附带效果（很重要）：存储栈不再被渲染测试加载，也就不会与
// tests/characterStorage.test.mjs 的 CJS loader 在同一文件上产生两套行号映射，
// c8 合并覆盖率时不再互相抵消（详见 tests/helpers/transpile.mjs 文件头）。
const THEME_CONTEXT_STUB = path.join(HELPER_DIR, 'theme-context-stub.mjs');
const I18N_CONTEXT_STUB = path.join(HELPER_DIR, 'i18n-context-stub.mjs');

// 需要被替换成「轻量 hook 模块」的源码文件（按解析后的绝对路径精确匹配，
// 只影响这两个文件本身，不影响它们的其它使用者）。
const CONTEXT_STUBS = new Map([
  [path.join(SRC_DIR, 'theme', 'ThemeContext.js'), THEME_CONTEXT_STUB],
  [path.join(SRC_DIR, 'i18n', 'I18nContext.js'), I18N_CONTEXT_STUB],
]);

function packageNameOf(spec) {
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/');
    return name ? `${scope}/${name}` : scope;
  }
  return spec.split('/')[0];
}

function isSourceFile(filePath) {
  if (!filePath) return false;
  if (!filePath.endsWith('.js')) return false;
  return filePath === APP_ENTRY || filePath.startsWith(`${SRC_DIR}${path.sep}`);
}

// 转译口径统一到 tests/helpers/transpile.mjs（与 tests/characterStorage.test.mjs 共用），
// 否则同一源文件会被两条 loader 各转一遍，c8 合并时行号映射不一致、覆盖率被摊薄。
// 详见该文件头注（含实测数据与三条硬约束）。
function transformSource(filePath) {
  return transformToEsm(filePath);
}

let installed = false;

export function setupNativeStubs() {
  if (installed) return;
  installed = true;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (SUBPATH_STUBS.has(specifier)) {
        return { url: pathToFileURL(SUBPATH_STUBS.get(specifier)).href, shortCircuit: true };
      }
      if (specifier === VECTOR_ICONS_PREFIX || specifier.startsWith(`${VECTOR_ICONS_PREFIX}/`)) {
        return { url: pathToFileURL(VECTOR_ICONS_STUB).href, shortCircuit: true };
      }
      const packageName = packageNameOf(specifier);
      if (NATIVE_STUBS.has(packageName)) {
        return { url: pathToFileURL(NATIVE_STUBS.get(packageName)).href, shortCircuit: true };
      }
      // 主题 / i18n 的 Provider 模块 → 轻量 hook 桩（切断原生存储栈，见 CONTEXT_STUBS 注释）。
      // 必须在 nextResolve **之后**按解析结果判断，否则 `../theme/ThemeContext.js` 这种
      // 相对路径无法与绝对路径对上。
      const resolved = nextResolve(specifier, context);
      try {
        const resolvedPath = fileURLToPath(resolved.url);
        if (CONTEXT_STUBS.has(resolvedPath)) {
          return { url: pathToFileURL(CONTEXT_STUBS.get(resolvedPath)).href, shortCircuit: true };
        }
      } catch {
        // 解析结果不是 file: URL（内置模块等），照常返回
      }
      return resolved;
    },
    load(url, context, nextLoad) {
      if (url.startsWith('file:')) {
        const filePath = fileURLToPath(url);
        // 只接管含 JSX 的源码文件；不含 JSX 的一律走原生加载（见 transpile.mjs 的说明）
        if (isSourceFile(filePath) && needsJsxTransform(filePath)) {
          return { format: 'module', source: transformSource(filePath), shortCircuit: true };
        }
      }
      return nextLoad(url, context);
    },
  });
}

// 让用例能断言「桩真的被接上了」——否则一个拼错的包名会让测试静默跑真实模块（或失败得莫名其妙）。
export function stubTargets() {
  return {
    nativePackages: [...NATIVE_STUBS.keys()],
    subpaths: [...SUBPATH_STUBS.keys()],
    vectorIcons: VECTOR_ICONS_PREFIX,
  };
}
