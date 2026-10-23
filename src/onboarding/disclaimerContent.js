// 免责条款内容：**单一来源**（纯数据模块，零依赖，Node 可测）。
//
// 与弹窗组件（`disclaimer.js`）分离的原因：这里只放条款内容，任何 RN/expo
// 依赖都不引入，这样 Node 测试可以直接 import 校验条款完备性与章节一致性，
// 不需要为它打桩 react-native。
//
// ---------------------------------------------------------------------------
// 权威数据源是 `DISCLAIMER_SECTIONS`（分节版），`DISCLAIMER_TEXT` 由它派生。
//
// 为什么权威必须是 SECTIONS：用户是在分节弹窗里读到条款、并勾选「同意」的
// （`disclaimer.js` 默认渲染的就是 SECTIONS）。**被同意的那份必须与看到的那份
// 是同一份**——否则「同意」指向的文本和法律上主张的文本不是一回事，
// 「用户已确认本条款」这个法律效力前提就不成立了。所以权威只能给 SECTIONS。
//
// 历史（2026-10-12 统一）：这两份此前是**同一份条款的两个手写副本**，并且已经
// **实质漂移**（不是排版差异）：
//   · TEXT 独有：「除聊天外」这一限定、「均由你自行选择与授权」。
//   · SECTIONS 独有：「不得干扰、破坏本软件的正常运行。」
//     「因配置错误导致的安全问题、第三方服务中断或数据泄露，由用户自行承担。」
//   · 措辞冲突：「…出租、出借等牟利行为」vs「…出租、出借或以此牟利等商业用途」。
// 而 `disclaimer.js` 当时的行为是「默认 content 取 TEXT，却渲染 SECTIONS」
// ⇒ 用户勾选「同意」时看到的是 SECTIONS，应用却按「已同意 TEXT」记录。
//
// 现按**「对用户更严格」**的口径统一：TEXT 独有的条款全部**并入**对应分节，
// 措辞冲突取**更严**的一版（「商业用途」比「等牟利行为」宽，故取前者），
// **没有删除、也没有放宽任何一条**。统一后 TEXT 改为从 SECTIONS 派生，
// 「两份不一致」在结构上不再可能发生——改条款只能改 SECTIONS 一处。
//
// 为什么不 i18n → 语言政策（2026-10-24 用户裁决，替代此前「纯中文不 i18n」口径）：
// **中文是权威/管辖文本**，条款实质变更仍只改 DISCLAIMER_SECTIONS 一处并 bump
// DISCLAIMER_VERSION（签名棘轮见 tests/disclaimerContent.test.mjs——中文字面变一个字
// 就会红）。DISCLAIMER_SECTIONS_EN 是同一份条款的**英文参考译文**（界面在英文视图底部
// 标注「For reference only; the Simplified Chinese version governs.」），与中文同版本号、
// 逐节一一对应（同序 / 同图标 / 同要点数，tests 钉住）；改中文条款时必须同步重译英文。
// 本文件仍不接 i18n key（条款内容不走 t()），硬编码中文存量清单登记依旧有效；
// 界面上的语言切换标签复用 settings.language.zh / settings.language.en 两个既有词条。
//
// 条款实质变更时记得同步 bump `src/storage/settings/onboarding.js` 的
// DISCLAIMER_VERSION，否则存量用户不会重新确认新条款（法律效力前提）；
// `tests/disclaimerContent.test.mjs` 的版本配对棘轮会强制改动者面对这件事。
// ---------------------------------------------------------------------------

