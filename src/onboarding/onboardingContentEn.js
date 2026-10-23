// 教学章节（基础 16 章 + 免责声明章）英文参考译文 + 语言选择器。
//
// 与 onboardingContent.js 的基础章节**逐章一一对应**（同 id / 同序 / 同图标 / 同截图键 /
// 同步骤数 / 同速查项数；结构对齐由 tests/onboardingContent.test.mjs 的英文组钉住）。
// 语言政策（2026-10-24 用户裁决）：中文是权威文本，本文件随界面语言被选用；
// 用户可见字符串全部为英文，代码注释仍按仓库惯例用中文。路径用词对齐 en 词条的
// 真实界面文案（API Configuration / Get API Key / Detect Models / Set key /
// Enable Vector Search / Chat Illustrations / Voice Playback 等）。
//
// 为什么导出的是**函数**而不是常量：chat-api / image-api 两章的厂商与生图服务商
// 速查项用 tActive(nameKey) 按活动语言解析——必须是「渲染时解析」才能在运行时切语言
// 后拿到英文（zh 文件是模块级常量、import 时解析一次，属既有行为，此处不回改）。
// 因此本文件导出 getOnboardingChaptersEn()，由 onboardingContent.getOnboardingChapters
// 在 localeId === 'en' 时按次调用。

import { CHAT_API_VENDORS, THIRD_PARTY_RELAY_RISK } from '../network/apiVendors.js';
import { IMAGE_PROVIDERS } from '../imageGen/providers.js';
import { tActive } from '../i18n/index.js';
import { DISCLAIMER_SECTIONS_EN } from './disclaimerContent.js';
import { ONBOARDING_CHAPTERS_BATCH2_EN } from './onboardingContentBatch2En.js';

