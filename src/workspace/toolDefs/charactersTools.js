// 角色卡工具（MCP 与工作区 agent 共用）：**只增不减**。
//
// 为什么单独成域：角色卡存在 AsyncStorage（`@easychat2_character_item::<id>`），
// 不是工作区文件。工作区那一整套工具（list/read/write_workspace_file）**碰不到它**，
// 于是「让外部 agent 写卡改卡」在 MCP 里一直是个空白。
//
// 三条硬约束（用户 2026-10-21 明确要求，改动前请先读）：
//
//   1) **只增不减**。绝不提供删卡工具；改卡也不动原卡。
//      理由：角色卡是用户的核心创作，没有 git 版本控制，误删不可逆。
//
//   2) **改卡 = 先复制、再改副本**。`edit_character` 要求 new_id 必须与源卡 id 不同，
//      它在副本上改字段，源卡逐字节不动。这样「改坏了」永远能回到原卡。
//      不做「就地改」——就地改没有回头路，且用户明确说过要复制后改。
//
//   3) **写库必须整库读-改-写**。saveCharacterLibrary(list) 的 persistLibrary
//      会把「不在 list 里的 id」当作 stale 一并删掉（index.js:213-218）。
//      所以任何一次写都必须先 getCharacterLibrary() 拿全量、追加/替换目标项、
//      再整体写回。只传新卡 = 删光其它卡。
//
// 另注：这里**不做** id 生成策略的发明。新 id 由调用方给（或由 makeCharacterCopyId
// 从源 id 派生），落盘前用 characters/index.js 的既有约定校验唯一性。

// 唯一的静态 import，且是**故意**的例外：characterLibrarySync 是零依赖纯模块
// （只有一层回调注册表，自己不 import 任何东西），不会把 RN/expo 拖进加载路径。
// 它的作用是把「MCP 写成功了」告诉 AppContext —— 否则卡建成了、盘上也在，
// 角色页却看不到（实测：盘上 26 张、界面 25 张，差的正是刚建的那张）。
import { notifyCharacterLibraryChanged } from '../../context/characterLibrarySync.js';

// ⚠️ 存储层与 normalizeCharacter **都必须延迟加载**，不能在模块顶层 import。
//
// 原因：`workspace/tools.js` 是一张纯定义表，被 tools 相关测试直接 import
// （Node 环境里没有 RN）。而角色卡这条依赖链会一路拖进 RN / expo：
//   storage/characters.js → characters/index.js   → expo-file-system/legacy
//   storage/characters/shared.js → context/characterIdentity.js → …
// 顶层 import 会让「加载工具定义」连带解析这些模块 ⇒ ERR_MODULE_NOT_FOUND，
// 而且 tests/architecturePolicy 的分层炸弹测试也会红（它专门查「索引层不得拖入
// fflate / 网络层 / expo 系」）。实测：第一版把 normalizeCharacter 静态引入就踩了。
//
// 延迟加载之后：Node 里只要不真去调角色卡工具，就不会触碰这些依赖；
// 拼工具表、列清单、跑门控全部照旧可用。
let storageModule = null;
let normalizeFn = null;
let injectedStorage = null;

// 测试注入点：把存储层换成内存替身。
// 为什么不靠 Module._load / require.cache 打桩：被测代码用的是 **动态 import()**，
// 它走 ESM loader，两者都拦不住（实测：桩不生效，测试真去解析 RN 依赖然后全片挂掉）。
// 显式注入比和 loader 斗法更可靠，也让「这段代码依赖哪些存储能力」变成可读的契约。
export function setCharacterStorageForTests(storage) {
  injectedStorage = storage || null;
}

// 同理：normalizeCharacter 也走延迟加载，测试同样需要能替换它
// （否则测试会真去解析 storage/characters/shared.js → context 层）。
export function setCharacterNormalizeForTests(fn) {
  normalizeFn = typeof fn === 'function' ? fn : null;
}

// 同理，第三个注入点：变更通知。测试用的加载器（tests/charactersMcpTools.test.mjs）
// 会给每个相对 import 现编一份新实例，所以「测试里 import 一次 sync 模块再注册监听」
// 拿到的是**另一个**注册表，观测不到写入方的调用。注入一个 spy 才能真正断言
// 「写成功后确实通知了 / 写失败时没通知」。
let injectedNotifier = null;

export function setCharacterLibraryNotifierForTests(fn) {
  injectedNotifier = typeof fn === 'function' ? fn : null;
}

