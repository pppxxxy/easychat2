// 阅读器与导入链路的源码断言（RN 渲染与 SAF 选文件依赖原生运行时，Node 进不去）。
// 关键回归钉：
// - 测量 Text 与可见页 Text 必须共用同一份排版 props（buildPageTextProps 唯一来源），
//   且测量 Text 必须不可见但参与布局（opacity 0，而非 display:none）；
// - 可见页只渲染分到本页的行（pageText）——测量漂移不得造成页面溢出；
// - 导入必须是 '*/*' + 扩展名校验（厂商文件管理器把 .txt 标成 octet-stream）；
// - 编码检测必须拒绝非 UTF-8（U+FFFD 比例），不允许静默导入乱码书。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('useBookReader：测量-分页-重定位机制齐全', () => {
  const source = readSource('src/books/useBookReader.js');
  assert.ok(source.includes('buildPageTextProps'), '排版 props 必须有唯一来源函数');
  assert.ok(/LINE_HEIGHT_RATIO\s*=\s*[\d.]+/.test(source), '行高比常量定义');
  assert.ok(source.includes('paginateLines') && source.includes('findPageByAnchor'),
    '装箱与重定位必须复用 pagination.js 纯函数');
  assert.ok(source.includes("type: 'anchor'") && source.includes("type: 'last'") && source.includes("type: 'first'"),
    '三种测量后落点（锚/块首页/块末页）必须齐全');
  assert.ok(/status !== MEASURE_BUSY/.test(source), '晚到的 onTextLayout 必须按状态丢弃');
});

test('BookReaderView：可见页只渲染本页行，测量 Text 参与布局但不可见', () => {
  const source = readSource('src/books/BookReaderView.js');
  assert.ok(source.includes('pageText(reader.lines, reader.page)'), '可见页必须由本页行拼成');
  assert.ok(/opacity:\s*0/.test(source), '测量 Text 用 opacity 0（display:none 不产生布局，无法测量）');
  assert.ok(source.includes('onTextLayout={reader.handleTextLayout}'), '测量 Text 接线 onTextLayout');
  assert.ok(source.includes('TAP_ZONE_RATIO'), '左右点按翻页区');
  assert.ok(source.includes('reader.reanchor()'), '字号变化前必须先落锚');
  assert.ok(source.includes('next === fontSize'), '字号到边界时不得污染 pendingJump');
  assert.ok(source.includes('key={openBook.item.id}') || readSource('src/books/BookScreen.js').includes('key={openBook.item.id}'),
    '换书重挂载（key）省去复位逻辑');
});

test('importBook：宽松选择器 + base64 读字节 + 多格式提取 + 失败清理', () => {
  const source = readSource('src/books/importBook.js');
  assert.ok(source.includes("type: '*/*'"), '选择器必须 *.*（厂商把 .txt 标成 octet-stream，text/* 会选不中）');
  assert.ok(source.includes("from './extractText.js'"), '格式/编码处理下沉到 extractText');
  assert.ok(source.includes('extractPlainText'), '调用纯函数提取纯文本');
  assert.ok(/EncodingType\.Base64/.test(source), '以 base64 读原始字节（编码探测与 zip 解包的前提）');
  assert.ok(source.includes('writeAsStringAsync(dest, text)'), '提取后写回 UTF-8 正文');
  const catchBlocks = source.split('catch (error)');
  assert.ok(catchBlocks.length >= 3 && catchBlocks.slice(1).some(block => block.includes('deleteAsync(dest')),
    '复制/提取/落库失败都必须清理半成品文件');
});

test('extractText/decodeText：纯函数承担多格式与多编码（错误码可区分）', () => {
  const extract = readSource('src/books/extractText.js');
  const decode = readSource('src/books/decodeText.js');
  assert.ok(extract.includes("'.docx'") && extract.includes("'.html'"), 'docx/html 格式在支持列表');
  assert.ok(extract.includes('unzipSync'), 'docx 用 fflate 解压');
  assert.ok(/UNSUPPORTED_FORMAT/.test(extract), '不支持格式错误码');
  assert.ok(decode.includes("'gb18030'") && decode.includes("'big5'"), 'GBK/BIG5 候选解码');
  assert.ok(/code = 'ENCODING'/.test(decode), '无法识别编码错误码');
});