// 基础 16 章：与 zh 的 BASE_CHAPTERS 同序同构。chat-api / image-api 两章含动态速查项，
// 由 buildBaseChaptersEn() 在每次调用时构造。
function buildBaseChaptersEn() {
  const chatVendorItems = CHAT_API_VENDORS.map(vendor => ({
    name: tActive(vendor.nameKey),
    where: 'Settings → API Configuration → New',
    usage: tActive(vendor.noteKey),
  }));

  const imageProviderItems = IMAGE_PROVIDERS.map(provider => ({
    name: tActive(provider.labelKey),
    where: 'Extensions → Image gen → Set key',
    usage: [provider.keyHintKey, provider.networkNoteKey, provider.corsNoteKey]
      .map(key => (key ? tActive(key) : ''))
      .filter(Boolean)
      .join(' '),
  }));

  return [
    {
      id: 'chat-api',
      title: 'Getting and setting up a chat API',
      icon: 'key-outline',
      image: 'chat-api',
      summary: 'Configure a working model first — that\'s what makes the app chat.',
      intro: 'EasyChat2 ships with no model. You bring your own OpenAI-compatible chat endpoint. Official platforms with direct connectivity are recommended first: stable and proxy-free.',
      steps: [
        'Open the "Settings" tab and find the "API Configuration" card.',
        'Tap "New" and pick an official direct-connect platform from the vendor list. DeepSeek, ModelScope, or ai.gitee are good first picks.',
        'Register on the vendor\'s site and create an API Key. The "Get API Key" link under the key field in Settings jumps straight to the right page.',
        'Paste the API Key back into the app. Base URL and protocol come from the vendor preset — usually no edits needed.',
        'In the "Models" area tap "Detect Models" to fetch the available list; tap one to make it current, or type a model name manually.',
        'Tap "Save", go back to the chat tab, and send a message — a reply means you\'re set.',
      ],
      items: [
        {
          name: 'Get an API Key',
          where: 'Settings → API Configuration → "Get API Key" below the key field',
          usage: 'Opens the selected vendor\'s key page. Copy the key and paste it into the app; keys are stored on this device only.',
        },
        {
          name: 'Vendor presets',
          where: 'Settings → API Configuration → New',
          usage: 'Built-in vendors prefill Base URL, protocol, and auth style so you don\'t hand-write parameters.',
        },
        {
          name: 'Detect Models',
          where: 'Settings → API Configuration → Models',
          usage: 'Fetches the model list from the endpoint; tap a model to make it the current one.',
        },
        {
          name: 'Custom vendor / protocol',
          where: 'Settings → API Configuration → New → Third-party relay (custom)',
          usage: 'Fill in Base URL, protocol, and auth headers yourself to connect any OpenAI-compatible service.',
        },
        ...chatVendorItems,
      ],
      note: `Third-party relay risk notice: ${THIRD_PARTY_RELAY_RISK.map(key => tActive(key)).join(' ')}`,
      outro: {
        body: 'Once the API is configured, you can ask the built-in "EasyChat2 assistant" in the Chat tab anything — she knows where every feature lives and how it works.',
      },
    },
    {
      id: 'local-model',
      title: 'Local models & the local API',
      icon: 'hardware-chip-outline',
      images: [
        { key: 'local-model', caption: 'Library: load / unload installed models; toggle "allow image / audio input".' },
        { key: 'local-model-get', caption: 'Get: download by model ID (Hugging Face / CN mirrors / ModelScope) or import local files.' },
        { key: 'local-model-api', caption: 'Serve: expose the local model as a 127.0.0.1 OpenAI-compatible endpoint for other clients on the same device.' },
      ],
      summary: 'Run models offline and expose them as an OpenAI-compatible service.',
      intro: 'Local models run inference entirely on this phone: no network, no cloud quota. Once enabled, you can also expose the model as a "local OpenAI-compatible service" for other clients on the same device.',
      steps: [
        'Open "Settings → About → Local Models" to enter the local-model panel.',
        'Download a GGUF model from search, or import a GGUF file already on the device (multimodal models can also pick an mmproj).',
        'Tap "Load" on a model in the list to make it the current local model.',
        'Switch to the chat tab and pick the "Local" source to chat offline.',
        'To serve other clients: at the bottom of the panel set the "Local API service" port (default 8080) and an optional API Key, then tap "Start service".',
        'Copy the local address shown in the panel (looks like http://127.0.0.1:8080/v1) into the other client\'s base_url / endpoint field.',
      ],
      items: [
        { name: 'Download / import models', where: 'Settings → About → Local Models', usage: 'Search and download GGUF, or import GGUF files from this device.' },
        { name: 'Load / unload', where: 'Local models → model card', usage: 'Loaded models serve inference; unloading frees memory and returns to online sources.' },
        { name: 'Local API port', where: 'Local models → Local API service → Port', usage: 'Default 8080; when taken, the service falls back to another port — trust the displayed address.' },
        { name: 'Local API Key', where: 'Local models → Local API service → API Key', usage: 'Leave empty to auto-generate a random key and store it; clients must send Authorization: Bearer <key>.' },
        { name: 'Copy address', where: 'Local models → Local API service → address bar', usage: 'Tap the address bar to copy http://127.0.0.1:<port>/v1 and paste it into the client.' },
      ],
      note: 'The local API service listens on 127.0.0.1 only — nothing outside the device can reach it. The address ends in /v1, an OpenAI-compatible base_url; usually no need to append /chat/completions.',
    },
    {
      id: 'user-persona',
      title: 'User persona',
      icon: 'person-circle-outline',
      image: 'user-persona',
      summary: 'Tell characters who "you" are, so conversations fit you better.',
      intro: 'Your persona is your in-conversation identity. This information is injected into prompts, and character regex scripts can reference your name via {{user}}. The avatar is shared across all personas.',
      steps: [
        'Open "Settings" and find the "User Persona" card.',
        'Tap a persona in the chip list to switch, or tap "+ Add Persona" to create one.',
        'Fill in "Persona Name (current)" and "Persona Description" — e.g. what to call you, who you are, your relationship to the character.',
        'Tap "Save User Persona" to write it to this device.',
        'Back in chat, the character will address and understand you by this persona.',
      ],
      items: [
        { name: 'Switch persona', where: 'Settings → User Persona → chip list', usage: 'Tap a persona to make it current.' },
        { name: 'Add persona', where: 'Settings → User Persona → + Add Persona', usage: 'Create a new persona and make it current automatically.' },
        { name: 'Delete persona', where: 'Settings → User Persona → Delete', usage: 'At least one persona must remain; deleting the current one switches to the first remaining.' },
        { name: 'Name / description', where: 'Settings → User Persona', usage: 'The name is referenced by characters and regex scripts; the description is injected into prompts.' },
        { name: 'Shared avatar', where: 'Settings → User Persona', usage: 'The avatar is shared by all personas and does not switch with them.' },
      ],
      note: 'The more specific the description, the more consistently characters play along; leaving it empty does not affect normal chatting.',
    },
    {
      id: 'character-card',
      title: 'Getting character cards',
      icon: 'id-card-outline',
      image: 'character-card',
      summary: 'Import character cards you like and start your own conversations.',
      disclaimer: 'This chapter only provides technical information and makes no guarantee as to the legality or safety of content on any third-party platform. The risks of third-party platforms have been clearly warned about in advance; users assume all risks of using them.',
      intro: 'Character cards can be found on social media and websites, or by asking an AI. A few platform entry points are listed below for reference — what you find is decided by each platform\'s algorithms and your own search.',
      warning: 'Check the copyright status of character cards yourself; avoid unauthorized adaptations of well-known anime, game, or film/TV characters (derivative cards of IPs like Attack on Titan or One Piece), don\'t redistribute what you download on public channels, and prefer original characters. This chapter does not display or recommend any specific card — only platform entry points. What you see and download is decided by platform algorithms and your own search.',
      links: [
        { label: 'AI Character Cards', url: 'https://aicharactercards.com/search' },
        { label: 'Character Tavern', url: 'https://character-tavern.com/search/cards' },
        { label: 'RisuRealm', url: 'https://realm.risuai.net/?search=' },
      ],
      steps: [
        'Search and download character cards on the platforms below; common formats are PNG images and JSON text.',
        'Open the "Characters" tab and go to the "Basics" section.',
        'Tap "Import character card" and choose a PNG or JSON file.',
        'Imported characters appear in the library; tap one to make it current.',
        'For oversized cards, the app saves the body to a local file to avoid oversized AsyncStorage values; standalone greetings with HTML, scripts, and styles render in the chat\'s rich HTML view.',
        'To adjust, edit the name, avatar, persona, greeting, and other fields on the character page.',
      ],
      items: [
        {
          name: 'Import character card',
          where: 'Characters → Basics → Import character card',
          usage: 'Supports V2/V3 PNG and JSON cards; persona, greeting, lorebook, and regex are parsed on import. Large card bodies are offloaded to local files.',
        },
        {
          name: 'Card sources',
          where: 'AI Character Cards / Character Tavern / RisuRealm',
          usage: 'Search and download within the platforms; watch copyright and licenses, and avoid files of unknown origin.',
        },
        {
          name: 'Large HTML greetings',
          where: 'Character card regex scripts / greetings',
          usage: 'Greetings can carry full HTML, CSS, scripts, and regex replacements; chat renders them from local files in a scrollable WebView.',
        },
        {
          name: 'Export character card',
          where: 'Characters → Basics → Export character card',
          usage: 'Export the current character to a file for backup or sharing.',
        },
      ],
      outro: {
        title: 'Advanced tool: Nika-Character-Studio',
        body: 'If you can\'t find a card you like, or want to create one from a favorite novel or setting, try this open-source project: Nika-Character-Studio (by HiUnikitty). It is a fully local AI character-card editor — data never leaves your machine. Main features:',
        bullets: [
          'Novel-to-lorebook system: turn novel text into a card\'s lorebook in one click.',
          'AI completion: helps draft description, personality, and dialogue examples.',
          'Lorebook generation: auto-generate character lorebooks with AI assistance.',
          'One-click translation: quickly translate English cards into Chinese.',
          'Interactive variable cards: build adventure cards with health, gold, inventory UIs.',
        ],
        link: { label: 'Project page: Nika-Character-Studio', url: 'https://github.com/HiUnikitty/Nika-Character-Studio' },
        linkNotice: 'This tool is local open-source software and ships no preset card content. For content you create and distribute with it, make sure it does not infringe third-party copyrights.',
        disclaimer: 'This chapter only provides technical information and makes no guarantee as to the functionality of the project or the copyright and legality of its output. The risks of third-party tools and their content have been clearly warned about in advance; users assume all risks of using the tool and any resulting content.',
      },
      note: 'Lorebooks and regex inside cards come from their creators; results may differ from expectations. If something misbehaves, disable the offending entries first.',
    },
    {
      id: 'chat-ui',
      title: 'The chat screen & chat settings',
      icon: 'chatbubbles-outline',
      image: 'chat-ui',
      images: [
        { key: 'chat-ui', caption: 'The conversation: message bubbles and action rows.' },
        { key: 'chat-ui-menu', caption: 'The top "⋯" menu: Notice, Model, Thinking, Locate, Search, Summary, and Settings.' },
        { key: 'chat-ui-empty', caption: 'The empty-session guide: it asks you to set an API key in Settings first.' },
      ],
      summary: 'Learn the chat screen\'s main controls and make conversations smoother.',
      intro: 'The chat screen is where you spend most of your time — the bottom input bar, the top menu, and the per-message actions cover most features.',
      steps: [
        'Type in the bottom input bar and tap the arrow on the right to send; while generating, the button becomes Stop and you can interrupt anytime.',
        'Tap the avatar and name at the top-left to switch characters.',
        'Tap the top "⋯" to open the menu: Notice, Model, Thinking, Locate, Search, Summary, and Settings.',
        'Long-press a message or use its action row to copy, quote, or regenerate; "Edit & resend" on your own text messages confirms the retraction scope first.',
      ],
      items: [
        { name: 'Send a message', where: 'Arrow at the right of the input bar', usage: 'Tap send after typing and the assistant starts replying.' },
        { name: 'Stop generating', where: 'The send button turns into Stop while generating', usage: 'Tap to interrupt the reply being generated.' },
        { name: 'New session', where: 'Top "New" button', usage: 'Start a new conversation with the current character; old ones stay in "Memory".' },
        { name: 'More menu', where: 'Top "⋯" button', usage: 'Opens Notice, Model, Thinking, Locate, Search, Summary, and Settings.' },
        { name: 'Thinking', where: '"⋯" menu → Thinking', usage: 'When on, the model outputs its reasoning before the final reply.' },
        { name: 'Locate', where: '"⋯" menu → Locate', usage: 'Drag the slider to jump anywhere in the session.' },
        { name: 'In-session search', where: '"⋯" menu → Search', usage: 'Find keywords in the current session and jump between hits.' },
        { name: 'Summary', where: '"⋯" menu → Summary', usage: 'Manually trigger a memory summary of the current session.' },
        { name: 'Chat settings', where: '"⋯" menu → Settings', usage: 'Open the chat settings sheet, or jump to system settings and character editing.' },
        { name: 'Quote a message', where: 'Message action row', usage: 'Quote a message and send; the quoted content is submitted along with your text.' },
        { name: 'Edit & resend', where: 'Your text message → Edit & resend', usage: 'After confirmation, retracts the message and later replies and puts the original text back in the input box.' },
        { name: 'Images & stickers', where: 'Input bar attachments / smiley button', usage: 'Images split into media messages; stickers can be added from your gallery and reused.' },
        { name: 'Voice playback', where: 'Top "Playback on / off"', usage: 'Controls whether assistant replies are read aloud.' },
        { name: 'Clear chat', where: 'The action near the input bar', usage: 'Clears the current session\'s messages, with a confirmation.' },
      ],
      note: 'In group sessions, characters take turns or speak together via the scheduler; you can also @mention a character to let it go first.',
    },
    {
      id: 'chat-media',
      title: 'Images, stickers & large cards',
      icon: 'image-outline',
      summary: 'Send local images, collect reusable stickers, and use large HTML greetings.',
      intro: 'The chat supports image attachments and stickers. Ordinary images become standalone media messages; stickers can be made from images and reused. Large cards\' standalone HTML greetings get a wider rendering area.',
      steps: [
        'Tap the attachment button on the left of the input bar to pick a text document or image. Images need a vision-capable model source.',
        'When text and image are sent together, the image goes first as a media message and the text follows as a second user message; sending only an image creates no empty text message.',
        'Long-press an image in chat to save it, save it as a sticker, or delete the image message. Image files live in the app\'s local directory and are reclaimed by reference after deletion.',
        'Tap the translucent smiley on the right of the input bar to open the sticker panel; the first cell adds a sticker from your gallery — pick an image and name it to save.',
        'With "Settings → Chat Experience → full-width chat" enabled, the avatar and name sit above the message — name to the right of the avatar — and the bubble spans the chat area.',
        'When importing large PNG or JSON cards, the app saves oversized bodies to local files; standalone greetings with HTML, scripts, and styles render in a scrollable area.',
        '"Edit & resend" on a text message asks first; confirming retracts that message and its later replies and puts the original text back in the input box.',
      ],
      items: [
        { name: 'Image attachments', where: 'Chat → attachment on the left of the input bar', usage: 'Pick an image and keep typing alongside; the image becomes its own media message.' },
        { name: 'Image long-press actions', where: 'Chat images', usage: 'Save the image, save as sticker, or delete the image message.' },
        { name: 'Sticker panel', where: 'Chat → smiley on the right of the input bar', usage: 'First cell adds a sticker; tap a saved sticker to send it.' },
        { name: 'Sticker name', where: 'Sticker save dialog', usage: 'The name is used as a model hint and a readable label in history.' },
        { name: 'Full-width chat', where: 'Settings → Chat Experience → full-width chat', usage: 'Makes bubbles span the chat area, with the avatar and name above the message.' },
        { name: 'Large card greetings', where: 'Characters → Import card → Chat', usage: 'Supports large HTML, scripts, styles, and regex-replaced greetings via local files and WebView rendering.' },
        { name: 'Edit & resend', where: 'Text message → Edit & resend', usage: 'After confirmation, retracts the message and later replies; the original text returns to the input box.' },
      ],
      note: 'Images and stickers stay on this device. Ordinary images are checked for file size, resolution, count, and total volume; vision support depends on the current API source.',
    },
    {
      id: 'character-edit',
      title: 'Editing characters',
      icon: 'create-outline',
      image: 'character-edit',
      images: [
        { key: 'character-library', caption: 'The library: tap cards to switch; create, group chats, and batch select at the top; group chats appear as cards too.' },
        { key: 'character-edit', caption: 'The editor: tags, save, and entries to lorebook / regex / global presets.' },
      ],
      summary: 'Customize a character\'s persona, greeting, and advanced capabilities.',
      intro: 'The character page edits every field so you can shape the conversation style you want. Chat settings can also open character editing in place.',
      steps: [
        'Open the "Characters" tab and pick a character.',
        'Fill in "Basics": name, avatar, and background.',
        'Describe identity, personality, and speaking style in Persona / System prompt; the final system prompt is composed on save.',
        'Fill in description, personality, and scenario to round out the setting.',
        'Set a greeting and alternate greetings; a new session picks one at random.',
        'Fill in "Example dialogues" to show the model the Q&A style you expect.',
        'Set tags for easier searching and grouping.',
        'When you need advanced capabilities, edit the lorebook and regex scripts on the character page.',
      ],
      items: [
        { name: 'Name / avatar / background', where: 'Characters → Basics', usage: 'The character\'s display info; avatar and background can be picked from the gallery.' },
        { name: 'Persona / system prompt', where: 'Characters → Persona', usage: 'The core setting; the final prompt is composed on save.' },
        { name: 'Description / personality / scenario', where: 'Characters → respective fields', usage: 'Fills out the background; in group chats it feeds the scheduler\'s intro.' },
        { name: 'Greeting / alternates', where: 'Characters → Greeting', usage: 'The first message of a new session; alternate greetings can be added, removed, and edited one by one.' },
        { name: 'Example dialogues', where: 'Characters → Example dialogues', usage: 'Multi-line examples injected into the prompt for the model to imitate.' },
        { name: 'Tags', where: 'Characters → Tags', usage: 'Used for library search and grouping.' },
        { name: 'Lorebook', where: 'Characters → Lorebook', usage: 'Keyword-triggered background settings with position and depth controls.' },
        { name: 'Regex scripts', where: 'Characters → Regex', usage: 'Replacements on input or output that shape prompts and display.' },
        { name: 'Group chat', where: 'Characters → top "Group chat" button', usage: 'Multi-select 2–8 characters to create a group session.' },
      ],
      note: 'After changing a persona, start a new session to check the effect; old sessions keep their history and summaries.',
    },
    {
      id: 'lorebook',
      title: 'Lorebook',
      icon: 'book-outline',
      image: 'lorebook',
      summary: 'Keyword-triggered background settings for your characters.',
      intro: 'A lorebook is keyword-triggered background material: when a keyword appears in conversation, the matching entry is injected into the prompt, so characters remember worldbuilding, relationships, and details. Entries whose keywords never hit cost no context.',
      steps: [
        'Open the "Characters" tab, pick a character, and enter editing.',
        'In the "Lorebook" area tap "Add lorebook entry".',
        'Fill in the entry name and trigger keywords (comma-separated for several).',
        'Fill in the entry content — settings, relationships, or terminology notes.',
        'Optionally set the injection position and depth to control where it lands in the prompt.',
        'Save the character; from then on, hitting a keyword in chat activates the entry.',
      ],
      items: [
        { name: 'Trigger keywords', where: 'Characters → Lorebook → entry', usage: 'Entries inject only when keywords appear; separate multiple keywords with commas.' },
        { name: 'Entry content', where: 'Characters → Lorebook → entry', usage: 'The body injected into the prompt — keep it short and focused.' },
        { name: 'Position & depth', where: 'Characters → Lorebook → entry', usage: 'Controls before/after insertion and depth relative to the conversation.' },
        { name: 'Enable switch', where: 'Characters → Lorebook → entry', usage: 'Disabled entries stop matching, which helps troubleshooting.' },
      ],
      note: 'More entries and more hits mean more context used; keep only what you really need and pin triggers down with precise keywords.',
    },
    {
      id: 'regex',
      title: 'Regex scripts',
      icon: 'code-slash-outline',
      image: 'regex',
      summary: 'Replace text on input or output to shape prompts and display.',
      intro: 'Regex scripts run find-and-replace in order: they can rewrite the prompt before sending, or replace character replies before display — useful for consistent naming, cleaning up formatting, or hiding content.',
      steps: [
        'Open the "Characters" tab, pick a character, and enter editing.',
        'In the "Regex scripts" area tap "Add regex script".',
        'Fill in the name, the find pattern, and the replacement.',
        'Choose the target (input prompt / output reply) and whether it\'s enabled.',
        'Save the character, then verify the replacement in chat.',
      ],
      items: [
        { name: 'Find / replace', where: 'Characters → Regex scripts → entry', usage: 'Find supports regex; replace is the text written in its place.' },
        { name: 'Target', where: 'Characters → Regex scripts → entry', usage: 'Applies to the prompt before sending, or the reply before display.' },
        { name: 'Enable switch', where: 'Characters → Regex scripts → entry', usage: 'When something breaks, disable the script first and investigate.' },
      ],
      note: 'A wrong script directly changes message content — change one at a time and verify in a new session. Display replacements never rewrite the original message.',
    },
    {
      id: 'presets',
      title: 'Presets',
      icon: 'options-outline',
      image: 'presets',
      summary: 'Text presets appended to the system prompt — per character and global.',
      intro: 'A preset is text appended to the system prompt. Character presets apply to the current character only; global text presets apply to every conversation. Memory summary is a separate global setting that auto-generates digests at a message threshold.',
      steps: [
        'Enter character editing and open "Presets"; or go to "Settings → Global Presets / Memory Summary".',
        'Tap "Add preset" and fill in the name and prompt content.',
        'Enable the preset as needed — disabled ones are not appended.',
        'Global presets affect every character; character presets affect the current one only.',
        'To auto-summarize long conversations, set the threshold and model in "Memory Summary".',
      ],
      items: [
        { name: 'Character preset', where: 'Characters → Presets', usage: 'Applies to the current character only, appended to its system prompt.' },
        { name: 'Global text preset', where: 'Settings → Global Presets / Memory Summary', usage: 'Ignores character cards; applies to all conversations.' },
        { name: 'Memory summary', where: 'Settings → Global Presets / Memory Summary', usage: 'A separate global setting that runs automatically at the message threshold.' },
        { name: 'Enable switch', where: 'Preset entry', usage: 'Only enabled presets are appended to prompts.' },
      ],
      note: 'Presets stack; enabling all of them can crowd the context. Keep only the necessary ones.',
    },
    {
      id: 'memory',
      title: 'Using the Memory tab',
      icon: 'albums-outline',
      image: 'memory',
      summary: 'Manage past sessions and return to any conversation.',
      intro: 'The Memory tab lists every session — resume, pin, clone, delete, and search across all history.',
      steps: [
        'Open the bottom "Memory" tab to see the session list; each row shows avatar, character name, summary, and time.',
        'Tap any session to switch to that character and conversation and continue chatting.',
        'Use the row\'s end buttons to pin, clone, or delete a session.',
        'Tap "Edit" at the top for multi-select and batch deletion.',
        'Tap the top search entry to search keywords across all sessions and jump to hits.',
      ],
      items: [
        { name: 'Session list', where: 'Memory main list', usage: 'Shows each session\'s avatar, character name, summary, and time.' },
        { name: 'Resume chatting', where: 'Tap any session row', usage: 'Switches to that character and conversation and enters the chat.' },
        { name: 'Pin', where: 'Star button at the row\'s end', usage: 'Pinned sessions sort to the top.' },
        { name: 'Clone', where: 'Clone button at the row\'s end', usage: 'Duplicates the session with freshly generated message ids.' },
        { name: 'Delete', where: 'Delete button at the row\'s end', usage: 'Deletes the session and its messages, with a confirmation.' },
        { name: 'Batch delete', where: 'Top "Edit" → multi-select', usage: 'Check several sessions and delete them in one go.' },
        { name: 'Search history', where: 'Memory top search entry', usage: 'Search keywords across all sessions and jump to hits.' },
        { name: 'Auto summary', where: 'Settings → Global Presets → Memory Summary', usage: 'Generates digests at a turn threshold to keep long conversations in context.' },
      ],
      note: 'Summaries show in the session list and feed later requests as memory context; a failed summary never affects normal chatting.',
    },
    {
      id: 'moments',
      title: 'Moments',
      icon: 'images-outline',
      image: 'moments',
      summary: 'Characters post updates; comments get replies grounded in the memory behind each post.',
      intro: 'Moments are posted by characters as the story progresses; you can like and comment. After you comment, the character replies based on the conversation memory that post came from — the exchange is like a conversation, but it is never written into chat history or memory.',
      steps: [
        'Enter the Moments view from the Extensions tab to see what characters posted.',
        'Turn the feature on or off in Settings.',
        'Like or comment — interactions feed affinity.',
        'After you comment, the character replies based on that post\'s source memory; you can keep chatting under the same post.',
        'Tap a post to read it in full; long-press or use the action button to delete.',
      ],
      items: [
        { name: 'View moments', where: 'Extensions → Moments', usage: 'A timeline of what characters posted.' },
        { name: 'Turn on / configure', where: 'Settings → Moments', usage: 'Enables or disables the feature.' },
        { name: 'Like / comment', where: 'Actions under a post', usage: 'Feeds affinity; comments get replies grounded in the post\'s source memory.' },
        { name: 'Delete a post', where: 'The post\'s action button', usage: 'Deletes one post, with a confirmation.' },
        { name: 'Linked to memory deletion', where: 'Memory delete / delete character with memories', usage: 'If memories back posts, the app asks whether to delete them together.' },
      ],
      note: 'Posts are model-generated and may not match the setting; delete anytime. Comment threads under a post never enter chat history or memory.',
    },
    {
      id: 'vector-api',
      title: 'Getting and setting up a vector API',
      icon: 'git-network-outline',
      image: 'vector-api',
      summary: 'Turn on semantic memory so characters remember longer.',
      intro: 'Vector memory turns past messages into vectors and recalls them by meaning — smarter than keyword matching. It needs a service with an OpenAI-compatible embedding endpoint.',
      steps: [
        'Prepare an account on a platform offering an OpenAI-compatible embedding endpoint, and create an API Key.',
        'Open "Settings" and find the "Vector Memory" card.',
        'Turn on "Enable Vector Search".',
        'Fill in the Base URL (usually ending in /v1), the key, and a model name. The default model is text-embedding-3-small.',
        'Adjust the recall count and chunk length as needed.',
        'Tap "Test connection" — showing the vector dimension means it works.',
      ],
      items: [
        { name: 'Enable Vector Search', where: 'Settings → Vector Memory', usage: 'When on, chat recalls relevant memories via vectors.' },
        { name: 'Base URL', where: 'Settings → Vector Memory → Base URL', usage: 'An OpenAI-compatible embedding endpoint, usually ending in /v1.' },
        { name: 'Key', where: 'Settings → Vector Memory → Key', usage: 'From the platform you chose; stored encrypted on this device.' },
        { name: 'Model', where: 'Settings → Vector Memory → Model', usage: 'Defaults to text-embedding-3-small; change it to match your platform.' },
        { name: 'Recall count / chunk length', where: 'Settings → Vector Memory', usage: 'Controls how many memories are recalled and how text is chunked.' },
        { name: 'Test connection', where: 'Settings → Vector Memory → Test connection', usage: 'Checks the address and key; success shows the vector dimension.' },
      ],
      note: 'Unconfigured or failing connections fall back to keyword search automatically — chatting is never interrupted.',
    },
    {
      id: 'image-api',
      title: 'Getting and setting up image generation',
      icon: 'color-wand-outline',
      image: 'image-api',
      images: [
        { key: 'image-api', caption: 'Image gen: pick service and model, write the prompt, set size and seed.' },
        { key: 'image-api-key', caption: 'The "Set key" panel: fill in the API address and key, with "Get API Key" and a connectivity check.' },
      ],
      summary: 'Configure an image service and generate pictures in the app.',
      intro: 'Image generation lives on the "Extensions" tab and supports several official platforms and OpenAI-compatible relays. Platforms differ in network and CORS requirements — read the panel\'s hints before configuring.',
      steps: [
        'Open the "Extensions" tab and switch to "Image gen".',
        'Tap "Set key" and pick a platform in the provider dropdown.',
        'Tap "Get API Key" to open the platform\'s site, create a key, and paste it in.',
        'Fill in the address and model as the platform requires; tap the connectivity check to verify first.',
        'Back on the image page, enter a prompt, set size or seed, and tap generate.',
        'For image-to-image, upload a reference image and fill in the prompt.',
      ],
      items: [
        { name: 'Set key', where: 'Extensions → Image gen → Set key', usage: 'Configure the current service\'s address, key, model, and extra parameters.' },
        { name: 'Get API Key', where: 'Set key panel → Get API Key', usage: 'Opens the selected platform\'s site to create a key.' },
        { name: 'Connectivity check', where: 'Set key panel → Check connection', usage: 'Verifies the address and key before you spend any quota.' },
        { name: 'Size / seed', where: 'Image gen input area', usage: 'Controls output size and the random seed.' },
        { name: 'Image-to-image', where: 'Upload a reference in the input area', usage: 'Generates a new image based on the reference.' },
        { name: 'Result actions', where: 'The results gallery', usage: 'Tap to save, share, or copy.' },
        ...imageProviderItems,
      ],
      note: 'Some platforms need a proxy in mainland China and some don\'t support direct browser-style CORS connections. Read the panel\'s network and CORS hints and confirm with the connectivity check before generating.',
    },
    {
      id: 'inline-image',
      title: 'Chat illustrations (auto images)',
      icon: 'images-outline',
      image: 'inline-image',
      summary: 'Let the assistant insert generated images into replies.',
      intro: 'With chat illustrations on, the assistant can insert auto-generated images into replies where it helps. Illustrations reuse the service configured under "Extensions → Image gen".',
      steps: [
        'First configure a working image service under "Extensions → Image gen" and confirm the connectivity check passes.',
        'Open "Settings" and find the "Chat Illustrations" card.',
        'Turn on "Auto illustration".',
        'Pick the provider used for illustrations.',
        'Optionally fill in the style prefix, image size, and prompt length cap.',
        'Back in chat, the assistant inserts illustrations when appropriate.',
      ],
      items: [
        { name: 'Auto illustration switch', where: 'Settings → Chat Illustrations', usage: 'When on, the assistant may insert generated images into replies.' },
        { name: 'Image service', where: 'Settings → Chat Illustrations → Image service', usage: 'Pick the provider for illustrations; configure it under Image gen first.' },
        { name: 'Style prefix', where: 'Settings → Chat Illustrations → Style prefix (optional)', usage: 'Prepended to illustration prompts to keep a consistent style.' },
        { name: 'Size (width*height)', where: 'Settings → Chat Illustrations → Size (width*height)', usage: 'Controls illustration size, e.g. 832*1216.' },
        { name: 'Prompt length cap', where: 'Settings → Chat Illustrations → Prompt length cap (chars)', usage: 'Caps each illustration prompt to keep it from ballooning.' },
      ],
      note: 'Auto illustrations consume image-service quota; keep the switch off until a service is configured.',
    },
    {
      id: 'games',
      title: 'Games',
      icon: 'game-controller-outline',
      image: 'games',
      summary: 'Built-in mini games — fully local, no network needed.',
      intro: 'The games area on the "Extensions" tab includes several mini games, all local HTML: no network, no uploads — play anytime.',
      steps: [
        'Open the "Extensions" tab and switch to "Games".',
        'Pick a game from the list to run it full screen.',
        'Follow each game\'s on-screen instructions — touch d-pad or taps.',
        'Tap the top back button to return to the list.',
      ],
      items: [
        { name: 'Enter a game', where: 'Extensions → Games', usage: 'Pick from the list; it loads full screen.' },
        { name: 'Controls', where: 'Inside the game', usage: 'Varies per game — touch buttons and taps.' },
        { name: 'Back to list', where: 'Top back button', usage: 'Exits the current game to the list.' },
        { name: 'Load failure', where: 'The game loading page', usage: 'Tap retry when loading fails; on unsupported devices the entry hides with a notice.' },
      ],
      note: 'Games are pure front-end — no API quota, no network dependency.',
    },
  ];
}

// 免责声明章（英文）：与 zh 的 DISCLAIMER_CHAPTER 同构；条款正文直接复用
// DISCLAIMER_SECTIONS_EN（同一份英文权威条款，tests/disclaimerContent.test.mjs 钉住）。
const DISCLAIMER_CHAPTER_EN = {
  id: 'disclaimer',
  title: 'Disclaimer',
  icon: 'document-text-outline',
  image: 'disclaimer',
  summary: 'Please read and understand in full before use.',
  sections: DISCLAIMER_SECTIONS_EN,
  steps: [
    'This app is for learning and exchange only; see the notice below for intended users and legal compliance.',
    'You configure the API endpoint and key yourself; chat content is sent straight to the address you specify.',
    'Follow the laws and regulations of your jurisdiction and the terms of the platforms you choose.',
  ],
  items: [],
  note: 'You can re-read this notice anytime under "Settings → About → Disclaimer".',
};

// 合并顺序与 zh 完全一致：基础 16 章 → 第二批 12 章 → 免责声明垫底收尾。
export function getOnboardingChaptersEn() {
  return [...buildBaseChaptersEn(), ...ONBOARDING_CHAPTERS_BATCH2_EN, DISCLAIMER_CHAPTER_EN];
}