// 结构化条款：**权威数据源**。弹窗与教学章都按这里的顺序与文字展示。
export const DISCLAIMER_SECTIONS = [
  {
    title: '应用性质',
    icon: 'information-circle-outline',
    body: 'EasyChat2 是一个开源 AI 聊天工具，仅供学习交流使用。本软件按「现状（AS IS）」提供，不保证无中断、无错误或完全满足你的需求。',
  },
  {
    title: '适用人群与法律合规告知',
    icon: 'shield-outline',
    body: '根据《生成式人工智能服务管理暂行办法》《未成年人网络保护条例》等相关法律法规，本应用作为拟人化 AI 互动服务，'
      + '依法不向未成年人提供虚拟伴侣、虚拟亲属等亲密关系类服务；向不满十四周岁未成年人提供其他拟人化互动服务的，'
      + '应当取得监护人同意。用户应自行确认其使用行为符合所在地法律法规。',
    bullets: [
      '本告知为法律合规声明，不构成对 Apache-2.0 许可证条款的修改或附加限制；本应用仍以 Apache-2.0 授权，许可证授予的权利不受本告知影响。',
    ],
  },
  {
    title: '用户行为规范',
    icon: 'alert-circle-outline',
    body: '你不得利用本软件从事任何违法违规活动，包括但不限于传播色情、淫秽、暴力、恐怖主义、赌博、毒品、诈骗等信息，'
      + '或侵犯他人知识产权、隐私权、名誉权等合法权益；不得干扰、破坏本软件的正常运行。',
    bullets: [
      '不得诱导 AI 生成违反法律法规或社会主义核心价值观的内容。',
      // 措辞冲突取更严的一版：TEXT 原为「转售、出租、出借等牟利行为」，
      // 这里保留 SECTIONS 的「或以此牟利等商业用途」——「商业用途」的外延比
      // 「牟利行为」宽（无直接营利的商用场景也落在禁止范围内），对用户更严。
      '不得将本软件用于转售、出租、出借或以此牟利等商业用途。',
    ],
  },
  {
    title: '数据与隐私',
    icon: 'lock-closed-outline',
    body: '本软件没有自建服务器与账号体系，不接入任何分析、广告或遥测 SDK，也不采集设备标识符——开发者不接收、不存储、'
      + '不转售你的任何数据。你的角色卡、会话消息、设置与媒体文件全部保存在本机，开发者无法查看；'
      + '卸载应用或清除应用数据即可删除，开发者侧没有可删除的副本。',
  },
  {
    title: '数据与配置',
    icon: 'server-outline',
    body: '用户自行配置 API 端点与密钥，所有聊天内容直发到用户指定的服务地址。',
    bullets: [
      // 2026-10-12 并入 TEXT 独有的两处限定（原本只在整段文本里）：
      // 「除聊天外」把对外发送的范围说全（披露更完整，对用户更严），
      // 「均由你自行选择与授权」把授权来源写明。只并入，不放宽。
      '除聊天外，以下功能在你主动使用时会把你指定的内容直接发往对应第三方服务，均由你自行选择与授权：对话配图与生图（提示词、可选原图）、语音播报（待朗读文本）、语音转写（录音音频）、向量记忆（消息片段与检索词）、联网搜索（搜索关键词）。',
      '请勿在以上任何内容中发送身份证号、银行卡号、密码等个人敏感信息。',
      '请仅使用各平台官方提供的 API 服务。EasyChat2 不提供任何共享 API Key、代理地址、中转接口或非官方接口。',
      '使用非官方渠道、共享密钥或代理服务产生的一切后果，由用户自行承担。',
    ],
  },
  {
    title: 'AI 生成内容标识',
    icon: 'sparkles-outline',
    body: '角色卡生成（AI 制卡）、对话回复、动态与配图均为 AI 生成内容。界面展示「本内容由 AI 生成」等显式标识，'
      + '聊天界面常驻「AI 生成可能有误，仅供参考」提示；AI 生成的角色卡在导出时会于文件元数据中内嵌生成属性信息'
      + '（生成工具、内容编号、生成时间与模型），并在作者注释尾部追加可见标识行，可被识别与追溯。',
    bullets: [
      '不得擅自删除、篡改或隐匿 AI 生成标识（含显式与隐式标识）后对外传播，由此产生的责任由用户自行承担。',
      'AI 生成的角色卡仅供个人虚构创作与测试使用，不得用于商业用途，不得用于生成违法、不良或侵害第三方权益的内容。',
    ],
  },
  {
    title: '技术局限告知',
    icon: 'warning-outline',
    body: '受限于现有技术，AI 生成的内容可能不准确、不完整，或与知名 IP、受版权保护的作品存在相似性；'
      + '生成结果会做常见 IP 关键词提示，但不做穷尽审查，用户应在使用与传播前自行审核并确认有权使用。',
    bullets: [
      'AI 的回复不代表开发者的观点、立场或建议，请自行判断其合理性。',
    ],
  },
  {
    title: '责任限制',
    icon: 'shield-outline',
    body: '在适用法律允许的最大范围内，开发者不对因使用或无法使用本软件而产生的任何直接、间接、附带、特殊、惩罚性或'
      + '后果性损害（包括但不限于数据丢失、经济损失、账号受限、内容或合规问题）承担责任，即使开发者已被告知此类损害的可能性。',
    bullets: [
      '第三方 AI 服务商的可用性、服务条款变更或关停可能导致本软件部分或全部功能无法使用，开发者不承担由此产生的责任。',
      // 本条原本只在 SECTIONS 里（TEXT 缺失）——统一时保留，不因合并而丢条款。
      '因配置错误导致的安全问题、第三方服务中断或数据泄露，由用户自行承担。',
      'AI 生成内容的准确性、合法性——用户对 AI 生成内容的真实性、合法性、准确性自行承担全部责任。',
    ],
  },
  {
    title: '服务变更与投诉',
    icon: 'refresh-outline',
    body: '开发者保留随时修改本条款的权利，修改后的条款随软件更新生效并重新提示确认；'
      + '如用户违反上述规范，开发者有权停止提供软件更新与支持。',
    bullets: [
      '如认为本应用生成的内容侵犯了你的合法权益，请通过仓库 Issues 提交投诉（请提供权利证明、被投诉内容的定位信息与联系方式），收到有效通知后将及时处理。',
    ],
  },
  {
    title: '条款同意',
    icon: 'checkmark-circle-outline',
    body: '使用即代表同意以上条款。',
  },
];