function notifyChanged(reason) {
  if (injectedNotifier) {
    try {
      injectedNotifier(reason);
    } catch (error) {}
    return;
  }
  notifyCharacterLibraryChanged(reason);
}

async function getStorage() {
  if (injectedStorage) return injectedStorage;
  if (!storageModule) {
    storageModule = await import('../../storage/characters.js');
  }
  return storageModule;
}

// 错误文案走词条（仓库规范：throw new Error 里的用户可见中文不得硬编码）。
// tActive 而非 hook：这些是模块级函数，拿不到 useTranslation。
// i18n/index.js 零 RN 依赖，可以静态 import。
import { tActive } from '../../i18n/index.js';

// normalizeCharacter 同样延迟加载（shared.js 会拖进 context 层）。
async function getNormalizeCharacter() {
  if (!normalizeFn) {
    const shared = await import('../../storage/characters/shared.js');
    normalizeFn = shared.normalizeCharacter;
  }
  return normalizeFn;
}

// normalizeCharacter 在 shared.js 里，**它也依赖 RN / context 层**（见上方说明），
// 所以同样走延迟加载，不在这里静态 import。

// 单张卡可写的字段白名单。**只列用户能理解的创作字段**：
// id / builtin / lastUsedAt / pinned 这些是系统状态，不接受外部写——
// 尤其 builtin：允许外部把一张卡标成内置，会让它在升级时被内置刷新逻辑覆盖。
// avatarUri / bgUri 是设备本地路径，外部给的值在手机上必然失效，也不接受。
export const CHARACTER_WRITABLE_FIELDS = Object.freeze([
  'name',
  'description',
  'personality',
  'scenario',
  'firstMes',
  'alternateGreetings',
  'mesExample',
  'creatorNotes',
  'postHistoryInstructions',
  'systemPromptComposed',
  'tags',
  'worldInfo',
  'regexScripts',
  'presets',
]);

// 从入参里挑出白名单字段（其余一律丢弃）。返回只含白名单键的对象。
export function pickWritableFields(source) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const picked = {};
  for (const field of CHARACTER_WRITABLE_FIELDS) {
    if (raw[field] !== undefined) picked[field] = raw[field];
  }
  return picked;
}