test('阅读进度落库：防抖保存 + 退出/卸载兜底（monkey 审查缺陷 1 回归）', () => {
  const reader = readSource('src/books/useBookReader.js');
  assert.ok(reader.includes('location'), 'useBookReader 必须暴露当前阅读位置');
  const view = readSource('src/books/BookReaderView.js');
  assert.ok(view.includes('saveBookProgress(item.id, location)'), '翻页/退出必须写回进度');
  assert.ok(/setTimeout\([\s\S]{0,160}saveBookProgress/.test(view), '位置变化必须防抖保存');
  assert.ok(view.includes('flushProgress'), '退出必须兜底 flush');
  assert.ok(view.includes('onPress={handleBack}'), '返回按钮必须走 flush 路径');
  assert.ok(/useEffect\(\(\) => \(\) => flushProgress\(\)/.test(view), '组件卸载必须兜底保存');
});

test('BookScreen：打开按需读文件、错误按 code 分流', () => {
  const source = readSource('src/books/BookScreen.js');
  assert.ok(source.includes('readBookContent'), '打开书籍才读正文文件');
  assert.ok(source.includes("code === 'ENCODING'") && source.includes("code === 'UNSUPPORTED_FORMAT'"),
    '导入错误按 code 分流提示');
  assert.ok(source.includes('deleteBookCommentsForBooks'), '删书同步清理评论键');
  assert.ok(source.includes('deleteAsync(item.uri'), '删书清理正文文件');
});

test('Markdown 渲染：按 format 切换渲染模式，进度/评论统一到块', () => {
  const view = readSource('src/books/BookReaderView.js');
  assert.ok(view.includes('BookMarkdownList'), 'Markdown 书籍走连续滚动渲染列表');
  assert.ok(view.includes('isMarkdownBook') && view.includes('handleToggleRenderMode'),
    '按格式提供渲染/纯文本切换');
  assert.ok(view.includes('markdownExcerpt') && view.includes('createBookMarkdownStyles'),
    'Markdown 模式复用摘录与样式工厂');
  assert.ok(/paged\s*\?\s*blocks\s*:\s*EMPTY_BLOCKS/.test(view),
    '非分页模式给分页 hook 传空块（保持惰性）');

  const imp = readSource('src/books/importBook.js');
  assert.ok(imp.includes('MARKDOWN_FORMATS') && /markdown:\s*MARKDOWN_FORMATS/.test(imp),
    '导入按 Markdown 格式分块');
  assert.ok(/\bformat,\s*$/m.test(imp) || imp.includes('format,'), '导入落库 format 字段');

  const lib = readSource('src/books/library.js');
  assert.ok(lib.includes('format: String(source.format'), '书籍条目归一 format');
});

test('导入失败提示按 code 走文案键，不渲染原始 error.message', () => {
  const screen = readSource('src/books/BookScreen.js');
  assert.ok(!screen.includes('error.message'),
    '不得把 error.message 渲染给用户：抛错信息面向开发者且是中文，会漏进英文界面');

  // 精确钉住导入处理体本身（避免只靠全文件扫描——注释里出现同名字样会造成假红/假绿）。
  const handler = screen.slice(screen.indexOf('const handleImport'), screen.indexOf('const handleOpen'));
  assert.ok(handler.length > 0, '必须能定位到 handleImport 处理体');
  assert.ok(!handler.includes('error.message'), 'handleImport 内不得把原始报错文本交给 Alert');

  const keys = [
    'books.import.encoding.body',
    'books.import.docxTooLarge.title',
    'books.import.docxTooLarge.body',
    'books.import.empty.title',
    'books.import.empty.body',
  ];
  for (const key of keys) {
    assert.ok(handler.includes(`t('${key}')`), `handleImport 必须使用 ${key}`);
  }
  assert.ok(handler.includes("code === 'EMPTY_BOOK'"), '空内容错误要有独立分支，而不是落到泛化提示');
  assert.ok(handler.includes("code === 'DOCX_TOO_LARGE'"), 'docx 超限要有独立分支，提示具体原因');

  const imp = readSource('src/books/importBook.js');
  assert.ok(/error\.code = 'EMPTY_BOOK'/.test(imp), '空内容错误必须带 code 才能被上层的文案分支识别');

  for (const locale of ['zh-CN', 'en']) {
    const table = readSource(`src/i18n/locales/${locale}.js`);
    for (const key of keys) {
      assert.ok(table.includes(`'${key}'`), `${locale} 缺少文案键 ${key}`);
    }
  }
});

test('分页可靠性：尺寸变化必须强制重测（key 换挂载），工具栏显隐不得改变正文区尺寸', () => {
  const hook = readSource('src/books/useBookReader.js');
  assert.ok(hook.includes('measureNonce'), '必须暴露测量重挂载凭据');
  assert.ok(/setMeasureNonce\(value => value \+ 1\)/.test(hook),
    '尺寸/字号变化时必须递增 nonce——否则测量 Text 的排版 props 一字未变，RN 不再派发 '
    + 'onTextLayout，状态永久停在 BUSY（用户看到的就是「一直转圈，点字号才出正文」）');

  const view = readSource('src/books/BookReaderView.js');
  assert.ok(/key=\{`measure-\$\{reader\.measureNonce\}`\}/.test(view),
    '测量 Text 必须以 nonce 为 key，强制重挂载以触发再次测量');
  assert.ok(view.includes('pageInnerWrap'), '测量容器（pageInnerWrap）与内缩容器（pageArea）分离');
  assert.ok(/pageArea:\s*\{[^}]*paddingTop:\s*READER_INSET_TOP/.test(view),
    '阅读区上下内缩必须恒定（分页高度不随工具栏显隐变化）');
  assert.ok(/topBar:\s*\{[\s\S]{0,400}?position:\s*'absolute'/.test(view),
    '顶栏必须是浮层：参与布局会在每次显隐时改变正文区高度并触发重测量（点中间转圈的根因）');
  assert.ok(/bottomBar:\s*\{[\s\S]{0,400}?position:\s*'absolute'/.test(view),
    '底栏同样必须是浮层');
});

test('翻页方式：四档（点击/卡片滑动/旋转/淡入淡出）+ 全局持久化 + 静态文案键', () => {
  const settings = readSource('src/books/readerSettings.js');
  assert.ok(/PAGE_TURN_MODES\s*=\s*\['tap',\s*'slide',\s*'curl',\s*'fade'\]/.test(settings), '四档翻页模式');
  assert.ok(settings.includes('@easychat2_book_reader'), '翻页方式全局持久化');
  assert.ok(settings.includes('normalizeBookReaderSettings'), '读取必须归一化（非法值回退默认）');

  const view = readSource('src/books/BookReaderView.js');
  assert.ok(view.includes('PanResponder'), '滑动翻页用 PanResponder');
  assert.ok(/pageTurn === 'tap'\) return null/.test(view), 'tap 模式不接管横向手势');
  assert.ok(view.includes('Animated.timing') && view.includes('rotateY'), 'slide 平移 / curl 3D 翻转动画');
  assert.ok(view.includes('useNativeDriver: true'), '翻页动画走原生驱动，避免 JS 线程卡顿');
  assert.ok(view.includes('PAGE_TURN_HINT_KEYS'), '模式提示用静态文案键表（动态拼接无法被文案扫描提取）');

  // 新增的淡入淡出档：opacity 插值 + 图标 + 静态文案键，三处缺一不可
  assert.ok(/pageTurn === 'fade'[\s\S]{0,220}?opacity/.test(view), '淡入淡出走 opacity 插值');
  assert.ok(view.includes("fade: 'contrast-outline'"), '淡入淡出有图标');
  assert.ok(view.includes("fade: 'books.reader.pageTurn.fade'"), '淡入淡出有静态文案键');
});

test('切换翻页方式：先停表复位再换结构（原生动画节点被卸载会闪退）', () => {
  const view = readSource('src/books/BookReaderView.js');
  const cycle = view.slice(view.indexOf('const cyclePageTurn'), view.indexOf('const turnPage'));
  assert.ok(cycle.length > 0, '必须能截出 cyclePageTurn');
  const stopAt = cycle.indexOf('pageAnim.stopAnimation()');
  const setAt = cycle.indexOf('setPageTurn(next)');
  assert.ok(stopAt >= 0, '切换前必须停掉在途动画');
  assert.ok(setAt >= 0, '切换动作本身保留');
  assert.ok(stopAt < setAt,
    '必须先停表、再改模式：useNativeDriver 的动画跑在原生侧，在途动画 + 动画属性结构突变 = 原生节点被卸载 → 闪退');
  assert.ok(cycle.includes('turningRef.current = false'), '复位翻页锁，避免停表后卡住后续翻页');
  assert.ok(/useEffect\(\(\) => \(\) => \{\s*pageAnim\.stopAnimation\(\)/.test(view), '组件卸载时同样停表');

  // 样式块：不再对 tap 整体摘掉动画属性（结构突变是崩溃的必要条件之一）
  const styleBlock = view.slice(view.indexOf('const pageAnimStyle'), view.indexOf('const pageBody'));
  assert.ok(styleBlock.length > 0, '必须能截出 pageAnimStyle');
  assert.ok(!styleBlock.includes("if (pageTurn === 'tap') return null"),
    'pageAnimStyle 不再对 tap 返回 null');
  assert.ok(styleBlock.includes("pageTurn === 'curl'") && styleBlock.includes("pageTurn === 'fade'"),
    'curl 与 fade 分支齐全');
  assert.ok(styleBlock.includes('translateX: pageAnim'), 'tap / slide 共用同一套 translateX 结构');

  // 停表不是万能的：Animated 的 start 回调在 stopAnimation 时仍会被调用一次，
  // 回调里若不检查 finished 就会「顺着链子再起一个 native 动画」——结构已变，又会崩。
  assert.ok(/start\(\(\{ finished \}\) => \{[\s\S]{0,240}?if \(!finished\)/.test(view),
    '动画回调要检查 finished：停表后不再续起下一段动画');
});

test('阅读器：底部进度避让系统栏，目录/评论顶栏不再贴系统区', () => {
  const view = readSource('src/books/BookReaderView.js');
  assert.ok(/READER_INSET_BOTTOM = 56/.test(view), '正文底部内缩放宽（让开系统导航栏）');
  assert.ok(/bottomBar:\s*\{[\s\S]{0,300}?paddingBottom:\s*24/.test(view),
    '底栏自身留出安全边距，最后一行进度字不再被遮一半');
  assert.ok(view.includes('styles.modalTopBar'), '目录与评论页用非浮层顶栏');
  assert.ok(view.includes('modalTopBar: {'), '样式已定义');
  // 阅读页那套 topBar 是 absolute 贴屏幕顶，全屏 Modal 里复用会把标题顶进状态栏
  assert.ok(/modalRoot:\s*\{\s*paddingTop:\s*48/.test(view), 'Modal 顶部内缩同步放宽');
});

test('章节目录：搜索 + 当前章标记 + 粗略已读百分比', () => {
  const view = readSource('src/books/BookReaderView.js');
  // 搜索
  assert.ok(view.includes('chapterQuery'), '有搜索关键词状态');
  assert.ok(view.includes('filteredChapters'), '按关键词过滤');
  assert.ok(view.includes("t('books.reader.chapter.search')"), '搜索框文案');
  assert.ok(view.includes("t('books.reader.chapter.noMatch')"), '无匹配文案');
  // 过滤后仍按原下标高亮与跳转（否则搜索一次就会跳错章）
  assert.ok(/chapterEntries[\s\S]{0,200}?index,/.test(view) || view.includes('({ ...chapter, index })'),
    '章节条目携带原下标');
  // 当前章 + 百分比
  assert.ok(view.includes('currentChapterIndex'), '算当前所在章');
  assert.ok(view.includes('chapterReadPercent'), '算粗略已读百分比');
  assert.ok(view.includes("t('books.reader.chapter.current')"), '「正在阅读」标记');
  assert.ok(/t\('books\.reader\.chapter\.progress',\s*\{\s*percent/.test(view), '百分比文案带参数');
  assert.ok(view.includes("t('books.reader.chapter.done')"), '读满显示已读完');
});

test('章节定位条：打开停在当前章，拖动时显示第几章', () => {
  const view = readSource('src/books/BookReaderView.js');
  const scrubber = readSource('src/books/ChapterScrubber.js');
  assert.ok(view.includes('ChapterScrubber'), '目录页接入定位条');
  assert.ok(/currentIndex=\{currentChapterIndex\}/.test(view), '把当前章交给定位条');
  assert.ok(/yFromIndex\(next\)/.test(scrubber), '打开时滑块摆到当前章位置');
  assert.ok(/t\('books\.reader\.chapter\.position',\s*\{\s*index:/.test(scrubber),
    '拖动时显示「第 N / M 章」');
  assert.ok(scrubber.includes('badgeTitle') || scrubber.includes('chapter.title'), '同时显示章标题');
  assert.ok(scrubber.includes('onSeekRef.current(indexRef.current)'),
    '松手才跳转：拖动中每帧滚动目录会卡');
  assert.ok(scrubber.includes('onPanResponderTerminationRequest: () => false'),
    '拖到一半被父容器抢走手势会跳回原位');
});

test('陪读评论：本页 + 整章两个入口，按钮写明角色名', () => {
  const view = readSource('src/books/BookReaderView.js');
  assert.ok(/t\('books\.comments\.generate',\s*\{\s*character:/.test(view), '本页入口带角色名');
  assert.ok(/t\('books\.comments\.generateChapter',\s*\{\s*character:/.test(view), '整章入口带角色名');
  assert.ok(view.includes('activeCharacterName'), '角色名取自当前选中的角色卡');
  assert.ok(view.includes('activeCharacter'), '按 characterId 找角色卡');
  assert.ok(view.includes('handleCommentChapter'), '整章评论处理');
  assert.ok(/chapterEntries\[currentChapterIndex\]/.test(view), '按当前章取范围');
  assert.ok(/block\.index >= start && block\.index < end/.test(view), '摘录取整章的块');
});

test('书架：书名搜索 + 分组（复用通用集合组件），删书级联清理分组引用', () => {
  const screen = readSource('src/books/BookScreen.js');
  assert.ok(screen.includes('books.search.placeholder'), '书名搜索框');
  assert.ok(/activeShelf\.bookIds\.includes\(item\.id\)/.test(screen), '按分组筛选');
  assert.ok(/String\(item\.name \|\| ''\)\.toLowerCase\(\)\.includes\(keyword\)/.test(screen),
    '书名匹配大小写不敏感');
  assert.ok(screen.includes('purgeBooksFromShelves'), '删书必须级联清理分组引用');
  assert.ok(screen.includes('CollectionNameModal') && screen.includes('CollectionPickerModal'),
    '分组弹窗复用 ui 通用集合组件');

  const shelves = readSource('src/books/shelves.js');
  assert.ok(shelves.includes('createCollectionStore'), '分组存储委托通用集合工厂');
  assert.ok(/itemField:\s*'bookIds'/.test(shelves), '条目字段 bookIds');
  assert.ok(/errorCodePrefix:\s*'shelf'/.test(shelves), '错误码前缀 shelf');
});

test('歌单与书架分组共用同一套集合存储/弹窗实现（不重复造）', () => {
  const playlists = readSource('src/music/playlists.js');
  assert.ok(playlists.includes('createCollectionStore'), '歌单存储同样委托通用集合工厂');
  assert.ok(/itemField:\s*'songIds'/.test(playlists), '条目字段 songIds');

  const music = readSource('src/music/MusicScreen.js');
  assert.ok(music.includes('CollectionNameModal') && music.includes('CollectionPickerModal'),
    '歌单弹窗复用 ui 通用集合组件');
  assert.ok(!/from '\.\/PlaylistModals\.js'/.test(music), '不得再引用已删除的专属弹窗实现');
});