// 整段文本 = 分节的顺序渲染：`标题：正文`，随后直接接各条目（条目之间不插分隔符，
// 保持原本整段文本的段落观感），节与节之间空一行。
//
// 派生而非手写：手写的第二份副本正是上面那段漂移史的成因。派生之后
// 「TEXT 与 SECTIONS 不一致」在结构上不可能发生——条款文字只有 SECTIONS 一处可改。
const renderSection = section => (
  `${section.title}：${section.body}${Array.isArray(section.bullets) ? section.bullets.join('') : ''}`
);

export const DISCLAIMER_TEXT = DISCLAIMER_SECTIONS.map(renderSection).join('\n\n');

// ---------------------------------------------------------------------------
// 英文参考译文（2026-10-24 用户裁决：应用内免责条款出双语 + 界面切换按钮）。
// 与 DISCLAIMER_SECTIONS **逐节一一对应**：同序、同图标、同要点数；
// tests/disclaimerContent.test.mjs 钉住结构对齐、「无中文残留（漏译）」与
// 「TEXT_EN 是 SECTIONS_EN 的渲染产物」。改中文条款（bump 版本）时必须同步重译这里。
// ---------------------------------------------------------------------------
export const DISCLAIMER_SECTIONS_EN = [
  {
    title: 'Nature of the Application',
    icon: 'information-circle-outline',
    body: 'EasyChat2 is an open-source AI chat tool intended for learning and exchange only. This software is provided "AS IS", with no guarantee that it will operate without interruption or errors, or that it will fully meet your needs.',
  },
  {
    title: 'Intended Users and Legal Compliance Notice',
    icon: 'shield-outline',
    body: 'This app is an anthropomorphic AI interactive service. It does not provide minors with intimacy-oriented companionship services such as virtual partners or virtual family members. Where applicable law in your jurisdiction requires guardian consent before providing other anthropomorphic interactive services to minors (for example, users below the age of 14), such consent must be obtained. Users are solely responsible for ensuring that their use of this app complies with the laws and regulations of their own jurisdiction.',
    bullets: [
      'This notice is a legal-compliance statement. It does not modify or add restrictions to the Apache-2.0 license terms; the app remains licensed under Apache-2.0, and the rights granted by the license are unaffected by this notice.',
    ],
  },
  {
    title: 'Acceptable Use',
    icon: 'alert-circle-outline',
    body: 'You must not use this software for any unlawful activity, including but not limited to disseminating pornographic, obscene, violent, terrorist, gambling, drug-related, or fraudulent information, or infringing others\' intellectual property, privacy, reputation, or other lawful rights and interests; nor may you interfere with or disrupt the normal operation of this software.',
    bullets: [
      // 与中文对齐：「违反法律法规」即可，中文版的「社会主义核心价值观」是法域特定表述，
      // 英文参考译文按「遵守所在地法律法规」口径统一（与 README.en/SECURITY.en 同一政策）。
      'Do not induce the AI to generate content that violates applicable laws and regulations.',
      'Do not use this software for commercial purposes such as resale, renting, lending, or otherwise profiting from it.',
    ],
  },
  {
    title: 'Data & Privacy',
    icon: 'lock-closed-outline',
    body: 'This software has no server and no account system, integrates no analytics, advertising, or telemetry SDKs, and does not collect device identifiers — the developer receives, stores, and resells none of your data. Your character cards, session messages, settings, and media files are stored entirely on your device, invisible to the developer; uninstalling the app or clearing its data deletes them, and no copy exists on the developer side.',
  },
  {
    title: 'Data & Configuration',
    icon: 'server-outline',
    body: 'You configure the API endpoint and key yourself; all chat content is sent directly to the service address you specify.',
    bullets: [
      'Beyond chat, the following features — when you actively use them — send the content you designate directly to the corresponding third-party service, each at your own choice and authorization: inline images and image generation (the prompt, plus optional source images), text-to-speech (the text to be read aloud), speech-to-text (the recorded audio), vector memory (message fragments and retrieval queries), and web search (the search keywords).',
      'Do not send sensitive personal information such as ID numbers, bank card numbers, or passwords in any of the above.',
      'Use only the official API services of each platform. EasyChat2 does not provide shared API keys, proxy addresses, relay endpoints, or unofficial endpoints.',
      'All consequences of using unofficial channels, shared keys, or proxy services are borne by the user.',
    ],
  },
  {
    title: 'AI-Generated Content Labeling',
    icon: 'sparkles-outline',
    body: 'Character card generation (AI card forge), chat replies, moments, and inline images are all AI-generated content. The UI shows explicit labels such as "This content is AI-generated", and the chat screen permanently shows "AI output may be wrong; for reference only"; AI-generated character cards embed provenance metadata in the exported file (generating tool, content id, timestamp, and model) and append a visible generated-content line at the end of the creator notes, so the content can be identified and traced.',
    bullets: [
      'Do not remove, tamper with, or conceal AI-generated labels (explicit or implicit) before redistribution; you bear the legal consequences of redistributing content with its labels removed.',
      'AI-generated character cards are for personal fictional creation and testing only; they must not be used for commercial purposes, nor to generate unlawful, harmful, or third-party-right-infringing content.',
    ],
  },
  {
    title: 'Technical Limitations',
    icon: 'warning-outline',
    body: 'Given the limits of current technology, AI-generated content may be inaccurate or incomplete, or may resemble well-known IPs or copyrighted works; results are screened against common IP keywords but not exhaustively — review and confirm you have the rights before using or redistributing.',
    bullets: [
      'AI replies do not represent the developer\'s views, positions, or advice — judge their reasonableness yourself.',
    ],
  },
  {
    title: 'Limitation of Liability',
    icon: 'shield-outline',
    body: 'To the maximum extent permitted by applicable law, the developer is not liable for any direct, indirect, incidental, special, punitive, or consequential damages arising from the use of or inability to use this software (including but not limited to data loss, financial loss, account restrictions, or content and compliance issues), even if advised of the possibility of such damages.',
    bullets: [
      'Third-party AI providers\' availability, terms-of-service changes, or shutdowns may render part or all of this software unusable; the developer bears no responsibility for this.',
      'Security issues caused by misconfiguration, third-party service interruptions, or data leaks are borne by the user.',
      'Accuracy and legality of AI-generated content — you bear full responsibility for the truthfulness, legality, and accuracy of AI-generated content.',
    ],
  },
  {
    title: 'Changes to These Terms & Complaints',
    icon: 'refresh-outline',
    body: 'The developer reserves the right to modify these terms at any time; modified terms take effect with software updates and are re-prompted for confirmation; if you violate the rules above, the developer may stop providing software updates and support.',
    bullets: [
      'If you believe content generated by this app infringes your lawful rights, please file a complaint via the repository\'s Issues (include proof of rights, the location of the reported content, and contact information); upon receiving a valid notice it will be handled promptly.',
    ],
  },
  {
    title: 'Acceptance of Terms',
    icon: 'checkmark-circle-outline',
    body: 'By using the app, you agree to these terms.',
  },
];

// 整段英文 = 分节的顺序渲染，与中文同一派生规则（英文用半角冒号 + 空格）。
const renderSectionEn = section => (
  `${section.title}: ${section.body}${Array.isArray(section.bullets) ? section.bullets.join('') : ''}`
);

export const DISCLAIMER_TEXT_EN = DISCLAIMER_SECTIONS_EN.map(renderSectionEn).join('\n\n');

// 英文视图底部的管辖语言提示：英文是参考译文，中文版为准。
export const DISCLAIMER_EN_NOTICE = 'For reference only; the Simplified Chinese version governs.';

// 按界面语言取条款：zh-CN（默认）返回权威中文，en 返回英文参考译文。
// 切换按钮（disclaimer.js）的默认值跟随界面语言，手动切换只在该次弹窗内生效。
export function getDisclaimerSections(localeId) {
  return localeId === 'en' ? DISCLAIMER_SECTIONS_EN : DISCLAIMER_SECTIONS;
}

export function getDisclaimerText(localeId) {
  return localeId === 'en' ? DISCLAIMER_TEXT_EN : DISCLAIMER_TEXT;
}