// 从源 id 派生一个**保证唯一**的副本 id。
// 形如 `<src>-copy-<n>`；已存在则 n 递增。不用时间戳是为了可读、可预测，
// 也便于用户一眼看出「这是哪张卡的副本」。
export function makeCharacterCopyId(sourceId, existingIds) {
  const base = String(sourceId || '').trim();
  if (!base) throw new Error(tActive('error.character.copyIdEmptySource', { id: String(sourceId) }));
  const taken = new Set((Array.isArray(existingIds) ? existingIds : []).map(id => String(id)));
  // 上限保护：正常不会撞满，但死循环比报错更糟。
  for (let n = 1; n <= 9999; n += 1) {
    const candidate = `${base}-copy-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(tActive('error.character.copyIdExhausted', { base }));
}

// 读全库 → 交给 mutate 处理 → 整体写回。
// **这是唯一的写路径**，避免调用方各自拼 list 导致 stale 误删。
async function mutateLibrary(mutate) {
  const storage = await getStorage();
  // 版本号必须在**读库之前**取：若先读库再读版本，中间被别的写入方推进了一版，
  // 我们会拿「旧数据 + 新版本号」去写，校验形同虚设。反过来（先版本后数据）最坏
  // 只是多一次假冲突，方向是安全的。
  const revision = typeof storage.getCharacterLibraryRevision === 'function'
    ? await storage.getCharacterLibraryRevision().catch(() => null)
    : null;
  const library = await storage.getCharacterLibrary();
  const list = Array.isArray(library) ? library : [];
  const next = await mutate(list);
  if (!Array.isArray(next)) throw new Error(tActive('error.character.libraryWriteNotArray', { type: typeof next }));
  // 防御性检查：写回前确认没有任何已有 id 凭空消失。
  // mutate 内部本该保证这一点，但这里是最后一道闸——宁可报错也不能删卡。
  const before = new Set(list.map(item => String(item && item.id)));
  for (const id of before) {
    if (!next.some(item => String(item && item.id) === id)) {
      throw new Error(tActive('error.character.libraryWriteWouldDrop', { id }));
    }
  }
  const saved = await storage.saveCharacterLibrary(
    next,
    // null（索引损坏/旧存储替身）时不传，退回无校验行为。
    revision === null || revision === undefined ? undefined : { expectedRevision: revision }
  );
  // 落盘成功之后才通知：失败时不该让界面去重读（读回来的还是旧的，白闪一次）。
  // 不 await、不抛：通知只是「叫 App 重读一遍」，既不该拖慢工具返回，也不该让一次
  // 已经成功的写入因为刷新失败而变成报错（notify 内部逐个 try/catch）。
  notifyChanged('character-write');
  return saved;
}

// 供测试直接验证「写回丢卡会被拒绝」这道闸。
// 为什么需要导出口：正常路径（create/edit）永远构造不出「mutate 返回少了卡」，
// 于是那道防御闸在测试里**永远走不到**——注入验证实测如此（关掉它测试仍全绿）。
// 导出之后测试能直接喂一个会丢卡的 mutate，闸门才算真被测到。
export const __mutateLibraryForTests = mutateLibrary;

// 摘要：列表用，不返回正文，避免一次吐出几十张卡的全文。
function summarize(character) {
  const item = character || {};
  const worldInfo = Array.isArray(item.worldInfo) ? item.worldInfo.length : 0;
  const regex = Array.isArray(item.regexScripts) ? item.regexScripts.length : 0;
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    pinned: item.pinned === true,
    tags: Array.isArray(item.tags) ? item.tags : [],
    worldInfoEntries: worldInfo,
    regexScripts: regex,
    descriptionChars: String(item.description || '').length,
  };
}

// ── 工具实现（不直接是 definition，definition 在 tools.js 里组装） ──

export async function listCharactersImpl() {
  const storage = await getStorage();
  const library = await storage.getCharacterLibrary();
  const list = Array.isArray(library) ? library : [];
  return list.map(summarize);
}

export async function readCharacterImpl({ id } = {}) {
  const target = String(id || '').trim();
  if (!target) throw new Error(tActive('error.character.readNeedsId', { id: String(id) }));
  const storage = await getStorage();
  const library = await storage.getCharacterLibrary();
  const list = Array.isArray(library) ? library : [];
  const found = list.find(item => String(item && item.id) === target);
  if (!found) throw new Error(tActive('error.character.editNotFound', { id: target }));
  return found;
}

// 新建一张卡。id 必填且不能与已有重复——不做「自动分配」是因为
// 静默改用户给的 id 会让后续 edit 找不到目标。
export async function createCharacterImpl({ id, character } = {}) {
  const target = String(id || '').trim();
  if (!target) throw new Error(tActive('error.character.createNeedsId'));
  const fields = pickWritableFields(character);
  if (!String(fields.name || '').trim()) throw new Error(tActive('error.character.createNeedsName'));
  const normalize = await getNormalizeCharacter();
  return mutateLibrary(list => {
    if (list.some(item => String(item && item.id) === target)) {
      throw new Error(tActive('error.character.createIdExists', { id: target }));
    }
    const next = [...list, normalize({ ...fields, id: target })];
    return next;
  }).then(library => {
    const created = library.find(item => String(item && item.id) === target);
    return summarize(created);
  });
}

// 复制一张卡并修改副本。**源卡不动**。
// newId 省略时自动派生（<src>-copy-<n>）；给了就必须不与任何已有 id 冲突。
export async function editCharacterImpl({ sourceId, newId, patch } = {}) {
  const source = String(sourceId || '').trim();
  if (!source) throw new Error(tActive('error.character.editNeedsSource'));
  const fields = pickWritableFields(patch);
  if (Object.keys(fields).length === 0) {
    throw new Error(tActive('error.character.editNeedsPatch'));
  }
  // 在闭包里记下**实际使用的** targetId：自动派生时它由 makeCharacterCopyId 决定，
  // 在外面再算一次可能因库已变化而得到不同结果（虽然并发写被 mutateLibrary 串行化了，
  // 但把「算出来的 id」和「写进去的 id」分开算一次仍是隐患）。
  let resolvedId = '';
  const normalize = await getNormalizeCharacter();
  const library = await mutateLibrary(list => {
    const index = list.findIndex(item => String(item && item.id) === source);
    if (index < 0) throw new Error(tActive('error.character.editNotFound', { id: source }));
    const existing = list.map(item => String(item && item.id));
    const targetId = newId ? String(newId).trim() : makeCharacterCopyId(source, existing);
    if (!targetId) throw new Error(tActive('error.character.editNewIdEmpty'));
    if (existing.includes(targetId)) {
      throw new Error(tActive('error.character.editNewIdExists', { id: targetId }));
    }
    resolvedId = targetId;
    // 复制源卡 → 应用 patch → 归一化 → 用新 id。
    // 注意 normalize 里 id 来自 source.id，所以必须显式覆盖。
    const copy = normalize({ ...list[index], ...fields, id: targetId });
    return [...list, copy];
  });
  const created = library.find(item => String(item && item.id) === resolvedId);
  return { ...summarize(created || {}), sourceId: source };
}

// ── 工具定义（给注册表用） ──
// 说明文案是发给模型的提示词（本仓既有口径：工具描述不进 i18n 词条表）。
// 每个定义都要在 serverPolicy.js 里表态，否则 MCP 的 tools/list 不会列出它。

export const CHARACTER_READ_DEFINITIONS = [
  {
    name: 'list_characters',
    description: '列出角色库里的所有角色卡（只读）。返回 id、名字、标签、世界书条目数、'
      + '正则脚本数、描述字数——**不返回正文**，避免一次吐出几十张卡的全文。'
      + '要读某张卡的完整内容请用 read_character。注意：这是 APP 的角色卡，不是工作区文件。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const list = await listCharactersImpl();
      if (!list.length) return '（角色库为空）';
      return list.map(item => [
        `- ${item.name || '(未命名)'}  [id: ${item.id}]`,
        item.tags.length ? `  标签：${item.tags.join('、')}` : '',
        `  世界书 ${item.worldInfoEntries} 条 · 正则 ${item.regexScripts} 条 · 描述 ${item.descriptionChars} 字`,
      ].filter(Boolean).join('\n')).join('\n');
    },
  },
  {
    name: 'read_character',
    description: '读取一张角色卡的**完整内容**（只读）：name / description / personality / scenario / '
      + 'firstMes / alternateGreetings / mesExample / worldInfo / regexScripts 等全部创作字段。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '角色 id（从 list_characters 取）。' },
      },
      required: ['id'],
    },
    execute: async (options, args) => {
      const character = await readCharacterImpl({ id: args.id });
      return JSON.stringify(character, null, 2);
    },
  },
];

export const CHARACTER_WRITE_DEFINITIONS = [
  {
    name: 'create_character',
    description: '新建一张角色卡（写入档，需 confirm）。**只增不减**：不会改动任何已有卡。'
      + 'id 必填（后续改卡要靠它定位），name 必填。'
      + '可写字段：name / description / personality / scenario / firstMes / alternateGreetings / '
      + 'mesExample / creatorNotes / postHistoryInstructions / systemPromptComposed / tags / '
      + 'worldInfo / regexScripts / presets。系统字段（id / builtin / pinned / 头像路径）不接受外部写入。',
    readOnly: false,
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '新角色 id，不能与已有角色重复。' },
        character: {
          type: 'object',
          description: '角色字段对象，只接受上面列出的创作字段，其余忽略。',
        },
      },
      required: ['id', 'character'],
    },
    execute: async (options, args) => {
      const created = await createCharacterImpl({ id: args.id, character: args.character });
      return `已新建角色卡：${created.name}  [id: ${created.id}]`;
    },
  },
  {
    name: 'edit_character',
    description: '**复制**一张角色卡并在副本上修改（写入档，需 confirm）。'
      + '源卡逐字节不动——改坏了永远能回原卡。这是本仓改卡的唯一方式，没有「就地改」。'
      + 'new_id 省略时自动派生 `<源id>-copy-<n>`（保证唯一）；给了就必须不与已有 id 冲突。'
      + 'patch 里的字段与 create_character 的可写字段一致。',
    readOnly: false,
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: '要复制的源角色 id。' },
        new_id: { type: 'string', description: '可选：副本 id。省略则自动生成。' },
        patch: { type: 'object', description: '要改的字段（只接受创作字段）。' },
      },
      required: ['source_id', 'patch'],
    },
    execute: async (options, args) => {
      const created = await editCharacterImpl({
        sourceId: args.source_id,
        newId: args.new_id,
        patch: args.patch,
      });
      return `已从 ${created.sourceId} 复制出新卡：${created.name}  [id: ${created.id}]\n`
        + '源卡未改动。确认副本无误后，可在 APP 角色页手动删除不再需要的卡。';
    },
  },
];

