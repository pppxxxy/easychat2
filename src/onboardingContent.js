import { CHAT_API_VENDORS, THIRD_PARTY_RELAY_RISK } from './apiVendors';
import { IMAGE_PROVIDERS } from './imageGen/providers';
import { DISCLAIMER_TEXT } from './disclaimer';

// 新手教学 / 使用教程共用内容。
// 每个章节既可作为「分步向导」的一步，也可作为「速查长列表」的一节。
// - summary / intro / steps / note 供向导与长列表展示
// - items 供长列表速查
// - image 为 assets/onboarding 下的截图键，未注册时界面自动跳过

const chatVendorItems = CHAT_API_VENDORS.map(vendor => ({
  name: vendor.name,
  where: '设置 → API 配置 → 新建',
  usage: vendor.note,
}));

const imageProviderItems = IMAGE_PROVIDERS.map(provider => ({
  name: provider.label,
  where: '扩展 → 生图 → 填密钥',
  usage: [provider.keyHint, provider.networkNote, provider.corsNote].filter(Boolean).join(' '),
}));

export const ONBOARDING_CHAPTERS = [
  {
    id: 'chat-api',
    title: '聊天 API 获取与设置',
    icon: 'key-outline',
    image: 'chat-api',
    summary: '先配好一个能对话的模型，App 才能聊起来。',
    intro: 'EasyChat2 本身不带模型，需要你自行准备一个 OpenAI 兼容的聊天接口。推荐优先使用国内可直连的官方平台，稳定且无需代理。',
    steps: [
      '打开底部「设置」，找到「API 配置」卡片。',
      '点击「新建」，在厂商列表中选择一个官方直连平台。推荐 DeepSeek、魔搭社区或 ai.gitee 模力方舟。',
      '在厂商官网注册账号并创建 API Key。设置页 API Key 下方的「点击获取密钥」可直接跳转到对应页面。',
      '回到 App 填入 API Key。Base URL 与协议会随厂商预设自动带出，一般无需修改。',
      '在「模型」区域点击「检测模型」拉取可用模型，点选一个设为当前；也可以手动输入模型名。',
      '点击「保存」，回到聊天页发一条消息，能收到回复即配置成功。',
    ],
    items: [
      {
        name: '获取 API Key',
        where: '设置 → API 配置 → API Key 下方「点击获取密钥」',
        usage: '跳转到所选厂商的密钥页面。复制后粘贴到 App，密钥只保存在本机。',
      },
      {
        name: '选择厂商预设',
        where: '设置 → API 配置 → 新建',
        usage: '内置厂商会自动填好 Base URL、协议与鉴权方式，免去手写参数的麻烦。',
      },
      {
        name: '检测模型',
        where: '设置 → API 配置 → 模型',
        usage: '向接口拉取模型列表，点击某个模型即可设为当前模型。',
      },
      {
        name: '自定义厂商 / 协议',
        where: '设置 → API 配置 → 新建 → 第三方中转站（自定义）',
        usage: '自行填写 Base URL、协议与鉴权头，接入任意 OpenAI 兼容服务。',
      },
      ...chatVendorItems,
    ],
    note: `第三方中转站风险提示：${THIRD_PARTY_RELAY_RISK.join(' ')}`,
  },
  {
    id: 'user-persona',
    title: '用户人设',
    icon: 'person-circle-outline',
    image: 'user-persona',
    summary: '告诉角色「你是谁」，让对话更贴合你。',
    intro: '用户人设是你在对话中的身份。这里的信息会注入到提示词中，角色的正则脚本也可以通过 {{user}} 引用你的名字。头像与拍一拍文案为全部人设共用。',
    steps: [
      '打开「设置」，找到「用户人设」卡片。',
      '在 chip 列表中点击切换当前人设，或点「+ 新增」创建一套新的人设。',
      '填写「人设名称（当前人设）」与「人设描述」，例如你的称呼、身份、与角色的关系。',
      '点击「保存用户人设」写入本机。',
      '回到聊天页，角色就会以这套设定来称呼和理解你。',
    ],
    items: [
      { name: '切换人设', where: '设置 → 用户人设 → chip 列表', usage: '点击某个人设即切换为当前人设。' },
      { name: '新增人设', where: '设置 → 用户人设 → + 新增', usage: '创建一套新人设并自动设为当前。' },
      { name: '删除人设', where: '设置 → 用户人设 → 删除', usage: '至少保留一套人设，删除当前人设时会自动切到剩余首项。' },
      { name: '人设名称 / 描述', where: '设置 → 用户人设', usage: '名字会被角色与正则脚本引用，描述会注入提示词。' },
      { name: '共用头像与拍一拍文案', where: '设置 → 用户人设', usage: '头像与拍一拍文案为全部人设共用，不随人设切换。' },
    ],
    note: '人设描述越具体，角色越能稳定地按你的身份回应；留空也不会影响正常聊天。',
  },
  {
    id: 'character-card',
    title: '角色卡获取',
    icon: 'id-card-outline',
    image: 'character-card',
    summary: '把喜欢的角色卡导入 App，开始专属对话。',
    intro: '角色卡通常以 PNG 或 JSON 文件分享，里面包含角色的名字、人设、开场白，有的还带有世界书与正则脚本。导入后即可直接聊天。',
    steps: [
      '在角色分享社区或创作者处获取角色卡文件，常见格式为 PNG 图片或 JSON 文本。',
      '打开底部「角色」页，进入「基本信息」区块。',
      '点击「导入角色卡」，选择 PNG 或 JSON 文件。',
      '导入成功后角色会出现在角色库中，点选即可设为当前角色。',
      '如需调整，可在角色页编辑名称、头像、人设、开场白等字段。',
    ],
    items: [
      {
        name: '导入角色卡',
        where: '角色 → 基本信息 → 导入角色卡',
        usage: '支持 V2/V3 标准的 PNG 与 JSON 角色卡，导入后自动解析人设、开场白、世界书与正则。',
      },
      {
        name: '角色卡来源',
        where: '角色分享社区或创作者',
        usage: '获取时请留意版权与使用许可，避免导入来源不明的文件。',
      },
      {
        name: '导出角色卡',
        where: '角色 → 基本信息 → 导出角色卡',
        usage: '把当前角色导出为文件，方便备份或分享给他人。',
      },
    ],
    note: '角色卡里的世界书与正则由创作者提供，运行结果可能与预期不同。如遇异常，可先关闭对应条目再排查。',
  },
  {
    id: 'chat-ui',
    title: '聊天界面与聊天设置',
    icon: 'chatbubbles-outline',
    image: 'chat-ui',
    images: [
      { key: 'chat-ui', caption: '聊天对话：消息气泡、操作行与拍一拍旁白（「用户 戳了戳 角色」）。' },
      { key: 'chat-ui-menu', caption: '顶部「⋯」更多菜单：公告、模型、思考、定位、搜索、总结与设置。' },
      { key: 'chat-ui-empty', caption: '空会话时的引导页：提示先在「设置」填写 API Key。' },
    ],
    summary: '认识聊天页的主要操作，让对话更顺手。',
    intro: '聊天页是使用最频繁的界面，底部输入、顶部菜单和消息操作集中了大部分功能。',
    steps: [
      '底部输入框输入内容，点击右侧箭头发送；生成过程中按钮变为停止，可随时中断。',
      '点击顶部左侧头像与名称可切换角色。',
      '点击顶部「⋯」展开更多菜单，包含公告、模型、思考、定位、搜索、总结与设置。',
      '长按或点击消息下方的操作行，可以复制、引用或重新生成。',
      '双击角色头像可以「拍一拍」，以旁白形式提醒对方回应。',
    ],
    items: [
      { name: '发送消息', where: '底部输入框右侧箭头', usage: '输入内容后点击发送，助手开始回复。' },
      { name: '停止生成', where: '生成过程中发送按钮变为停止', usage: '点击可中断正在生成的回复。' },
      { name: '新建对话', where: '顶部「新建」按钮', usage: '为当前角色开启一段新对话，旧对话保留在「记忆」中。' },
      { name: '更多菜单', where: '顶部「⋯」按钮', usage: '展开公告、模型、思考、定位、搜索、总结与设置。' },
      { name: '发送前思考', where: '「⋯」菜单中的「思考」', usage: '开启后模型会先输出推理过程，再给出正式回复。' },
      { name: '消息定位', where: '「⋯」菜单中的「定位」', usage: '拖动滑块快速跳转到会话任意位置。' },
      { name: '会话内搜索', where: '「⋯」菜单中的「搜索」', usage: '在当前会话内查找关键词并逐个定位。' },
      { name: '总结', where: '「⋯」菜单中的「总结」', usage: '手动触发对当前会话的记忆总结。' },
      { name: '聊天设置', where: '「⋯」菜单中的「设置」', usage: '进入聊天设置弹窗，或跳转系统设置与角色编辑。' },
      { name: '引用消息', where: '消息操作行', usage: '引用某条消息后再发送，引用内容会一并提交。' },
      { name: '拍一拍', where: '双击角色头像', usage: '以旁白形式提醒对方，触发一次自然回应，不计入正式提问。' },
      { name: '语音播报', where: '顶部「播报开 / 播报关」', usage: '控制是否朗读助手回复。' },
      { name: '清空聊天', where: '输入栏附近的操作入口', usage: '清空当前会话消息，需二次确认。' },
    ],
    note: '群聊会话里，角色会根据调度自动轮流或集体发言，也可以 @某个角色点名让它先说话。',
  },
  {
    id: 'character-edit',
    title: '角色编辑',
    icon: 'create-outline',
    image: 'character-edit',
    images: [
      { key: 'character-library', caption: '角色库：卡片点选切换，顶部可新建、创建群聊、批量多选；群聊也会作为卡片出现。' },
      { key: 'character-edit', caption: '编辑表单：拍一拍文案、标签、保存，以及世界书 / 正则 / 全局预设入口。' },
    ],
    summary: '自定义角色的人设、开场白与高级能力。',
    intro: '在角色页可以编辑角色的全部字段，塑造出符合预期的对话风格。聊天设置里也能就地打开角色编辑。',
    steps: [
      '打开「角色」页，选择要编辑的角色。',
      '在「基本信息」填写名称、头像与背景。',
      '在人设 / 系统提示词中描述角色的身份、性格与说话方式；保存时 App 会合成最终系统提示词。',
      '填写角色描述、性格与场景，让角色设定更完整。',
      '设置开场白与备用开场白，新建对话时随机使用。',
      '在「对话示例」填入期望的问答样式，引导模型模仿。',
      '设置「拍一拍文案」与标签，方便分类与触发旁白。',
      '需要高级能力时，在角色页编辑世界书与正则脚本。',
    ],
    items: [
      { name: '名称 / 头像 / 背景', where: '角色 → 基本信息', usage: '角色的显示信息，头像与背景可从相册选择。' },
      { name: '人设 / 系统提示词', where: '角色 → 人设', usage: '决定角色的核心设定，保存时合成最终提示词。' },
      { name: '角色描述 / 性格 / 场景', where: '角色 → 对应字段', usage: '补充角色背景，群聊时会作为简介参与调度。' },
      { name: '开场白 / 备用开场白', where: '角色 → 开场白', usage: '新建对话时的第一条消息，备用开场白可逐条增删改。' },
      { name: '对话示例', where: '角色 → 对话示例', usage: '多行示例，注入提示词让模型模仿表达方式。' },
      { name: '拍一拍文案', where: '角色 → 拍一拍文案', usage: '留空时使用全局默认文案。' },
      { name: '标签', where: '角色 → 标签', usage: '用于角色库搜索与分类。' },
      { name: '世界书', where: '角色 → 世界书', usage: '按关键词命中注入的背景设定，支持位置与深度配置。' },
      { name: '正则脚本', where: '角色 → 正则', usage: '对输入或输出做替换，控制提示词与展示效果。' },
      { name: '群聊', where: '角色 → 顶部「群聊」按钮', usage: '多选 2-8 个角色创建群聊会话。' },
    ],
    note: '修改人设后建议新建一段对话验证效果，旧会话仍会保留历史消息与总结。',
  },
  {
    id: 'memory',
    title: '记忆页面使用',
    icon: 'albums-outline',
    image: 'memory',
    summary: '管理历史会话，随时回到过去的对话。',
    intro: '记忆页汇总所有会话，可以续聊、置顶、克隆、删除，也能跨会话搜索历史内容。',
    steps: [
      '打开底部「记忆」页查看会话列表，每行显示头像、角色名、摘要与时间。',
      '点击任意会话即可切换到该角色与会话继续对话。',
      '用行尾按钮置顶、克隆或删除会话。',
      '点击顶部「编辑」进入多选模式，可批量删除。',
      '点击顶部搜索入口，跨全部会话按关键词检索并跳转定位。',
    ],
    items: [
      { name: '会话列表', where: '记忆页主列表', usage: '展示每个会话的头像、角色名、摘要与时间。' },
      { name: '继续对话', where: '点击任意会话行', usage: '切换到该角色与会话并进入聊天页。' },
      { name: '置顶', where: '会话行右侧星标按钮', usage: '置顶会话排在列表最前。' },
      { name: '克隆', where: '会话行右侧克隆按钮', usage: '复制一份会话，消息 id 重新生成。' },
      { name: '删除', where: '会话行右侧删除按钮', usage: '删除会话及其消息，需二次确认。' },
      { name: '批量删除', where: '顶部「编辑」进入多选模式', usage: '勾选多个会话后统一点击删除。' },
      { name: '搜索历史', where: '记忆页顶部搜索入口', usage: '跨全部会话按关键词检索并跳转定位。' },
      { name: '自动总结', where: '设置 → 全局预设 → 记忆总结', usage: '按轮数阈值自动生成摘要，让长对话保持在上下文内。' },
    ],
    note: '摘要会展示在会话列表并作为后续请求的记忆上下文；总结失败不影响正常聊天。',
  },
  {
    id: 'moments',
    title: '动态',
    icon: 'images-outline',
    image: 'moments',
    summary: '让角色发布动态，点赞评论都算数。',
    intro: '动态会根据聊天进展让角色发布内容，你可以点赞、评论，这些互动也会影响角色与你的好感度。',
    steps: [
      '在扩展页进入动态视图，查看角色发布的内容。',
      '在设置中开启或关闭动态功能。',
      '对动态点赞或评论，互动会记录到好感度中。',
      '点击动态可查看完整内容，长按或使用操作按钮可删除。',
    ],
    items: [
      { name: '查看动态', where: '扩展 → 动态', usage: '以时间线形式展示角色发布的内容。' },
      { name: '开启与设置', where: '设置 → 动态', usage: '开启或关闭动态功能。' },
      { name: '点赞 / 评论', where: '动态下方操作', usage: '参与互动，会累计好感度。' },
      { name: '删除动态', where: '动态的操作按钮', usage: '删除单条动态，需二次确认。' },
    ],
    note: '动态内容由模型生成，可能存在与设定不符的情况，可随时删除。',
  },
  {
    id: 'vector-api',
    title: '向量 API 获取与设置',
    icon: 'git-network-outline',
    image: 'vector-api',
    summary: '开启语义记忆，让角色记住更久的事。',
    intro: '向量记忆会把历史消息转成向量并按语义检索，比关键词检索更聪明。它需要一个支持 OpenAI 兼容 embedding 接口的服务。',
    steps: [
      '准备一个提供 embedding 接口、且兼容 OpenAI 协议的平台账号，并创建 API Key。',
      '打开「设置」，找到「向量记忆」卡片。',
      '开启「启用向量检索」。',
      '填入接口地址（Base URL，通常以 /v1 结尾）、密钥与模型名。默认模型为 text-embedding-3-small。',
      '按需调整召回条数与分片长度。',
      '点击「测试连接」，显示向量维度即表示可用。',
    ],
    items: [
      { name: '启用向量检索', where: '设置 → 向量记忆', usage: '开启后聊天侧会用向量召回相关记忆。' },
      { name: '接口地址', where: '设置 → 向量记忆 → 接口地址', usage: 'OpenAI 兼容的 embedding 服务地址，一般以 /v1 结尾。' },
      { name: '密钥', where: '设置 → 向量记忆 → 密钥', usage: '从你选择的平台获取，密文保存在本机。' },
      { name: '模型', where: '设置 → 向量记忆 → 模型', usage: '默认 text-embedding-3-small，可按平台支持情况修改。' },
      { name: '召回条数 / 分片长度', where: '设置 → 向量记忆', usage: '控制每次召回的记忆数量与文本切分长度。' },
      { name: '测试连接', where: '设置 → 向量记忆 → 测试连接', usage: '验证地址与密钥，成功时显示向量维度。' },
    ],
    note: '未配置或连接失败时，聊天会自动降级为关键词检索，不影响正常对话。',
  },
  {
    id: 'image-api',
    title: '生图 API 获取与设置',
    icon: 'color-wand-outline',
    image: 'image-api',
    images: [
      { key: 'image-api', caption: '生图界面：选择服务与模型、填写提示词、设置尺寸与种子。' },
      { key: 'image-api-key', caption: '「填密钥」面板：填写 API 地址与 Key，可「获取 API Key」「检测连通性」。' },
    ],
    summary: '配置生图服务，在 App 内生成图片。',
    intro: '生图功能位于「扩展」页，支持多个官方平台与 OpenAI 兼容中转站。不同平台对网络与跨域的要求不同，配置前请先看平台提示。',
    steps: [
      '打开「扩展」页，切换到「生图」。',
      '点击「填密钥」，在服务下拉中选择平台。',
      '点击「获取 API Key」跳转平台官网创建密钥，复制后填入。',
      '按平台要求填写地址与模型；可先点「检测连通性」验证。',
      '回到生图页输入提示词，设置尺寸或种子后点击生成。',
      '需要图生图时，上传参考图并填写提示词。',
    ],
    items: [
      { name: '填密钥', where: '扩展 → 生图 → 填密钥', usage: '配置当前生图服务的地址、密钥、模型与额外参数。' },
      { name: '获取 API Key', where: '填密钥面板 → 获取 API Key', usage: '跳转所选平台官网创建密钥。' },
      { name: '检测连通性', where: '填密钥面板 → 检测连通性', usage: '在正式生成前验证地址与密钥是否可用。' },
      { name: '尺寸 / 种子', where: '生图输入区', usage: '控制出图尺寸与随机种子。' },
      { name: '图生图', where: '生图输入区上传参考图', usage: '以参考图为基础生成新图片。' },
      { name: '结果操作', where: '生成结果画廊', usage: '点击可保存、分享或复制。' },
      ...imageProviderItems,
    ],
    note: '部分平台在中国大陆需要代理，部分平台不支持网页跨域直连。生成前请先阅读面板内的网络与跨域提示，并用「检测连通性」确认。',
  },
  {
    id: 'inline-image',
    title: '对话配图（自动配图）',
    icon: 'images-outline',
    image: 'inline-image',
    summary: '让助手在回复中自动生成配图。',
    intro: '开启对话配图后，助手可以在回复中插入自动生成的图片，让表达更直观。配图会复用你在「扩展 → 生图」中配置的服务。',
    steps: [
      '先在「扩展 → 生图」中配置好可用的生图服务，确认「检测连通性」通过。',
      '打开「设置」，找到「对话配图」卡片。',
      '开启「自动配图」开关。',
      '选择用于配图的服务 Provider。',
      '按需填写风格前缀、图片尺寸与提示词长度上限。',
      '回到聊天页正常对话，助手会在合适的时候插入配图。',
    ],
    items: [
      { name: '自动配图开关', where: '设置 → 对话配图', usage: '开启后助手可在回复中插入生成图片。' },
      { name: '生图服务', where: '设置 → 对话配图 → 生图服务', usage: '选择用于配图的服务，需先在生图页配置好。' },
      { name: '风格前缀', where: '设置 → 对话配图 → 风格前缀（可选）', usage: '自动追加到配图提示词前，统一出图风格。' },
      { name: '尺寸（宽*高）', where: '设置 → 对话配图 → 尺寸（宽*高）', usage: '控制自动配图的尺寸，例如 832*1216。' },
      { name: '提示词长度上限', where: '设置 → 对话配图 → 提示词长度上限（字符）', usage: '限制单次配图提示词长度，避免过长。' },
    ],
    note: '自动配图会消耗生图服务额度；未配置生图服务时建议保持关闭。',
  },
  {
    id: 'games',
    title: '游戏教程',
    icon: 'game-controller-outline',
    image: 'games',
    summary: '内置小游戏，纯本地运行、无需联网。',
    intro: '「扩展」页的游戏区内置了几款小游戏，全部为本地 HTML，不联网、不上传数据，随时可玩。',
    steps: [
      '打开「扩展」页，切换到「游戏」。',
      '在列表中选择一款游戏，进入全屏运行。',
      '按各游戏内的提示操作，例如触屏方向键或点击。',
      '点击顶部返回可回到游戏列表。',
    ],
    items: [
      { name: '进入游戏', where: '扩展 → 游戏', usage: '在列表中选择游戏，全屏加载运行。' },
      { name: '操作方式', where: '游戏画面内', usage: '各游戏操作不同，包含触屏按键与点击。' },
      { name: '返回列表', where: '游戏页顶部返回', usage: '退出当前游戏回到列表。' },
      { name: '加载失败', where: '游戏加载页', usage: '若加载失败可点击重试；设备不支持时游戏入口会隐藏并提示。' },
    ],
    note: '游戏为纯前端实现，不会消耗 API 额度，也不依赖网络。',
  },
  {
    id: 'disclaimer',
    title: '免责声明',
    icon: 'document-text-outline',
    image: 'disclaimer',
    summary: '使用前请完整阅读并理解。',
    intro: DISCLAIMER_TEXT,
    steps: [
      '本应用仅供学习交流使用，面向成年人。',
      'API 端点与密钥由你自行配置，聊天内容直发到你指定的服务地址。',
      '请遵守所在地法律法规与所选平台的使用条款。',
    ],
    items: [],
    note: '你可以随时在「设置 → 关于 → 免责条款」重新查看本声明。',
  },
];

const CHAPTER_MAP = ONBOARDING_CHAPTERS.reduce((acc, chapter) => {
  acc[chapter.id] = chapter;
  return acc;
}, {});

export function getOnboardingChapter(id) {
  return CHAPTER_MAP[id] || null;
}

export function getOnboardingChapters(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return ONBOARDING_CHAPTERS;
  return ids.map(id => CHAPTER_MAP[id]).filter(Boolean);
}

export default ONBOARDING_CHAPTERS;
