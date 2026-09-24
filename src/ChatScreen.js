import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';
import Markdown from 'react-native-markdown-display';
import RenderHtml, { HTMLContentModel, HTMLElementModel } from 'react-native-render-html';

import { getConfigFingerprint, isCanceledError, isConfigChangedError, sendChatMessage } from './api';
import {
   deleteLocalImage,
   deleteTemporaryImage,
    isImage,
    isTextLike,
    isVisionImage,
  mergeTextAttachments,
  persistImageAttachment,
  pickAttachment,
  pickStickerImage,
  readImageDataUri,
  readTextAttachment,
   getImageDimensions,
   getImageFileInfo,
   getImageMime,
   getPendingStickerImage,
   MAX_IMAGE_ATTACHMENTS,
   MAX_IMAGE_BASE64_BYTES,
   validateImageBatch,
   validateImageSize,
} from './attachments';
import { buildRequestMessages } from './chatPipeline';
import { createMediaMessage, getMessagePromptText, STICKER_MESSAGE_KIND } from './chatMedia';
import { createStickerImage, deleteStickerImage } from './stickerImages';
import { isGreetingMessage, listGreetingCandidates } from './cardGreetings';
import { getEditResendPlan, removeMessagesByIds, toggleMessageSelection } from './messageSelection';
import {
  applySummary,
  buildMemorySummaryText,
  isSessionScopedMemory,
  selectManualSummarizable,
  selectSummarizable,
  shouldSummarize,
  summarizeBoundaryAfterDeletion,
} from './memorySummary';
import { isStaleReply } from './chatRace';
import { useApp } from './context/AppContext';
import CharacterEditForm from './CharacterEditForm';
import GreetingPickerModal from './GreetingPickerModal';
import GroupEditForm from './GroupEditForm';
import DisclaimerModal from './disclaimer';
import {
  buildEnsemblePrompt,
  buildGroupRequest,
  ENSEMBLE_MODE,
  ensureMemberProfiles,
  EVERYONE_MENTION,
  generateOpening,
  hasEveryoneMention,
  mergeAdjacentSegments,
  MENTION_PREFIX,
  parseEnsembleReply,
  parseMentions,
  selectSpeakers,
} from './groupChat';
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine';
import RichHtmlMessage from './RichHtmlMessage';
import { containsHtml, messageCopyText } from './plainText';
import { shouldRenderRichHtml, stripMarkdownFences } from './richHtml';
import ScrollScrubber from './ScrollScrubber';
import { maskSecrets } from './secrets';
import { hideVariantStatusBar, toSpeechText } from './speechText';
import {
  createGroupSession,
  getApiConfigs,
  getChatOptions,
  getEnabledGlobalPresetPrompts,
  getEnabledPlugins,
  getImageGenSettings,
  getInlineImageSettings,
  getMemorySummarySettings,
  getMessagesBySessionStatus,
  getSessionSummaries,
  getStickers,
  getThinkingSettings,
  getUserProfile,
  saveApiConfigs,
  saveMessagesBySession,
  saveThinkingSettings,
  resetSessionSummaries,
  setProtectedChatImageUris,
  getTtsSettings,
  getMomentsSettings,
  getAffinityStatus,
  saveAffinity,
  updateMoments,
  saveSticker,
  saveTtsSettings,
  setSessionGreetingSelected,
  setSessionSummarizedUpTo,
  startNewSession,
  THINKING_DISPLAYS,
  THINKING_LEVELS,
  updateSessionMemberProfiles,
  getVectorMemoryConfig,
  getVectorIndex,
  removeVectorIndexForMessage,
  removeVectorIndexForMessages,
  removeVectorIndexForSession,
  updateVectorIndex,
} from './storage';

import { runPlugins } from './plugins/registry';
import {
  buildMemoryContext,
  indexMessages,
  retrieve,
} from './vectorMemory';
import { getVectorOwnerId, shouldIndexSession } from './vectorMemory/scope';
import { useTheme } from './theme/ThemeContext';
import { hexToRgba } from './theme/themes';
import { generateImage } from './imageGen';
import { getImageProvider } from './imageGen/providers';
import { speak as ttsSpeak, stop as ttsStop } from './tts';
import { getTtsProvider } from './tts/providers';
import { evaluateTurn, clampAffinity } from './moments/affinity';
import { shouldTrigger, buildMomentText, appendMoment } from './moments/moments';

const USER_ID = 'user';
const ASSISTANT_ID = 'assistant';
const SYSTEM_ERROR_ID = 'system-error';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const THINKING_PLACEHOLDER = '正在思考...';
const NEAR_BOTTOM_THRESHOLD = 80;
const AI_DISCLAIMER_TEXT = 'AI 生成可能有误，仅供参考';
const QUOTE_TEXT_MAX = 200;
const INLINE_IMAGE_PROMPT_MAX = 400;

function buildInlineImagePrompt(text, stylePrefix, maxChars) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : INLINE_IMAGE_PROMPT_MAX;
  const clipped = source.length > limit ? source.slice(0, limit) : source;
  const prefix = String(stylePrefix || '').trim();
  if (!clipped) return prefix;
  return prefix ? `${prefix}, ${clipped}` : clipped;
}

function buildQuotePayload(message, name) {
  if (!message || !message.id) return null;
  const raw = String(message.text || '').trim();
  const text = raw.length > QUOTE_TEXT_MAX ? `${raw.slice(0, QUOTE_TEXT_MAX)}…` : raw;
  if (!text) return null;
  return {
    id: message.id,
    name: String(name || '').trim(),
    role: message.role,
    text,
  };
}

const THINKING_LEVEL_LABELS = { low: '低', medium: '中', high: '高' };
const THINKING_DISPLAY_LABELS = { open: '开启', fold: '折叠', off: '关闭' };

const createMarkdownStyles = (theme, fonts, tokens) => ({
  body: { color: theme.colors.bubbleAssistantText, fontSize: fonts.scaled(15), lineHeight: fonts.scaled(22) },
  heading1: { color: theme.colors.bubbleAssistantText },
  heading2: { color: theme.colors.bubbleAssistantText },
  heading3: { color: theme.colors.bubbleAssistantText },
  heading4: { color: theme.colors.bubbleAssistantText },
  heading5: { color: theme.colors.bubbleAssistantText },
  heading6: { color: theme.colors.bubbleAssistantText },
  hr: { backgroundColor: theme.colors.surfaceBorder },
  blockquote: { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.primary },
  code_inline: {
    color: '#c7254e',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 0,
    borderRadius: tokens.radius.xs,
    paddingHorizontal: tokens.spacing.xs + 1,
    paddingVertical: tokens.spacing.xs / 4,
    fontFamily: MONO_FONT,
  },
  code_block: {
    color: theme.colors.bubbleAssistantText,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 0,
    borderRadius: tokens.radius.sm,
    padding: tokens.spacing.sm + 2,
    fontFamily: MONO_FONT,
  },
  fence: {
    color: theme.colors.bubbleAssistantText,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 0,
    borderRadius: tokens.radius.sm,
    padding: tokens.spacing.sm + 2,
    fontFamily: MONO_FONT,
  },
  link: { color: theme.colors.primary },
  bullet_list_icon: { color: theme.colors.bubbleAssistantText },
  ordered_list_icon: { color: theme.colors.bubbleAssistantText },
  bullet_list_content: { flex: 1, color: theme.colors.bubbleAssistantText },
  ordered_list_content: { flex: 1, color: theme.colors.bubbleAssistantText },
});

const STYLE_BLOCK_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const BUTTON_BLOCK_PATTERN = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
const ONCLICK_ATTRIBUTE_PATTERN = /onclick\s*=\s*("[^"]*"|'[^']*')/i;
const SLASH_SEND_PATTERN = /\/send\s+([^'"]+)/i;
const GRADIENT_DECLARATION_PATTERN = /(?:background(?:-image)?)\s*:\s*(?:repeating-)?(?:linear|radial)-gradient\(((?:[^()]|\([^()]*\))*)\)/gi;
const GRADIENT_COLOR_STOP_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/;

const createHtmlBaseStyle = (theme, fonts) => ({
  color: theme.colors.bubbleAssistantText,
  fontSize: fonts.scaled(15),
  lineHeight: fonts.scaled(22),
});

const createHtmlTagsStyles = (theme, fonts) => ({
  a: { color: theme.colors.primary },
  code: { fontFamily: MONO_FONT, color: '#c7254e', backgroundColor: theme.colors.surfaceAlt },
  pre: { fontFamily: MONO_FONT, color: theme.colors.bubbleAssistantText, backgroundColor: theme.colors.surfaceAlt },
  q: { color: theme.colors.bubbleAssistantText },
  h4: { color: theme.colors.bubbleAssistantText, fontSize: fonts.scaled(13), marginTop: 0, marginBottom: 6 },
});

const PANEL_CLASS_STYLES = {
  'ml-open-panel':
    'margin-top:14px;padding:14px;border-radius:10px;background-color:#eef5f3;border-width:1px;border-color:#cfd8dc',
  'ml-open-head': 'margin-bottom:8px',
  'ml-open-grid': '',
  'ml-open-group':
    'margin-top:8px;padding:10px;border-radius:9px;background-color:#ffffff;border-width:1px;border-color:#dde5e8',
};

const regexClassesStyles = {
  'ml-course-ui': { marginTop: 18, marginBottom: 10, borderWidth: 1, borderColor: 'rgba(52,79,93,0.22)', borderRadius: 8, backgroundColor: '#fbfcfd', overflow: 'hidden', color: '#24343d' },
  'ml-course-head': { paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#344f5d', color: '#fff' },
  'ml-course-title': { fontWeight: '700', color: '#fff' },
  'ml-course-day': { fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.16)' },
  'ml-course-list': { paddingVertical: 4 },
  'ml-course-row': { paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: 'rgba(55,78,91,0.12)', fontSize: 13, lineHeight: 18 },
  'ml-course-number': { fontStyle: 'normal', fontWeight: '700', color: '#344f5d', backgroundColor: '#dbe8ec', marginBottom: 4 },
  'ml-course-time': { color: '#48636f', fontSize: 12, marginBottom: 4 },
  'ml-course-subject': { color: '#24343d', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  'ml-course-detail': { color: '#60737b', fontSize: 13 },
  'ml-course-empty': { paddingVertical: 14, paddingHorizontal: 16, color: '#60737b', fontSize: 13, lineHeight: 21 },
  'ml-prose-safe': { marginTop: 12, paddingVertical: 17, paddingHorizontal: 15, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(65,88,96,0.18)', backgroundColor: '#fbfcfb', color: '#26343a', fontSize: 14.5, lineHeight: 27, whiteSpace: 'pre' },
  'ml-quote': { color: '#8b4052', fontWeight: '600' },
  'ml-strong': { color: '#243139', fontWeight: '800', backgroundColor: 'rgba(159,63,85,0.22)' },
};

const regexDomVisitors = {
  onElement(element) {
    const parentClasses = (element.parent?.attribs?.class || '').split(/\s+/);
    const rowClass = { em: 'ml-course-number', time: 'ml-course-time', strong: 'ml-course-subject', span: 'ml-course-detail' };
    const headClass = { span: 'ml-course-title', b: 'ml-course-day' };
    const className = parentClasses.includes('ml-course-row')
      ? rowClass[element.name]
      : parentClasses.includes('ml-course-head') ? headClass[element.name] : null;
    if (!className) return;
    element.attribs.class = `${element.attribs.class || ''} ${className}`.trim();
    if (parentClasses.includes('ml-course-row')) element.name = 'div';
  },
};



const customHTMLElementModels = {
  time: HTMLElementModel.fromCustomModel({ tagName: 'time', contentModel: HTMLContentModel.textual }),
  button: HTMLElementModel.fromCustomModel({
    tagName: 'button',
    contentModel: HTMLContentModel.block,
  }),
};

function extractSendCommand(onclick) {
  const match = String(onclick || '').match(SLASH_SEND_PATTERN);
  return match ? match[1].trim() : '';
}

function collectTNodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data || '';
  if (Array.isArray(node.children)) return node.children.map(collectTNodeText).join('');
  return '';
}

function solidColorFromGradient(stops) {
  const match = String(stops || '').match(GRADIENT_COLOR_STOP_PATTERN);
  return match ? match[0] : '';
}

function replaceGradientBackgrounds(html) {
  return String(html || '').replace(GRADIENT_DECLARATION_PATTERN, (full, stops) => {
    const color = solidColorFromGradient(stops);
    return color ? `background-color: ${color}` : 'background-color: transparent';
  });
}

function prepareAssistantHtml(raw) {
  let html = stripMarkdownFences(raw).replace(STYLE_BLOCK_PATTERN, '');
  html = replaceGradientBackgrounds(html);
  html = html.replace(/class="(ml-open-[a-z]+)"/g, (full, cls) => {
    const inline = PANEL_CLASS_STYLES[cls];
    return inline ? `style="${inline}"` : full;
  });
  if (!/<button\b/i.test(html)) return html;
  return html.replace(BUTTON_BLOCK_PATTERN, (full, attrs, label) => {
    const onclickMatch = attrs.match(ONCLICK_ATTRIBUTE_PATTERN);
    const onclick = onclickMatch ? onclickMatch[1].slice(1, -1) : '';
    const command = extractSendCommand(onclick);
    const dataCommand = command ? encodeURIComponent(command) : '';
    const cleanAttrs = attrs.replace(ONCLICK_ATTRIBUTE_PATTERN, '').trim();
    const attrPrefix = cleanAttrs ? ` ${cleanAttrs}` : '';
    return `<button${attrPrefix} data-command="${dataCommand}">${label}</button>`;
  });
}

function getHttpStatus(error) {
  return error?.status || error?.statusCode || error?.response?.status || null;
}

function buildErrorRawText(error) {
  const message = error?.message || '请检查 API 配置或网络连接。';
  const status = getHttpStatus(error);
  const stack = error?.stack || '';
  const lines = [message];
  if (status) {
    lines.push(`HTTP 状态码: ${status}`);
  }
  if (stack) {
    lines.push(stack);
  }
  return lines.join('\n');
}

function buildGreetingMessage(sessionId, firstMes, userName) {
  const text = String(firstMes || '').trim();
  if (!text) return null;
  const replaced = userName ? text.replace(/\{\{user\}\}/g, userName) : text;
  return {
    id: `greeting-${sessionId}`,
    role: ASSISTANT_ID,
    text: replaced,
    timestamp: Date.now(),
    kind: 'greeting',
    greetingTemplate: text,
  };
}

function formatScrubberTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 停止/失败时，若只生成了思考内容而没有正文，用这段文案替代占位符，
// 避免把“正在思考...”当作最终回复存下来。
const NO_BODY_TEXT = '（未生成正文）';

// 把一条 pending 占位消息“结算”：有内容（正文或思考）就保留并落盘，
// 只有占位符则整条移除。单聊、群聊-逐角色、群聊-合议三条路径的停止/失败
// 处理统一走这里，避免出现“生成的部分整条消失”或“永远停在正在思考”的僵尸气泡。
function settlePendingMessage(list, id) {
  const source = Array.isArray(list) ? list : [];
  return source.reduce((acc, item) => {
    if (!item || item.id !== id) {
      acc.push(item);
      return acc;
    }
    const text = typeof item.text === 'string' ? item.text : '';
    const reasoning = typeof item.reasoning === 'string' ? item.reasoning : '';
    const hasBody = text.trim().length > 0 && text !== THINKING_PLACEHOLDER;
    if (!hasBody && reasoning.trim().length === 0) return acc;
    acc.push({
      ...item,
      pending: false,
      waitingForResponse: false,
      text: hasBody ? text : NO_BODY_TEXT,
    });
    return acc;
  }, []);
}

// 消息时间：优先用显式 timestamp 字段；旧消息没有该字段，
// 退化为从 id 前缀解析（历史行为），都对不上则返回 0。
function messageTimestamp(message) {
  const explicit = Number(message && message.timestamp);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromId = Number(String((message && message.id) || '').split('-')[0]);
  return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
}

function ThinkingIndicator() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const progress = useRef(null);
  if (progress.current === null) progress.current = new Animated.Value(0);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(progress.current, {
        toValue: 1,
        duration: 1200,
        useNativeDriver: true,
        isInteraction: false,
      })
    );
    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <View style={styles.thinkingIndicator} accessible accessibilityLabel="正在思考" accessibilityRole="text">
      <Text style={styles.thinkingText}>正在思考</Text>
      {[0, 1, 2].map(index => (
        <Animated.View
          key={index}
          style={[
            styles.thinkingDot,
            {
              opacity: progress.current.interpolate({
                inputRange: [0, 0.15 + index * 0.2, 0.35 + index * 0.2, 1],
                outputRange: [0.25, 1, 0.25, 0.25],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

function renderHighlightedText(text, keyword, styles) {
  const source = String(text || '');
  const needle = String(keyword || '');
  if (!needle) return source;
  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts = [];
  let index = 0;
  let count = 0;
  while (index < source.length) {
    const found = lowerSource.indexOf(lowerNeedle, index);
    if (found < 0) {
      parts.push(source.slice(index));
      break;
    }
    if (found > index) parts.push(source.slice(index, found));
    parts.push(
      <Text key={`hl-${count}`} style={styles.highlightText}>
        {source.slice(found, found + needle.length)}
      </Text>
    );
    count += 1;
    index = found + needle.length;
  }
  return parts;
}

const MessageBubble = React.memo(function MessageBubble({ message, rawText, characterName, characterAvatar, userAvatarUri, onSlashCommand, canRegenerate, onRegenerate, onEditUserMessage, onSelectText, onQuote, onPressQuote, onGenerateImage, onBroadcast, highlightKeyword, isMatch, isActiveMatch, fullWidth, thinkingDisplay, overlayActions, richHtmlEnabled, onReselectGreeting, selectionMode, selected }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
   const markdownStyles = useMemo(() => createMarkdownStyles(theme, fonts, tokens), [theme, fonts, tokens]);
   const markdownRules = useMemo(() => {
     const codeRule = (node, children, parent, ruleStyles, inheritedStyles, styleKey) => {
       let content = typeof node.content === 'string' ? node.content : '';
       if (content.endsWith('\n')) content = content.slice(0, -1);
       return (
         <ScrollView
           key={node.key}
           horizontal
           showsHorizontalScrollIndicator={false}
           style={styles.markdownCodeScroll}
         >
           <Text style={[inheritedStyles, ruleStyles[styleKey]]}>{content}</Text>
         </ScrollView>
       );
     };
     return {
       code_block: (node, children, parent, ruleStyles, inheritedStyles) => (
         codeRule(node, children, parent, ruleStyles, inheritedStyles, 'code_block')
       ),
       fence: (node, children, parent, ruleStyles, inheritedStyles) => (
         codeRule(node, children, parent, ruleStyles, inheritedStyles, 'fence')
       ),
       table: (node, children, parent, ruleStyles) => (
         <ScrollView
           key={node.key}
           horizontal
           showsHorizontalScrollIndicator={false}
           style={styles.markdownTableScroll}
         >
           <View style={ruleStyles._VIEW_SAFE_table}>{children}</View>
         </ScrollView>
       ),
     };
   }, [styles.markdownCodeScroll, styles.markdownTableScroll]);
   const htmlBaseStyle = useMemo(() => createHtmlBaseStyle(theme, fonts), [theme, fonts]);
  const htmlTagsStyles = useMemo(() => createHtmlTagsStyles(theme, fonts), [theme, fonts]);
  const isUser = message.role === USER_ID;
  const isGreeting = !isUser && (message.kind === 'greeting' || String(message.id || '').startsWith('greeting-'));
  const { width } = useWindowDimensions();
  const [copied, setCopied] = useState(false);
  const [reasoningPinned, setReasoningPinned] = useState(false);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const renderHtml =
    !isUser && !message.pending && containsHtml(message.text);
  // 含 <style>/<script> 的助手消息用 WebView 渲染，才能还原样式与交互。
  const renderRichHtml =
    renderHtml && shouldRenderRichHtml(message.text, richHtmlEnabled);
   const plainText = messageCopyText(message.text);
   const availableMediaWidth = Math.max(96, Math.min(220, width - 80));
   const mediaWidth = message.image?.stickerId
     ? Math.min(112, availableMediaWidth)
     : availableMediaWidth;
  const mediaRatio = Number(message.image?.height) > 0 && Number(message.image?.width) > 0
    ? Number(message.image.height) / Number(message.image.width)
    : 0.75;
  const mediaHeight = message.image?.stickerId
    ? 112
    : Math.min(300, Math.max(120, Math.round(mediaWidth * mediaRatio)));
  const onCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {}
  }, [plainText]);
  const contentWidth = fullWidth
    ? Math.max(200, width - 28)
    : Math.max(200, Math.floor((width - 28) * 0.88) - 28);
  const htmlSource = useMemo(
    () => ({ html: prepareAssistantHtml(message.text) }),
    [message.text]
  );
  const htmlRenderers = useMemo(
    () => ({
      button: ({ tnode }) => {
        const encoded = (tnode && tnode.attributes && tnode.attributes['data-command']) || '';
        let command = encoded;
        try {
          command = encoded ? decodeURIComponent(encoded) : '';
        } catch (error) {
          command = encoded;
        }
        const label = collectTNodeText(tnode).trim();
        const onPress = command && onSlashCommand ? () => onSlashCommand(command) : undefined;
        return (
          <Pressable
            onPress={onPress}
            style={({ pressed }) => [
              styles.panelButton,
              pressed && onPress ? styles.panelButtonPressed : null,
            ]}
          >
            <Text style={styles.panelButtonText}>{label}</Text>
          </Pressable>
        );
      },
    }),
    [onSlashCommand]
  );

   const fullWidthAssistant = !isUser && fullWidth;
   const avatarElement = isUser ? (
    <View style={styles.avatarContainerRight}>
      {userAvatarUri ? (
        <Image source={{ uri: userAvatarUri }} style={styles.avatarImage} />
      ) : (
        <View style={styles.avatarPlaceholderUser}>
          <Text style={styles.avatarPlaceholderText}>
            {'我'}
          </Text>
        </View>
      )}
    </View>
  ) : (
     <View style={[styles.avatarContainer, fullWidthAssistant && styles.avatarContainerFullWidth]}>
      {characterAvatar ? (
        <Image source={{ uri: characterAvatar }} style={styles.avatarImage} />
      ) : (
        <View style={styles.avatarPlaceholder}>
          <Text style={styles.avatarPlaceholderText}>
            {(characterName || '?').charAt(0)}
          </Text>
        </View>
      )}
    </View>
  );

   const assistantHeader = fullWidthAssistant ? (
     <View style={styles.fullWidthMessageHeader}>
       {avatarElement}
       <Text style={styles.fullWidthNameLabel}>{characterName || ''}</Text>
     </View>
   ) : null;

   return (
     <View style={[
       styles.messageRow,
       isUser ? styles.messageRowRight : styles.messageRowLeft,
       fullWidthAssistant ? styles.messageRowFullWidth : null,
     ]}>
       {!isUser && !fullWidthAssistant ? avatarElement : null}
       <View style={[
         styles.messageContent,
         fullWidthAssistant
           ? styles.messageContentFullWidthColumn
           : ((fullWidth || renderRichHtml) ? styles.messageContentFullWidth : null),
       ]}>
         {fullWidthAssistant
           ? assistantHeader
           : (!isUser ? <Text style={styles.nameLabel}>{characterName || ''}</Text> : null)}
         <View style={[
          styles.bubble,
          (fullWidth || renderRichHtml) ? styles.bubbleFullWidth : styles.bubbleBounded,
          isUser ? styles.userBubble : styles.assistantBubble,
          message.image ? styles.mediaBubble : null,
          isMatch ? styles.bubbleMatch : null,
          isActiveMatch ? styles.bubbleActiveMatch : null,
          selected ? styles.bubbleSelected : null,
        ]}>
          {message.quoted && message.quoted.text ? (
            <TouchableOpacity
              style={[styles.quoteBlock, isUser ? styles.quoteBlockUser : styles.quoteBlockAssistant]}
              onPress={() => onPressQuote?.(message.quoted)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`引用 ${message.quoted.name || ''}`}
            >
              <Text
                style={[styles.quoteName, isUser ? styles.quoteNameUser : styles.quoteNameAssistant]}
                numberOfLines={1}
              >
                {message.quoted.name || '原文'}
              </Text>
              <Text
                style={[styles.quoteText, isUser ? styles.quoteTextUser : styles.quoteTextAssistant]}
                numberOfLines={2}
              >
                {message.quoted.text}
              </Text>
            </TouchableOpacity>
          ) : null}
          {!isUser && thinkingDisplay !== 'off' && typeof message.reasoning === 'string' && message.reasoning.trim() ? (
            (() => {
              const thinking = !!message.pending && !!message.waitingForResponse;
              const expanded = reasoningPinned
                ? reasoningExpanded
                : (thinkingDisplay === 'open' && thinking);
              return (
                <TouchableOpacity
                  style={[styles.reasoningBox, !expanded && styles.reasoningBoxCollapsed]}
                  onPress={() => {
                    setReasoningExpanded(!expanded);
                    setReasoningPinned(true);
                  }}
                  activeOpacity={0.8}
                >
                  <View style={[styles.reasoningHeader, !expanded && styles.reasoningHeaderCollapsed]}>
                    <Ionicons name="bulb-outline" size={12} color={theme.colors.textFaint} />
                    <Text style={styles.reasoningLabel}>思考过程</Text>
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={12}
                      color={theme.colors.textFaint}
                    />
                  </View>
                  {expanded ? (
                    <Text style={styles.reasoningText} selectable>{message.reasoning}</Text>
                  ) : null}
                </TouchableOpacity>
              );
            })()
          ) : null}
          {isUser && message.image?.uri ? (
            <View style={styles.userMediaBox}>
              <View>
                <Image
                  source={{ uri: message.image.uri }}
                  style={[styles.userMessageImage, { width: mediaWidth, height: mediaHeight }]}
                  resizeMode="contain"
                />
              </View>
              {message.image.stickerName ? (
                <Text style={styles.userMediaName} numberOfLines={1}>{message.image.stickerName}</Text>
              ) : null}
            </View>
          ) : isUser ? (
            <Text style={styles.messageText}>
              {highlightKeyword ? renderHighlightedText(message.text, highlightKeyword, styles) : message.text}
            </Text>
          ) : message.pending && message.waitingForResponse ? (
            <ThinkingIndicator />
          ) : renderRichHtml ? (
             <RichHtmlMessage
               html={message.text}
               onCommand={(command, token) => onSlashCommand(command, token, message.id)}
               fullWidth={fullWidth}
             />
          ) : renderHtml ? (
            <RenderHtml
              contentWidth={contentWidth}
              source={htmlSource}
              baseStyle={htmlBaseStyle}
              tagsStyles={htmlTagsStyles}
              classesStyles={regexClassesStyles}
              domVisitors={regexDomVisitors}
              customHTMLElementModels={customHTMLElementModels}
              renderers={htmlRenderers}
              defaultTextProps={{ selectable: true }}
            />
          ) : (
             <Markdown style={markdownStyles} rules={markdownRules}>{message.text}</Markdown>
          )}
          {isGreeting && onReselectGreeting ? (
            <TouchableOpacity
              style={styles.greetingReselectButton}
              onPress={onReselectGreeting}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.greetingReselectText}>重选</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {!isUser && message.inlineImage ? (
           <View style={[styles.inlineImageWrap, fullWidth && styles.inlineImageFullWidth]}>
            {message.inlineImage.status === 'loading' ? (
              <View style={[styles.inlineImageBox, styles.inlineImageLoading]}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.inlineImageHint}>配图生成中...</Text>
              </View>
            ) : message.inlineImage.status === 'error' ? (
              <View style={[styles.inlineImageBox, styles.inlineImageError]}>
                <Text style={styles.inlineImageHint} numberOfLines={2}>
                  {message.inlineImage.message || '配图生成失败'}
                </Text>
                <TouchableOpacity
                  style={styles.inlineImageRetry}
                  onPress={() => onGenerateImage?.(message.id, message.text)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.inlineImageRetryText}>重试</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Image
                source={{ uri: message.inlineImage.url || `data:image/png;base64,${message.inlineImage.base64}` }}
                style={styles.inlineImage}
                resizeMode="cover"
              />
            )}
          </View>
        ) : null}
        {!message.pending && !selectionMode && !message.image ? (
          <View style={[styles.messageActions, isUser ? styles.messageActionsRight : styles.messageActionsLeft]}>
            <TouchableOpacity style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]} onPress={onCopy} activeOpacity={0.8}>
              <Text style={styles.messageActionText}>{copied ? '已复制' : '复制'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
              onPress={() => onQuote?.(message)}
              activeOpacity={0.8}
            >
              <Text style={styles.messageActionText}>引用</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
              onPress={() => onSelectText?.(plainText)}
              activeOpacity={0.8}
            >
              <Text style={styles.messageActionText}>选择文本</Text>
            </TouchableOpacity>
            {!isUser && onGenerateImage ? (
              <TouchableOpacity
                style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
                onPress={() => onGenerateImage(message.id, message.text)}
                activeOpacity={0.8}
              >
                <Text style={styles.messageActionText}>生成配图</Text>
              </TouchableOpacity>
            ) : null}
            {!isUser && onBroadcast ? (
              <TouchableOpacity
                style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
                onPress={() => onBroadcast(rawText != null ? rawText : message.text)}
                activeOpacity={0.8}
              >
                <Text style={styles.messageActionText}>播报</Text>
              </TouchableOpacity>
            ) : null}
            {isUser && onEditUserMessage ? (
              <TouchableOpacity
                style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
                onPress={() => onEditUserMessage(message.id)}
                activeOpacity={0.8}
              >
                <Text style={styles.messageActionText}>修改重发</Text>
              </TouchableOpacity>
            ) : canRegenerate ? (
              <TouchableOpacity
                style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
                onPress={() => onRegenerate?.(message.id)}
                activeOpacity={0.8}
              >
                <Text style={styles.messageActionText}>重新生成</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
      {isUser ? avatarElement : null}
    </View>
  );
});

function ErrorBubble({ message, rawError, onCopied, fullWidth, selectionMode, selected }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    const payload = maskSecrets(rawError || message.detail || message.text || '');
    try {
      await Clipboard.setStringAsync(payload);
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {}
  }, [message.detail, message.text, onCopied, rawError]);

  return (
     <View style={[
       styles.messageRow,
       fullWidth ? styles.messageRowFullWidth : styles.messageRowLeft,
     ]}>
      <View style={[
        styles.bubble,
         fullWidth ? styles.bubbleFullWidth : styles.bubbleBounded,
         fullWidth ? styles.errorBubbleFullWidth : styles.errorBubbleBounded,
        selected ? styles.bubbleSelected : null,
      ]}>
        <Text style={styles.errorBadge}>系统报错</Text>
        <TouchableOpacity onPress={() => setExpanded(current => !current)} activeOpacity={0.8}>
          <Text style={styles.errorSummary}>请求失败，点击查看详情</Text>
        </TouchableOpacity>
        {expanded ? (
          <Text style={styles.errorDetail} selectable>
            {maskSecrets(message.detail || message.text || '')}
          </Text>
        ) : null}
        {!selectionMode ? (
          <View style={styles.errorActions}>
            <TouchableOpacity style={styles.copyButton} onPress={onCopy}>
              <Text style={styles.copyButtonText}>{copied ? '已复制' : '复制报错'}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const scrollRef = useRef(null);
  const errorRawRef = useRef({});
  const lastSavedSnapshotRef = useRef(null);
  const saveFailedRef = useRef(false);
  const {
    character,
    characters,
    activeId,
    loaded,
    switchCharacter,
    activeSessionId,
    sessions,
    ensureCharacterSession,
    updateCharacter,
    refreshSessions,
    switchSession,
    pendingTarget,
    consumePendingTarget,
  } = useApp();
  const characterId = character.id || 'default';
  const activeCharacterIdRef = useRef(characterId);
  const activeSessionIdRef = useRef(activeSessionId);
  activeCharacterIdRef.current = characterId;
  activeSessionIdRef.current = activeSessionId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const memberProfilesRef = useRef({ sessionId: '', profiles: {} });
  const isGroup = activeSession?.type === 'group';
   const sessionOwnerMissing = !isGroup
     && !!activeSession
     && !characters.some(item => item.id === String(activeSession.characterId || ''));
   const sessionTransitionPending = !isGroup
     && !!activeSession
     && String(activeSession.characterId || '') !== String(characterId);
  const greetingCandidates = useMemo(
    () => listGreetingCandidates(character),
    [character.firstMes, character.alternateGreetings]
  );
  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(item => {
      map.set(item.id, item);
    });
    return map;
  }, [characters]);
  const groupCharacters = useMemo(() => {
    if (!activeSession || activeSession.type !== 'group') return [];
    return (activeSession.members || [])
      .map(id => characterMap.get(id))
      .filter(Boolean);
  }, [activeSession, characterMap]);
  const groupCharactersRef = useRef(groupCharacters);
  groupCharactersRef.current = groupCharacters;
  const groupSessions = useMemo(
    () => (Array.isArray(sessions) ? sessions : []).filter(item => item && item.type === 'group'),
    [sessions]
  );
  const groupSessionName = useCallback(session => {
    const map = characterMap;
    const memberNames = (session.members || [])
      .map(id => (map.get(id) || {}).name)
      .filter(Boolean);
    return String(session.name || '').trim() || memberNames.join('、') || '群聊';
  }, [characterMap]);
  const isGroupRef = useRef(isGroup);
  isGroupRef.current = isGroup;
  const summarizingRef = useRef(false);
  const autoSummaryAttemptRef = useRef({ sessionId: '', signature: '' });
  const messageOffsetsRef = useRef({});
  const atBottomRef = useRef(true);
   const abortRef = useRef(null);
   const sendLockRef = useRef(null);
   const sourceChangedRef = useRef(false);
   const sendOperationRef = useRef(0);
   const switchOperationRef = useRef(0);
   const openingRequestRef = useRef(0);
   const openingAbortControllerRef = useRef(null);
   const sessionVersionRef = useRef(0);
  const captureSessionGuard = useCallback(() => ({
    sessionId: activeSessionIdRef.current,
    characterId: activeCharacterIdRef.current,
    version: sessionVersionRef.current,
  }), []);
  const isSessionGuardCurrent = useCallback(guard => (
    !guard
    || (
      activeSessionIdRef.current === guard.sessionId
      && activeCharacterIdRef.current === guard.characterId
      && sessionVersionRef.current === guard.version
    )
  ), []);
  const [input, setInput] = useState('');
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const inputSelectionRef = useRef({ start: 0, end: 0 });
  const [inputFocused, setInputFocused] = useState(false);
   const [messages, setMessages] = useState([]);
   const messagesRef = useRef([]);
   messagesRef.current = messages;
   const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const selectedMessageIdSet = useMemo(
    () => new Set(selectedMessageIds),
    [selectedMessageIds]
  );
  const messageSelectionOpen = selectedMessageIds.length > 0;
  const [greetingReady, setGreetingReady] = useState(false);
   const [isSending, setIsSending] = useState(false);
   const [isSwitching, setIsSwitching] = useState(false);
   const [ready, setReady] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [characterEditOpen, setCharacterEditOpen] = useState(false);
  const [groupEditOpen, setGroupEditOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [userAvatar, setUserAvatar] = useState('');
  const userNameRef = useRef('');
  const [selectionText, setSelectionText] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [scrubberOpen, setScrubberOpen] = useState(false);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [apiConfigs, setApiConfigs] = useState([]);
  const [apiActiveId, setApiActiveId] = useState('');
  const [modelSourceId, setModelSourceId] = useState('');
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState('medium');
  const [thinkingSupported, setThinkingSupported] = useState(false);
  const [thinkingDisplay, setThinkingDisplay] = useState('fold');
   const [attachments, setAttachments] = useState([]);
   const attachmentsRef = useRef([]);
   attachmentsRef.current = attachments;
   const attachmentPickerLockRef = useRef(false);
   const [attachmentLoading, setAttachmentLoading] = useState(false);
   const pendingAttachmentUrisRef = useRef(new Set());
   const syncProtectedAttachmentUris = useCallback(() => {
     setProtectedChatImageUris([
       ...attachmentsRef.current
         .filter(item => item && item.kind === 'image')
         .map(item => item.uri),
       ...pendingAttachmentUrisRef.current,
     ]);
   }, []);
   useEffect(() => {
     syncProtectedAttachmentUris();
   }, [attachments, syncProtectedAttachmentUris]);
   useEffect(() => () => {
     setProtectedChatImageUris([]);
   }, []);
   const [stickerPanelOpen, setStickerPanelOpen] = useState(false);
  const [stickers, setStickers] = useState([]);
  const stickerLoadRef = useRef(0);
   const [stickerNamePrompt, setStickerNamePrompt] = useState(null);
   const [stickerNameDraft, setStickerNameDraft] = useState('');
   const [stickerSaving, setStickerSaving] = useState(false);
   const stickerSaveLockRef = useRef(false);
   const stickerPickerLockRef = useRef(false);
   const pendingStickerResultRef = useRef(null);
  const [chatOptions, setChatOptions] = useState({ streaming: true, fullWidth: false, richHtml: true });
  const [greetingPicker, setGreetingPicker] = useState(null);
  const [inlineImageSettings, setInlineImageSettings] = useState({
    enabled: false,
    providerId: '',
    stylePrefix: '',
    size: '832*1216',
    maxPromptChars: 400,
  });
   const inlineImageBusyRef = useRef(false);
   const inlineImageControllerRef = useRef(null);

  const [ttsSettings, setTtsSettings] = useState({ enabled: false, activeProvider: 'system', providers: {} });
  const [fullScreenOpen, setFullScreenOpen] = useState(false);
  const [fullScreenText, setFullScreenText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [focusedMessageId, setFocusedMessageId] = useState('');
   const [quoteTarget, setQuoteTarget] = useState(null);
   const navigation = useNavigation();

   const beginSendOperation = useCallback(() => {
     if (sendLockRef.current) return null;
     const controller = new AbortController();
     const token = { id: ++sendOperationRef.current, controller };
     sourceChangedRef.current = false;
     sendLockRef.current = token;
     abortRef.current = controller;
     setIsSending(true);
     return token;
   }, []);

   const endSendOperation = useCallback(token => {
     if (!token || sendLockRef.current !== token) return;
     if (abortRef.current === token.controller) abortRef.current = null;
     sendLockRef.current = null;
     setIsSending(false);
   }, []);

   const invalidateSessionOperations = useCallback(() => {
     sessionVersionRef.current += 1;
     openingRequestRef.current += 1;
     if (openingAbortControllerRef.current) {
       openingAbortControllerRef.current.abort();
       openingAbortControllerRef.current = null;
     }
     sendLockRef.current = null;
     if (abortRef.current) {
       abortRef.current.abort();
     }
     inlineImageControllerRef.current?.abort();

     setIsSending(false);
   }, []);

   const closeStickerNamePrompt = useCallback(() => {
     const source = stickerNamePrompt;
     setStickerNamePrompt(null);
     setStickerNameDraft('');
     if (source && source.uri) deleteTemporaryImage(source.uri);
   }, [stickerNamePrompt]);

   const onSwitch = useCallback(id => {
     if (isSwitching) return;
     setSwitcherOpen(false);
     if (id === activeCharacterIdRef.current && !isGroupRef.current) return;
       const previousCharacterId = activeCharacterIdRef.current;
       const previousSessionId = activeSessionIdRef.current;
     const draft = {
       input,
       fullScreenText,
       attachments: [...attachments],
       quoteTarget,
       stickerPanelOpen,
       stickerNamePrompt,
       stickerNameDraft,
     };
     const switchToken = ++switchOperationRef.current;
     setIsSwitching(true);
     invalidateSessionOperations();
     activeCharacterIdRef.current = id;
     setProtectedChatImageUris(draft.attachments
       .filter(item => item && item.kind === 'image')
       .map(item => item.uri));
     attachmentsRef.current = [];
     setQuoteTarget(null);
     setInput('');
     setFullScreenText('');
     setAttachments([]);
     setStickerPanelOpen(false);
     setStickerNamePrompt(null);
     setStickerNameDraft('');
     switchCharacter(id)
       .then(() => (
         switchOperationRef.current === switchToken
           ? ensureCharacterSession(id)
           : null
       ))
       .then(() => {
           if (switchOperationRef.current !== switchToken) return;
           draft.attachments.forEach(item => {
             if (item.kind === 'image') deleteLocalImage(item.uri);
           });
           if (draft.stickerNamePrompt && draft.stickerNamePrompt.uri) {
             deleteTemporaryImage(draft.stickerNamePrompt.uri);
           }
            setProtectedChatImageUris([]);
            setIsSwitching(false);
        })
         .catch(async () => {
           if (switchOperationRef.current !== switchToken) return;

           try {
             await switchCharacter(previousCharacterId);
             if (previousSessionId) await switchSession(previousSessionId);
           } catch (error) {}
          setIsSwitching(false);
          activeCharacterIdRef.current = previousCharacterId;
          activeSessionIdRef.current = previousSessionId;
          sessionVersionRef.current += 1;
          setInput(draft.input);
          setFullScreenText(draft.fullScreenText);
          setAttachments(draft.attachments);
          attachmentsRef.current = draft.attachments;
          setQuoteTarget(draft.quoteTarget);
          setStickerPanelOpen(draft.stickerPanelOpen);
          setStickerNamePrompt(draft.stickerNamePrompt);
          setStickerNameDraft(draft.stickerNameDraft);
          setProtectedChatImageUris(draft.attachments
            .filter(item => item && item.kind === 'image')
            .map(item => item.uri));
          Alert.alert('切换失败', '请检查存储空间或权限。');
        });
   }, [attachments, closeStickerNamePrompt, ensureCharacterSession, fullScreenText, input, invalidateSessionOperations, isSwitching, quoteTarget, stickerNameDraft, stickerNamePrompt, stickerPanelOpen, switchCharacter]);

   const onSwitchGroup = useCallback(id => {
    if (isSwitching) return;
    setSwitcherOpen(false);
     if (id === activeSessionIdRef.current) return;
     const previousSessionId = activeSessionIdRef.current;
     const draft = {
       input,
       fullScreenText,
       attachments: [...attachments],
       quoteTarget,
       stickerPanelOpen,
       stickerNamePrompt,
       stickerNameDraft,
     };
     const switchToken = ++switchOperationRef.current;
     setIsSwitching(true);
     invalidateSessionOperations();
     activeSessionIdRef.current = id;
     setProtectedChatImageUris(draft.attachments
       .filter(item => item && item.kind === 'image')
       .map(item => item.uri));
     attachmentsRef.current = [];
     setQuoteTarget(null);
     setInput('');
     setFullScreenText('');
     setAttachments([]);
     setStickerPanelOpen(false);
     setStickerNamePrompt(null);
     setStickerNameDraft('');
     switchSession(id)
       .then(() => {
           if (switchOperationRef.current !== switchToken) return;
           draft.attachments.forEach(item => {
             if (item.kind === 'image') deleteLocalImage(item.uri);
           });
           if (draft.stickerNamePrompt && draft.stickerNamePrompt.uri) {
             deleteTemporaryImage(draft.stickerNamePrompt.uri);
           }
            setProtectedChatImageUris([]);
            setIsSwitching(false);
        })
         .catch(async () => {
         if (switchOperationRef.current !== switchToken) return;

        try {
          await switchSession(previousSessionId);
        } catch (error) {}
        setIsSwitching(false);
        activeSessionIdRef.current = previousSessionId;
          sessionVersionRef.current += 1;
          setInput(draft.input);
          setFullScreenText(draft.fullScreenText);
          setAttachments(draft.attachments);
          attachmentsRef.current = draft.attachments;
          setQuoteTarget(draft.quoteTarget);
          setStickerPanelOpen(draft.stickerPanelOpen);
          setStickerNamePrompt(draft.stickerNamePrompt);
          setStickerNameDraft(draft.stickerNameDraft);
          setProtectedChatImageUris(draft.attachments
            .filter(item => item && item.kind === 'image')
            .map(item => item.uri));
          Alert.alert('切换失败', '请检查存储空间或权限。');
        });
   }, [attachments, closeStickerNamePrompt, fullScreenText, input, invalidateSessionOperations, isSwitching, quoteTarget, stickerNameDraft, stickerNamePrompt, stickerPanelOpen, switchSession]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd?.({ animated: true });
    });
  }, []);

  const autoScrollToBottom = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  const onMessagesScroll = useCallback(({ nativeEvent }) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    atBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
  }, []);

  const persistableMessages = useMemo(
    () => (messages || [])
      .filter(item => item && !item.pending)
      .map(item => {
        const hasWaiting = Object.prototype.hasOwnProperty.call(item, 'waitingForResponse');
        const inlineImage = item.inlineImage;
        const inlineImageSettled = inlineImage && inlineImage.status === 'done';
        if (!hasWaiting && (!inlineImage || inlineImageSettled)) return item;
        const next = { ...item };
        delete next.waitingForResponse;
        if (inlineImage && !inlineImageSettled) delete next.inlineImage;
        return next;
      }),
    [messages]
  );
  // 已提交（非 pending）消息：流式期间 pending 消息不参与落盘
  const committedMessages = useMemo(
    () => (messages || []).filter(item => item && !item.pending),
    [messages]
  );
  const committedRef = useRef({ list: [], snapshot: '[]' });
  const persistableSnapshot = useMemo(() => {
    // 只有“已提交消息”确实变化时才做整份 JSON.stringify：流式回复期间每个
    // token 都会更新 messages，但已提交部分没有变（元素仍是同一批对象引用），
    // 因此这里按引用比对即可跳过无意义的全量序列化，同时保留
    // “用户消息一发出就落盘”的原有行为。
    const previous = committedRef.current.list;
    const unchanged = previous.length === committedMessages.length
      && committedMessages.every((item, index) => item === previous[index]);
    if (unchanged) return committedRef.current.snapshot;
    const snapshot = JSON.stringify(persistableMessages);
    committedRef.current = { list: committedMessages, snapshot };
    return snapshot;
  }, [committedMessages, persistableMessages]);
  const rawTextById = useMemo(() => {
    const map = new Map();
    (Array.isArray(messages) ? messages : []).forEach(message => {
      if (message && message.id) map.set(message.id, String(message.text ?? ''));
    });
    return map;
  }, [messages]);
  const renderedMessages = useMemo(
    () => messages.map((message, index) => {
      if (!message) return message;
      if (message.pending) {
        if (message.role !== ASSISTANT_ID) return message;
        const text = hideVariantStatusBar(message.text);
        return text === message.text ? message : { ...message, text };
      }
      const depth = messages.length - 1 - index;
      if (message.role === ASSISTANT_ID) {
        const text = applyRegexScripts(
          hideVariantStatusBar(message.text),
          sessionOwnerMissing ? [] : character.regexScripts,
          REGEX_PLACEMENT.AI_OUTPUT,
          { mode: 'display', depth }
        );
        return text === message.text ? message : { ...message, text };
      }
      if (message.role === USER_ID) {
        const text = applyRegexScripts(
          message.text,
          sessionOwnerMissing ? [] : character.regexScripts,
          REGEX_PLACEMENT.USER_INPUT,
          { mode: 'display', depth }
        );
        return text === message.text ? message : { ...message, text };
      }
      return message;
    }),
    [messages, character.regexScripts, sessionOwnerMissing]
  );

  const regenerableIds = useMemo(() => {
    const ids = new Set();
    let hasUser = false;
    for (const item of messages) {
      if (!item) continue;
      if (item.role === USER_ID) {
        hasUser = true;
      } else if (item.role === ASSISTANT_ID && hasUser) {
        ids.add(item.id);
      }
    }
    return ids;
  }, [messages]);

  // 当前角色 id 变化时必须同步 ref。加载 effect 只依赖 [activeSessionId, loaded]，
  // 当角色变了而会话尚未切过去（例如 activeId 失效被解析回初始卡）时它不会触发，
  // ref 就会停留在旧角色，导致动态归属、迟到回复判定与实际界面角色不一致。
  useEffect(() => {
    activeCharacterIdRef.current = characterId;
  }, [characterId]);

  useEffect(() => {
    autoSummaryAttemptRef.current = { sessionId: '', signature: '' };
  }, [activeSessionId]);

  useEffect(() => {
    const available = new Set(
      (Array.isArray(messages) ? messages : [])
        .map(message => String(message && message.id || ''))
        .filter(Boolean)
    );
    setSelectedMessageIds(current => {
      const next = current.filter(id => available.has(id));
      return next.length === current.length ? current : next;
    });
  }, [messages]);

  useEffect(() => {
     if (!loaded) return;
      const draftAttachments = attachmentsRef.current;
      draftAttachments.forEach(item => {
        if (item.kind === 'image') deleteLocalImage(item.uri);
      });
      attachmentsRef.current = [];
      setProtectedChatImageUris([]);
      setInput('');
      setFullScreenText('');
      setQuoteTarget(null);
      setAttachments([]);
      setStickerPanelOpen(false);
      setStickerNamePrompt(current => {
        if (current && current.uri) deleteTemporaryImage(current.uri);
        return null;
      });
      setStickerNameDraft('');
      setIsSwitching(false);
      setSelectedMessageIds([]);
      activeCharacterIdRef.current = characterId;
      activeSessionIdRef.current = activeSessionId;
      sessionVersionRef.current += 1;
      openingRequestRef.current += 1;
      if (openingAbortControllerRef.current) {
        openingAbortControllerRef.current.abort();
        openingAbortControllerRef.current = null;
      }
      sendLockRef.current = null;
     let cancelled = false;
     if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setReady(false);
    setIsSending(false);
    errorRawRef.current = {};
    atBottomRef.current = true;
    if (!activeSessionId) {
      lastSavedSnapshotRef.current = '[]';
      setMessages([]);
      setGreetingReady(false);
      setReady(true);
      return () => {
        cancelled = true;
        sessionVersionRef.current += 1;
      };
    }
    const profilePromise = getUserProfile().then(profile => {
      if (cancelled) return;
      userNameRef.current = String(profile.userName || '').trim();
      setUserAvatar(profile.avatarUri || '');
    }).catch(() => {});
    getMessagesBySessionStatus(activeSessionId)
      .then(async result => {
        if (cancelled) return;
        await profilePromise;
        if (cancelled) return;
        // 损坏（读取失败）时不能当成空会话：明确提示记录仍在，且不做后续写盘。
        if (result && result.status === 'corrupt') {
          lastSavedSnapshotRef.current = '[]';
          setMessages([]);
          setGreetingReady(false);
          Alert.alert(
            '聊天记录读取失败',
            '本次没能读出该会话的消息（可能因数据过大）。系统已停止本次自动写回；继续发送会生成新记录，请先保留设备数据后再操作。'
          );
          return;
        }
        const initial = Array.isArray(result && result.messages) ? result.messages : [];
        if (initial.length === 0 && isGroupRef.current) {
          const members = groupCharactersRef.current;
          lastSavedSnapshotRef.current = '[]';
          setMessages([]);
          setGreetingReady(true);
           if (members.length > 0) {
             const openingSessionId = activeSessionId;
             const openingToken = openingRequestRef.current;
             const openingController = new AbortController();
             openingAbortControllerRef.current = openingController;
              (async () => {
               try {
                 const [profile, presets, apiState] = await Promise.all([
                   getUserProfile().catch(() => null),
                   getEnabledGlobalPresetPrompts().catch(() => []),
                   getApiConfigs().catch(() => ({ configs: [], activeId: '' })),
                 ]);
                 const currentConfig = (apiState.configs || []).find(
                   item => item.id === apiState.activeId
                 ) || (apiState.configs || [])[0];
                 const opening = await generateOpening({
                   characters: members,
                   userProfile: profile,
                   globalPresets: presets,
                     expectedConfigId: String(currentConfig && currentConfig.id || ''),
                     expectedConfigFingerprint: currentConfig ? getConfigFingerprint(currentConfig) : '',
                     signal: openingController.signal,
                 });
                  if (cancelled || !opening) return;
                  if (openingRequestRef.current !== openingToken) return;
                  if (activeSessionIdRef.current !== openingSessionId) return;
                setMessages(current => current.length === 0
                  ? [{
                      id: `${Date.now()}-opening`,
                      role: ASSISTANT_ID,
                      text: opening.opening,
                      speakerId: opening.speakerId,
                      speakerName: opening.speakerName,
                      timestamp: Date.now(),
                    }]
                  : current);
               } catch (error) {
               } finally {
                 if (openingAbortControllerRef.current === openingController) {
                   openingAbortControllerRef.current = null;
                 }
               }
             })();
          }
          return;
        }
        setGreetingReady(
          isGroupRef.current
          || initial.length > 0
          || sessionsRef.current.some(session => (
            session.id === activeSessionId && session.greetingSelected === true
          ))
        );
        lastSavedSnapshotRef.current = JSON.stringify(initial);
        setMessages(initial);
      })
      .catch(() => {
        if (cancelled) return;
        lastSavedSnapshotRef.current = '[]';
        setMessages([]);
        setGreetingReady(false);
        // 读取失败时以前是静默显示空对话，用户很容易误以为记录被清空了。
        // 明确告知：记录还在，只是这次没读出来；且不会覆盖原数据。
        Alert.alert(
          '聊天记录读取失败',
          '本次没能读出该会话的消息（可能因数据过大）。记录本身没有被删除，可稍后重试；继续发送可能覆盖原内容。'
        );
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      sessionVersionRef.current += 1;
    };
  }, [activeSessionId, loaded, sessionOwnerMissing]);

  // 角色与会话必须成对：导入/新建角色、或历史遗留的错配状态下，只要当前会话不属于当前角色，
  // 就切到该角色自己的会话。否则界面会继续显示上一个角色的对话，新消息还会写进那段会话。
  useEffect(() => {
    if (!loaded) return;
    if (isGroup) return;
    if (!activeSessionId || !activeSession) return;
    const sessionOwnerId = String(activeSession.characterId || '');
    if (!characters.some(item => item.id === sessionOwnerId)) return;
    if (sessionOwnerId === characterId) return;
    if (!characters.some(item => item.id === characterId)) return;
    ensureCharacterSession(characterId).catch(() => {});
  }, [activeSession, activeSessionId, characterId, characters, ensureCharacterSession, isGroup, loaded]);

  useEffect(() => {
    if (!sessionOwnerMissing) return;
    Alert.alert('角色资料缺失', '这段历史对话仍在，可以先查看；恢复角色资料后才能继续发送。');
  }, [sessionOwnerMissing]);

  useEffect(() => {
    if (!ready) return;
    if (!activeSessionId) return;
    if (persistableSnapshot === lastSavedSnapshotRef.current) return;
    lastSavedSnapshotRef.current = persistableSnapshot;
    const messagesToIndex = persistableMessages;
    // 会话条目若已从存储里缺失（历史版本的 startNewSession 会误删），
    // 把归属角色一并传下去，让本次写盘把会话行补回来；群聊没有单一归属角色，跳过。
     const ownerRow = sessionsRef.current.find(item => item.id === activeSessionId);
     const indexableSession = shouldIndexSession(ownerRow);
     const indexedCharacterId = getVectorOwnerId(ownerRow, character.id);

    const recoverOwnerId = isGroupRef.current
      ? ''
      : String((ownerRow && ownerRow.characterId) || character.id || '');
    const indexVersion = sessionVersionRef.current;
    const protectedImageUris = [
      ...attachmentsRef.current
        .filter(item => item && item.kind === 'image')
        .map(item => item.uri),
      ...pendingAttachmentUrisRef.current,
    ];
    saveMessagesBySession(activeSessionId, persistableMessages, recoverOwnerId, protectedImageUris)
      .then(savedMessages => {
        saveFailedRef.current = false;
        if (
          !Array.isArray(savedMessages)
          || savedMessages.length === 0
          || activeSessionIdRef.current !== activeSessionId
           || !indexableSession
           || !indexedCharacterId

        ) return;
        getVectorMemoryConfig()
          .then(config => {
            if (
              activeSessionIdRef.current !== activeSessionId
              || sessionVersionRef.current !== indexVersion
               || !indexableSession
             ) return null;

            return updateVectorIndex(indexedCharacterId, current => {
              if (
                activeSessionIdRef.current !== activeSessionId
                || sessionVersionRef.current !== indexVersion
                 || !indexableSession
               ) return undefined;

              return indexMessages({
                characterId: indexedCharacterId,
                messages: messagesToIndex,
                config,
                existing: current,
                sessionId: activeSessionId,
              });
            });
          })
          .catch(error => {
            if (__DEV__) console.warn('[vector] indexing failed', error);
          });
      }).catch(() => {
        if (!saveFailedRef.current) {
          saveFailedRef.current = true;
          Alert.alert('聊天记录保存失败', '请检查存储空间或权限。');
        }
      });
  }, [activeSessionId, persistableSnapshot, ready, character.id]);

  useEffect(() => () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const onStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const onClear = useCallback(() => {
    const clearCharacterId = activeCharacterIdRef.current;
    const clearOwnerId = getVectorOwnerId(activeSessionRef.current, clearCharacterId);
    const clearSessionId = activeSessionIdRef.current;
    const clearSessionVersion = sessionVersionRef.current;
    const canClear = () =>
      sessionVersionRef.current === clearSessionVersion
      && !isStaleReply(activeCharacterIdRef.current, clearCharacterId)
      && activeSessionIdRef.current === clearSessionId
      && !abortRef.current;
    Alert.alert('清空聊天', '确定清空当前会话的消息吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          if (!canClear()) return;
          sessionVersionRef.current += 1;
          errorRawRef.current = {};
          if (!isGroupRef.current) {
            setGreetingReady(false);
            setSessionGreetingSelected(clearSessionId, false)
              .then(() => refreshSessions())
              .catch(() => {});
          }
          if (clearOwnerId) {
            removeVectorIndexForSession(clearOwnerId, clearSessionId).catch(error => {
              if (__DEV__) console.warn('[vector] clear cleanup failed', error);
            });
          }
          setMessages([]);
        }
      }
    ]);
  }, [refreshSessions, removeVectorIndexForSession]);

  const openGreetingPicker = useCallback((purpose = 'new') => {
    const current = messages.find(item => isGreetingMessage(item, activeSessionIdRef.current));
    const template = String((current && (current.greetingTemplate || current.text)) || '');
    const foundIndex = greetingCandidates.findIndex(item => item.text === template);
    const initialSelectedIndex = current
      ? (foundIndex >= 0 ? foundIndex : (greetingCandidates.length > 0 ? 0 : -1))
      : (greetingCandidates.length > 0 ? 0 : -1);
    setGreetingPicker({
      purpose,
      candidates: greetingCandidates,
      initialSelectedIndex,
    });
  }, [greetingCandidates, messages]);

  const confirmGreeting = useCallback(async result => {
    const flow = greetingPicker;
    setGreetingPicker(null);
    if (!flow) return;
     const characterId = activeCharacterIdRef.current;
     const sessionId = activeSessionIdRef.current;
     const transitionToken = flow.purpose === 'new' ? ++switchOperationRef.current : 0;
     const transitionVersion = sessionVersionRef.current;
     if (flow.purpose === 'new') setIsSwitching(true);
     try {
      await updateCharacter({
        id: characterId,
        firstMes: result.firstMes,
        alternateGreetings: result.alternateGreetings,
       });
       if (activeCharacterIdRef.current !== characterId) return;
       if (
         flow.purpose === 'new'
         && (
           switchOperationRef.current !== transitionToken
           || sessionVersionRef.current !== transitionVersion
           || activeSessionIdRef.current !== sessionId
         )
       ) return;
       if (flow.purpose === 'new') {
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        setIsSending(false);
         const openingTemplate = String(result.firstMes || '');
         const openingText = openingTemplate.replace(/\{\{user\}\}/g, userNameRef.current || '用户');
         const created = await startNewSession(characterId, {
           text: openingText,
           template: openingTemplate,
         });
         if (
           switchOperationRef.current !== transitionToken
           || activeCharacterIdRef.current !== characterId
           || (
             activeSessionIdRef.current !== sessionId
             && activeSessionIdRef.current !== created.id
           )
         ) return;
         activeSessionIdRef.current = created.id;
         await refreshSessions();
         if (
           switchOperationRef.current !== transitionToken
           || activeCharacterIdRef.current !== characterId
           || activeSessionIdRef.current !== created.id
         ) return;
         errorRawRef.current = {};
        sessionVersionRef.current += 1;
        setMessages([]);
        setAttachments([]);
        setQuoteTarget(null);
        setSearchOpen(false);
        setSearchQuery('');
        setActiveMatchIndex(0);
        setFocusedMessageId('');
        setSelectionText('');
        setGreetingReady(true);
        return;
      }
       if (activeSessionIdRef.current !== sessionId) return;
       await setSessionGreetingSelected(sessionId, true);
       await refreshSessions();
       if (
         activeCharacterIdRef.current !== characterId
         || activeSessionIdRef.current !== sessionId
       ) return;
       const nextGreeting = buildGreetingMessage(sessionId, result.firstMes, userNameRef.current);
      const hasGreeting = messages.some(item => isGreetingMessage(item, sessionId));
      if (nextGreeting) {
        setMessages(current => hasGreeting
          ? current.map(item => (
            isGreetingMessage(item, sessionId)
              ? { ...item, ...nextGreeting, id: item.id, timestamp: item.timestamp }
              : item
          ))
          : [nextGreeting, ...current]);
      } else {
        setMessages(current => current.filter(item => !isGreetingMessage(item, sessionId)));
      }
      setGreetingReady(true);
     } catch (error) {
       if (
         flow.purpose === 'new'
         && (
           switchOperationRef.current !== transitionToken
           || activeCharacterIdRef.current !== characterId
           || (
             activeSessionIdRef.current !== sessionId
             && activeSessionIdRef.current !== ''
           )
         )
       ) return;
        Alert.alert('开场白保存失败', '请稍后重试。');
      } finally {
        if (
          flow.purpose === 'new'
          && switchOperationRef.current === transitionToken
        ) setIsSwitching(false);
      }
   }, [greetingPicker, messages, refreshSessions, updateCharacter]);

  const onNewChat = useCallback(() => {
    if (isSending || isSwitching || !ready || sessionTransitionPending || abortRef.current) return;
    if (sessionOwnerMissing) {
      Alert.alert('角色资料缺失', '这段历史对话可以继续查看，恢复角色资料后才能新建或发送消息。');
      return;
    }
    if (isGroupRef.current && groupCharactersRef.current.length > 0) {
      Alert.alert('新建对话', '将为当前群聊开启一段新对话，旧对话保留在「记忆」中。', [
        { text: '取消', style: 'cancel' },
        {
          text: '新建',
          onPress: async () => {
            const transitionToken = ++switchOperationRef.current;
            const previousCharacterId = activeCharacterIdRef.current;
            const previousSessionId = activeSessionIdRef.current;
            setIsSwitching(true);
            if (abortRef.current) {
              abortRef.current.abort();
              abortRef.current = null;
            }
            setIsSending(false);
             try {
               const current = sessionsRef.current.find(item => item.id === previousSessionId);
               const created = await createGroupSession(groupCharactersRef.current, (current && current.name) || '群聊');
               if (
                 switchOperationRef.current !== transitionToken
                 || activeCharacterIdRef.current !== previousCharacterId
                 || (
                   activeSessionIdRef.current !== previousSessionId
                   && activeSessionIdRef.current !== created.id
                 )
               ) return;
               activeSessionIdRef.current = created.id;
               await refreshSessions();
               if (
                 switchOperationRef.current !== transitionToken
                 || activeCharacterIdRef.current !== previousCharacterId
                 || activeSessionIdRef.current !== created.id
               ) return;
               errorRawRef.current = {};
              sessionVersionRef.current += 1;
              setMessages([]);
              setAttachments([]);
              setQuoteTarget(null);
              setSearchOpen(false);
              setSearchQuery('');
              setActiveMatchIndex(0);
              setFocusedMessageId('');
              setSelectionText('');
             } catch (error) {
               if (
                 switchOperationRef.current !== transitionToken
                 || activeCharacterIdRef.current !== previousCharacterId
                 || (
                   activeSessionIdRef.current !== previousSessionId
                   && activeSessionIdRef.current !== ''
                 )
               ) return;
                Alert.alert('新建对话失败', '请稍后重试。');
              } finally {
                if (switchOperationRef.current === transitionToken) setIsSwitching(false);
              }
          },
        },
      ]);
      return;
    }
    openGreetingPicker('new');
  }, [isSending, isSwitching, openGreetingPicker, ready, refreshSessions, sessionOwnerMissing, sessionTransitionPending]);

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return messages
      .filter(message => (
        message
        && (message.role === USER_ID || message.role === ASSISTANT_ID)
        && getMessagePromptText(message).toLowerCase().includes(query)
      ))
      .map(message => message.id);
  }, [messages, searchQuery]);

  const scrollToMessage = useCallback(id => {
    const attempt = tries => {
      const offset = messageOffsetsRef.current[id];
      if (typeof offset === 'number') {
        scrollRef.current?.scrollTo?.({ y: Math.max(0, offset - 80), animated: true });
      } else if (tries > 0) {
        setTimeout(() => attempt(tries - 1), 120);
      }
    };
    setTimeout(() => attempt(6), 60);
  }, []);

  const onMessageLayout = useCallback((id, event) => {
    messageOffsetsRef.current[id] = event.nativeEvent.layout.y;
  }, []);

  const goToMatch = useCallback(delta => {
    if (searchMatches.length === 0) return;
    const next = (activeMatchIndex + delta + searchMatches.length) % searchMatches.length;
    setActiveMatchIndex(next);
    setFocusedMessageId(searchMatches[next]);
    scrollToMessage(searchMatches[next]);
  }, [activeMatchIndex, searchMatches, scrollToMessage]);

  useEffect(() => {
    if (!searchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setActiveMatchIndex(0);
      setFocusedMessageId('');
      return;
    }
    setActiveMatchIndex(0);
    if (searchMatches.length > 0) {
      setFocusedMessageId(searchMatches[0]);
      scrollToMessage(searchMatches[0]);
    } else {
      setFocusedMessageId('');
    }
  }, [searchOpen, searchQuery, searchMatches, scrollToMessage]);

  useEffect(() => {
    if (!ready || !pendingTarget) return;
    if (pendingTarget.sessionId !== activeSessionId) return;
    const exists = messages.some(message => message.id === pendingTarget.messageId);
    consumePendingTarget();
    if (!exists) return;
    setFocusedMessageId(pendingTarget.messageId);
    scrollToMessage(pendingTarget.messageId);
  }, [ready, pendingTarget, activeSessionId, messages, consumePendingTarget, scrollToMessage]);

  useEffect(() => {
    if (!navigation) return undefined;
    const load = () => {
      getChatOptions()
        .then(options => setChatOptions(options))
        .catch(() => {});
      getThinkingSettings()
        .then(settings => setThinkingDisplay(settings.display))
        .catch(() => {});
      getInlineImageSettings()
        .then(settings => setInlineImageSettings(settings))
        .catch(() => {});
      getTtsSettings()
        .then(settings => setTtsSettings(settings))
        .catch(() => {});
      const stickerRequest = ++stickerLoadRef.current;
      getStickers()
        .then(list => {
          if (stickerRequest === stickerLoadRef.current) setStickers(list);
        })
        .catch(() => {});
    };
    load();
    const unsubscribe = navigation.addListener('focus', load);
    return unsubscribe;
  }, [navigation]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setActiveMatchIndex(0);
    setFocusedMessageId('');
  }, []);

  const scrubberMessages = useMemo(
    () => messages.filter(message => (
      message
      && !message.pending
      && (message.role === USER_ID || message.role === ASSISTANT_ID)
    )),
    [messages]
  );

  const scrubberPreviews = useMemo(
    () => scrubberMessages.map(message => {
      const timestamp = messageTimestamp(message);
      return {
        label: formatScrubberTime(timestamp),
        speaker: message.role === USER_ID ? '我' : (character.name || '角色'),
        text: getMessagePromptText(message).replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    }),
    [scrubberMessages, character.name]
  );

  const onScrubberSeek = useCallback(index => {
    const target = scrubberMessages[index];
    if (!target) return;
    const offset = messageOffsetsRef.current[target.id];
    if (typeof offset === 'number') {
      scrollRef.current?.scrollTo?.({ y: Math.max(0, offset - 80), animated: true });
    } else {
      scrollToMessage(target.id);
    }
  }, [scrubberMessages, scrollToMessage]);

  const onScrubberToStart = useCallback(() => {
    scrollRef.current?.scrollTo?.({ y: 0, animated: true });
  }, []);

  const onScrubberToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  const openModelPanel = useCallback(async () => {
    if (isSending || sendLockRef.current) return;
    try {
      const { configs: list, activeId: id } = await getApiConfigs();
      setApiConfigs(list);
      setApiActiveId(id);
      setModelSourceId(id);
      setModelPanelOpen(true);
    } catch (error) {
      Alert.alert('读取失败', '无法读取 API 配置。');
    }
  }, [isSending]);

  const applyModelSelection = useCallback(async (sourceId, model) => {
    if (isSending || sendLockRef.current) return;
    const list = apiConfigs.map(item => (
      item.id === sourceId ? { ...item, activeModel: model } : item
    ));
    try {
      const saved = await saveApiConfigs(list, sourceId);
      setApiConfigs(saved.configs);
      setApiActiveId(saved.activeId);
      setModelSourceId(sourceId);
      setModelPanelOpen(false);
    } catch (error) {
      Alert.alert('切换失败', '请检查存储空间或权限。');
    }
  }, [apiConfigs, isSending]);

  const openThinkingPanel = useCallback(async () => {
    try {
      const [settings, { configs, activeId }] = await Promise.all([
        getThinkingSettings(),
        getApiConfigs(),
      ]);
      const current = configs.find(item => item.id === activeId) || configs[0];
      setThinkingSupported(!!(current && current.supportsThinking));
      setThinkingEnabled(settings.enabled);
      setThinkingLevel(settings.level);
      setThinkingDisplay(settings.display);
      setThinkingOpen(true);
    } catch (error) {
      Alert.alert('读取失败', '无法读取思考设置。');
    }
  }, []);

  const applyThinking = useCallback(async patch => {
    try {
      const current = await getThinkingSettings();
      const saved = await saveThinkingSettings({ ...current, ...patch });
      setThinkingEnabled(saved.enabled);
      setThinkingLevel(saved.level);
      setThinkingDisplay(saved.display);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, []);

  const runSummarize = useCallback(async (session, list, manual) => {
    if (summarizingRef.current) return;
    const picked = manual
      ? selectManualSummarizable(list, session.summarizedUpTo)
      : selectSummarizable(list, session.summarizedUpTo);
    if (picked.length === 0) {
      if (manual) Alert.alert('无法总结', '当前没有新的可总结消息。');
      return;
    }
    summarizingRef.current = true;
    setSummarizing(true);
    try {
      const userProfile = await getUserProfile();
      const sessionCharacterId = String(session.characterId || character.id || '');
      const sessionCharacter = (Array.isArray(characters) ? characters : [])
        .find(item => item.id === sessionCharacterId) || character;
       const characterExists = (Array.isArray(characters) ? characters : [])
         .some(item => item.id === sessionCharacterId);
       const scoped = !characterExists
         || isSessionScopedMemory(sessionsRef.current, sessionCharacterId);
       let expectedConfigId = '';
       let expectedConfigFingerprint = '';
       try {
         const { configs, activeId } = await getApiConfigs();
         const current = configs.find(item => item.id === activeId) || configs[0];
         expectedConfigId = String(current?.id || '');
         expectedConfigFingerprint = current ? getConfigFingerprint(current) : '';
       } catch (error) {}
       const result = await applySummary({
        session,
        character: sessionCharacter,
        messages: picked,
        updateCharacter,
         userName: userProfile.userName,
         scoped,
         expectedConfigId,
         expectedConfigFingerprint,
       });
      await refreshSessions().catch(() => {});
      if (result.skipped) {
        if (manual) Alert.alert('总结完成', '本轮没有提取出可保存的新记忆。');
        return;
      }
      if (manual) {
        Alert.alert(
          '已完成',
          result.scoped
            ? '记忆已压缩为本会话上下文，不再写入世界书。'
            : '记忆总结已写入角色世界书。'
        );
      }
    } catch (error) {
      if (manual) {
        Alert.alert('记忆总结失败', '请稍后重试。');
      } else if (__DEV__) {
        console.warn('[memorySummary] automatic summary failed', error);
      }
    } finally {
      summarizingRef.current = false;
      setSummarizing(false);
    }
  }, [character, characters, updateCharacter, refreshSessions]);

  const maybeAutoSummarize = useCallback(async list => {
    if (summarizingRef.current) return;
    const session = sessionsRef.current.find(
      item => item.id === activeSessionIdRef.current
    );
    if (!session) return;
    let settings = null;
    try {
      settings = await getMemorySummarySettings();
    } catch (error) {
      return;
    }
    if (!shouldSummarize({ session, messages: list, settings })) return;
    const candidates = selectSummarizable(list, session.summarizedUpTo);
    const signature = `${session.id}:${settings.enabled}:${settings.threshold}:${candidates.map(item => item.id).join('|')}`;
    if (
      autoSummaryAttemptRef.current.sessionId === session.id
      && autoSummaryAttemptRef.current.signature === signature
    ) return;
    autoSummaryAttemptRef.current = { sessionId: session.id, signature };
    await runSummarize(session, list, false);
  }, [runSummarize]);

  const onSummarize = useCallback(() => {
    if (summarizingRef.current || isSending || !ready) return;
    if (isGroupRef.current) {
      Alert.alert('群聊暂不支持', '记忆总结仅适用于单聊会话。');
      return;
    }
    const session = sessionsRef.current.find(
      item => item.id === activeSessionIdRef.current
    );
    if (!session) {
      Alert.alert('无法总结', '当前没有可总结的会话。');
      return;
    }
    const picked = selectManualSummarizable(messages, session.summarizedUpTo);
    if (picked.length === 0) {
      Alert.alert('无法总结', '当前没有新的可总结消息。');
      return;
    }
    Alert.alert(
      '开始记忆总结？',
      `将总结当前会话的 ${picked.length} 条消息，本次操作不受自动开关和阈值限制。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始总结',
          onPress: () => runSummarize(session, messages, true),
        },
      ]
    );
  }, [isSending, ready, messages, runSummarize]);

  const requestReply = useCallback(async ({ historyMessages, userText, baseMessages, images, imageMessages, quote, expectedConfigId, expectedConfigFingerprint, sessionGuard, restoreOnFailure = false }) => {
     if (sessionGuard && !isSessionGuardCurrent(sessionGuard)) return false;
     if (!ready || (abortRef.current && abortRef.current.signal.aborted)) return false;
    const sendCharacterId = activeCharacterIdRef.current;
    const sendSessionId = activeSessionIdRef.current;
    const sendSessionVersion = sessionVersionRef.current;
    const senderSnapshot = {
      id: sendCharacterId,
      sessionId: sendSessionId,
      name: String(character.name || '').trim(),
      avatarUri: String(character.avatarUri || ''),
    };
    const isCurrentSession = () =>
      sessionVersionRef.current === sendSessionVersion
      && !isStaleReply(activeCharacterIdRef.current, sendCharacterId)
      && activeSessionIdRef.current === sendSessionId;
     const controller = sendLockRef.current?.controller || new AbortController();
     abortRef.current = controller;
     if (controller.signal.aborted) return false;
     const pendingAssistantMessage = {
      id: `${Date.now()}-assistant`,
      role: ASSISTANT_ID,
      text: THINKING_PLACEHOLDER,
      reasoning: '',
      pending: true,
      waitingForResponse: true,
      timestamp: Date.now(),
    };

     setMessages([...baseMessages, pendingAssistantMessage]);
     setIsSending(true);
     atBottomRef.current = true;
     scrollToBottom();

    try {
       const [userProfile, globalPresets, enabledPlugins] = await Promise.all([
         getUserProfile(),
         getEnabledGlobalPresetPrompts(),
         getEnabledPlugins(),
       ]);
       if (controller.signal.aborted) {
         setMessages(current => (
           isCurrentSession() ? settlePendingMessage(current, pendingAssistantMessage.id) : current
         ));
         return;
       }
       const pluginContext = await runPlugins({
        userText,
        plugins: enabledPlugins,
        sessionId: sendSessionId,
        onError: error => {
          if (__DEV__) console.warn('[webSearch] failed', error);
          // registry 内部已按会话去重，这里不会每条消息都弹
          Alert.alert('联网搜索失败', (error && error.message) || '请检查搜索服务配置。');
        },
      });
      const currentSession = sessionsRef.current.find(
        session => session.id === sendSessionId
      );
      const boundary = currentSession && currentSession.summarizedUpTo;
      const boundaryIndex = boundary
        ? historyMessages.findIndex(item => item.id === boundary)
        : -1;
      const trimmedHistory = boundaryIndex >= 0
        ? historyMessages.slice(boundaryIndex + 1)
        : historyMessages;
      let memorySnippets = '';
      try {
        const vectorConfig = await getVectorMemoryConfig();
        const vectorOwnerId = getVectorOwnerId(currentSession, character.id);
        const index = vectorOwnerId ? await getVectorIndex(vectorOwnerId) : [];
        if (index.length > 0 && String(userText || '').trim()) {
          const hits = await retrieve({
            config: vectorConfig,
            index,
            query: userText,
            topK: vectorConfig.topK,
          });
          memorySnippets = buildMemoryContext(hits);
        }
      } catch (error) {
        memorySnippets = '';
      }
      let summaryText = '';
      try {
        const sessionCharacterId = String(
          (currentSession && currentSession.characterId) || character.id || ''
        );
        const characterExists = (Array.isArray(characters) ? characters : [])
          .some(item => item.id === sessionCharacterId);
        const scoped = !characterExists
          || isSessionScopedMemory(sessionsRef.current, sessionCharacterId);
        const sessionSummaries = scoped
          ? await getSessionSummaries(sendSessionId)
          : [];
        summaryText = buildMemorySummaryText(character, sessionSummaries, scoped);
      } catch (error) {
        summaryText = '';
      }
       const requestMessages = buildRequestMessages({
         character,
         historyMessages: trimmedHistory,
         userText,
         userProfile,
         globalPresets,
         imageMessages,
         summaryText,
         memorySnippets,
         pluginContext,
         images,
         quote,
       });
       if (!isCurrentSession()) return;

       const reply = await sendChatMessage(
         requestMessages,
         {
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
           stream: chatOptions.stream,
           onChunk: fullText => {
             if (!isCurrentSession() || controller.signal.aborted) return;
             setMessages(current => {
               if (!isCurrentSession()) return current;
               return current.map(item =>
                 item.id === pendingAssistantMessage.id && item.pending
                   ? { ...item, text: fullText, waitingForResponse: false }
                   : item
               );
             });
           },
           onReasoning: fullReasoning => {
             if (!isCurrentSession() || controller.signal.aborted) return;
             setMessages(current => {
               if (!isCurrentSession()) return current;
               return current.map(item =>
                 item.id === pendingAssistantMessage.id
                   ? { ...item, reasoning: fullReasoning }
                   : item
               );
             });
           }
         }
       );

       if (controller.signal.aborted) {
         setMessages(current => (
           isCurrentSession()
             ? settlePendingMessage(current, pendingAssistantMessage.id)
             : current
         ));
         return;
       }
       setMessages(current => {
        if (!isCurrentSession()) return current;
        return current.map(item =>
          item.id === pendingAssistantMessage.id
            ? { ...item, text: reply || '没有收到回复。', pending: false, waitingForResponse: false }
            : item
        );
      });
      if (isCurrentSession()) {
        maybeAutoSummarize([
          ...baseMessages,
          {
            ...pendingAssistantMessage,
            text: reply || '没有收到回复。',
            pending: false,
            waitingForResponse: false,
          },
        ]);
        if (inlineImageEnabledRef.current) {
          generateInlineImageRef.current?.(pendingAssistantMessage.id, reply || '');
        }
        broadcastMessage(reply || '');
        recordTurnRef.current?.(userText, reply || '', senderSnapshot);
      }
     } catch (error) {
       if (isConfigChangedError(error)) {
         sourceChangedRef.current = true;
         setMessages(current => (
           isCurrentSession()
             ? current.filter(item => item.id !== pendingAssistantMessage.id)
             : current
         ));
         return false;
       }
       if (isCanceledError(error)) {
        // 停止：已有内容（含只生成了思考）就保留并落盘，只有占位符才整条移除
         setMessages(current => (
           isCurrentSession()
             ? settlePendingMessage(current, pendingAssistantMessage.id)
             : current
         ));
         return false;
       }
       const rawText = buildErrorRawText(error);
      const errorMessage = {
        id: `${pendingAssistantMessage.id}-error`,
        role: SYSTEM_ERROR_ID,
        text: '请求失败，点击查看详情',
        detail: maskSecrets(rawText),
        timestamp: Date.now(),
      };
      if (isCurrentSession()) {
        errorRawRef.current[errorMessage.id] = rawText;
      }
      setMessages(current => {
        if (!isCurrentSession()) return current;
        const settled = settlePendingMessage(current, pendingAssistantMessage.id);
        const keptPartial = settled.some(item => item && item.id === pendingAssistantMessage.id);
        if (keptPartial) return settled.concat(errorMessage);
        return current.map(item => (
          item.id === pendingAssistantMessage.id ? errorMessage : item
        ));
       });
       if (restoreOnFailure) return false;
     } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (isCurrentSession()) {
          setIsSending(false);
          autoScrollToBottom();
        }
      }
    }
  }, [autoScrollToBottom, character, characters, chatOptions.stream, isSessionGuardCurrent, maybeAutoSummarize, ready, scrollToBottom]);

  const requestGroupReply = useCallback(async ({ historyMessages, userText, baseMessages, imageMessages, quote, expectedConfigId, expectedConfigFingerprint, sessionGuard }) => {
     if (sessionGuard && !isSessionGuardCurrent(sessionGuard)) return false;
     if (!ready || (abortRef.current && abortRef.current.signal.aborted)) return false;
    const members = groupCharactersRef.current;
    if (members.length === 0) {
      // 输入框在 onSend 里已清空，这里必须给个提示，不能让用户以为发出去又什么都没发生。
      Alert.alert('无法发送', '这个群聊没有可用的角色（成员可能已被删除）。');
      return false;
    }
    const sendSessionId = activeSessionIdRef.current;
    const sendSessionVersion = sessionVersionRef.current;
    const sendCharacterId = activeCharacterIdRef.current;
    const isCurrent = () =>
      sessionVersionRef.current === sendSessionVersion
      && activeSessionIdRef.current === sendSessionId
      && !isStaleReply(activeCharacterIdRef.current, sendCharacterId);

     const controller = sendLockRef.current?.controller || new AbortController();
     abortRef.current = controller;
     if (controller.signal.aborted) return false;
     setIsSending(true);
     atBottomRef.current = true;
     setMessages(baseMessages);
     scrollToBottom();

    try {
       const [userProfile, globalPresets] = await Promise.all([
         getUserProfile(),
         getEnabledGlobalPresetPrompts(),
       ]);
       if (!isCurrent() || controller.signal.aborted) return false;
      const groupSessionId = String(activeSessionRef.current?.id || '');
      const cachedProfiles = memberProfilesRef.current.sessionId === groupSessionId
        ? memberProfilesRef.current.profiles
        : (activeSessionRef.current?.memberProfiles || {});
      let memberProfiles = cachedProfiles;
      try {
         const ensured = await ensureMemberProfiles({
           characters: members,
            profiles: cachedProfiles,
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
          });
        const added = Object.keys(ensured).some(key => !cachedProfiles[key]);
        if (!isCurrent()) return false;
        memberProfiles = ensured;
        memberProfilesRef.current = { sessionId: groupSessionId, profiles: ensured };
         if (added && groupSessionId) {
           await updateSessionMemberProfiles(groupSessionId, ensured);
         }
       } catch (error) {
         if (isConfigChangedError(error)) throw error;
       }
       if (!isCurrent()) return false;
       const everyone = hasEveryoneMention(userText);
      const mentions = parseMentions(userText, members);
      const mediaPrompt = (Array.isArray(imageMessages) ? imageMessages : [])
        .map(getMessagePromptText)
        .filter(Boolean)
        .join('\n');
      const schedulerText = [userText, mediaPrompt].filter(Boolean).join('\n');
      const currentTurnIds = new Set(
        (Array.isArray(baseMessages) ? baseMessages.slice(historyMessages.length) : [])
          .map(item => item && item.id)
          .filter(Boolean)
      );
      let working = baseMessages;

      const runTurnSpeakers = async () => {
        const speakerIds = await selectSpeakers({
          characters: members,
          history: historyMessages,
          userText: schedulerText,
            expectedConfigId,
            expectedConfigFingerprint,
            mentions,
           everyone,
           signal: controller.signal,
         });
         for (const speakerId of speakerIds) {
           if (!isCurrent() || controller.signal.aborted) return false;
          const speaker = members.find(item => item.id === speakerId);
          if (!speaker) continue;
          const pendingMessage = {
            id: `${Date.now()}-${speakerId}-assistant`,
            role: ASSISTANT_ID,
            text: THINKING_PLACEHOLDER,
            pending: true,
            waitingForResponse: true,
            speakerId,
            speakerName: speaker.name,
            timestamp: Date.now(),
          };
          const roundHistory = working.filter(item => (
            item
            && !item.pending
            && (item.role === USER_ID || item.role === ASSISTANT_ID)
            && !currentTurnIds.has(item.id)
          ));
           working = [...working, pendingMessage];
           if (!isCurrent()) return false;
          setMessages(working);
          scrollToBottom();
          try {
            const requestMessages = buildGroupRequest({
              speaker,
              characters: members,
              historyMessages: roundHistory,
              userText,
              userProfile,
              globalPresets,
              quote,
              profiles: memberProfiles,
              imageMessages,
            });
            const reply = await sendChatMessage(requestMessages, {
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
              stream: chatOptions.stream,
            });
             if (!isCurrent()) return false;
             working = working.map(item => (
              item.id === pendingMessage.id
                ? { ...item, text: reply || '没有收到回复。', pending: false, waitingForResponse: false }
                : item
            ));
            setMessages(working);
        } catch (error) {
          if (isConfigChangedError(error)) throw error;
          if (isCanceledError(error)) {
            // 停止：结算占位气泡，避免留下永远“正在思考”的僵尸消息
            setMessages(current => (
              isCurrent() ? settlePendingMessage(current, pendingMessage.id) : current
             ));
             return false;
           }
           if (!isCurrent()) return false;
             working = working.map(item => (
              item.id === pendingMessage.id
                ? {
                  ...item,
                  text: `${speaker.name} 本次回复失败`,
                  pending: false,
                  waitingForResponse: false,
                }
                : item
            ));
             setMessages(working);
           }
         }
         return true;
       };

      const runEnsemble = async () => {
        const historyForPrompt = working.filter(item => (
          item
          && !item.pending
          && (item.role === USER_ID || item.role === ASSISTANT_ID)
          && !currentTurnIds.has(item.id)
        ));
        const requestMessages = buildEnsemblePrompt({
          characters: members,
          historyMessages: historyForPrompt,
          userText,
          userProfile,
          globalPresets,
          profiles: memberProfiles,
          mentions,
          everyone,
          imageMessages,
        });
        if (requestMessages.length === 0) return false;
        if (!isCurrent()) return false;
        const groupName = String(activeSessionRef.current?.name || '').trim()
          || members.map(item => String(item.name || '').trim()).filter(Boolean).join('、')
          || '群聊';
        const pendingMessage = {
          id: `${Date.now()}-ensemble-assistant`,
          role: ASSISTANT_ID,
          text: THINKING_PLACEHOLDER,
          pending: true,
          waitingForResponse: true,
          speakerName: groupName,
          timestamp: Date.now(),
        };
        working = [...working, pendingMessage];
        if (!isCurrent()) return false;
        setMessages(working);
        scrollToBottom();
        let reply = '';
        try {
           reply = await sendChatMessage(requestMessages, {
             expectedConfigId,
             expectedConfigFingerprint,
             signal: controller.signal,
            stream: chatOptions.stream,
            onChunk: fullText => {
              if (!isCurrent() || controller.signal.aborted) return;
              setMessages(current => current.map(item => (
                item.id === pendingMessage.id
                  ? { ...item, text: fullText, waitingForResponse: false }
                  : item
              )));
            },
          });
         } catch (error) {
           if (isConfigChangedError(error)) throw error;
           if (isCanceledError(error)) {
             // 停止：合议模式的流式增量只写进了 state（局部变量 working 里仍是占位符），
             // 所以必须按当前 state 结算，否则已生成的部分会被整条丢掉
             setMessages(current => (
               isCurrent() ? settlePendingMessage(current, pendingMessage.id) : current
             ));
             throw error;
           }
           working = working.filter(item => item.id !== pendingMessage.id);
          if (isCurrent()) setMessages(working);
          return false;
        }
        if (!isCurrent()) return false;
        const segments = mergeAdjacentSegments(parseEnsembleReply(reply, members));
        if (segments.length === 0) {
          // 回退：移除临时消息后交给逐角色模式
          working = working.filter(item => item.id !== pendingMessage.id);
          if (isCurrent()) setMessages(working);
          return false;
        }
        working = working.filter(item => item.id !== pendingMessage.id);
        segments.forEach((segment, index) => {
          working = [...working, {
            id: `${Date.now()}-ensemble-${index}-assistant`,
            role: ASSISTANT_ID,
            text: segment.text,
            speakerId: segment.speakerId || undefined,
            speakerName: segment.speakerName || '',
          }];
        });
        if (!isCurrent()) return false;
        setMessages(working);
        scrollToBottom();
        return true;
      };

      const groupMode = activeSessionRef.current?.groupMode || ENSEMBLE_MODE;
      let handled = false;
      if (groupMode !== 'turn') {
        try {
          handled = await runEnsemble();
         } catch (error) {
           if (isConfigChangedError(error)) throw error;
           if (isCanceledError(error)) return false;
           handled = false;
         }
      }
        if (!handled) {
          const turnHandled = await runTurnSpeakers();
          if (turnHandled === false) return false;
        }
        return true;
      } catch (error) {
       if (isConfigChangedError(error)) {
         sourceChangedRef.current = true;
         if (isCurrent()) setMessages(current => current.filter(item => !item.pending));
         return false;
       }
       if (isCanceledError(error)) return false;
        if (isCurrent()) {
          Alert.alert('群聊回复失败', '请稍后重试。');
        }
        return false;
      } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (isCurrent()) {
          setIsSending(false);
          autoScrollToBottom();
        }
      }
    }
  }, [autoScrollToBottom, chatOptions.stream, isSessionGuardCurrent, ready, scrollToBottom]);

  const performSendMessage = useCallback(async (rawText, extraAttachments = [], suppliedGuard = null) => {
    const sessionGuard = suppliedGuard || captureSessionGuard();
    const sendController = sendLockRef.current?.controller || null;
    const isCanceled = () => !!(
      (sendController && sendController.signal.aborted)
      || (abortRef.current && abortRef.current.signal.aborted)
    );
    const text = String(rawText || '').trim();
    const baseAttachments = Array.isArray(attachments) ? attachments : [];
    const allAttachments = [...baseAttachments, ...(Array.isArray(extraAttachments) ? extraAttachments : [])];
    const imageAttachments = allAttachments.filter(item => (
      item && (item.kind === 'image' || item.kind === STICKER_MESSAGE_KIND)
    ));
    const textAttachments = allAttachments.filter(item => item && item.kind === 'text');
    if (imageAttachments.length > MAX_IMAGE_ATTACHMENTS) {
      Alert.alert('图片过多', `一次最多发送 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
      return false;
    }
    if (!isSessionGuardCurrent(sessionGuard)
       || messageSelectionOpen
       || isSwitching
       || sessionTransitionPending
       || (!text && imageAttachments.length === 0 && textAttachments.length === 0)
      || !sendLockRef.current
       || !ready
       || (abortRef.current && abortRef.current.signal.aborted)) return false;
     if (!isGroupRef.current && !greetingReady) return false;
     if (isGroupRef.current && groupCharactersRef.current.length === 0) {
       Alert.alert('无法发送', '这个群聊没有可用的角色（成员可能已被删除）。');
       return false;
     }
     if (isGroupRef.current) openingRequestRef.current += 1;
     if (sessionOwnerMissing) {
      Alert.alert('角色资料缺失', '这段历史对话可以查看，恢复角色资料后才能发送消息。');
      return false;
    }
     let visionEnabled = false;
     let expectedConfigId = '';
     let expectedConfigFingerprint = '';
    try {
       const { configs, activeId } = await getApiConfigs();
       if (isCanceled() || !isSessionGuardCurrent(sessionGuard)) return false;
      const current = configs.find(item => item.id === activeId) || configs[0];
       expectedConfigId = String(current?.id || '');
       expectedConfigFingerprint = current ? getConfigFingerprint(current) : '';
       visionEnabled = !!(current && current.supportsVision);
    } catch (error) {}
     let sizedImages = [];
     try {
       sizedImages = await Promise.all(imageAttachments.map(async item => {
         const info = await getImageFileInfo(item.uri);
         if (!info.exists) throw new Error('图片不存在');
         return { ...item, size: info.size || Number(item.size) || 0 };
         }));
         if (isCanceled()) return false;
         validateImageBatch(sizedImages, { requireDimensions: true });
     } catch (error) {
       if (error && error.message === '无法读取图片大小') {
         Alert.alert('图片读取失败', '无法读取图片大小，请重新选择图片。');
       } else {
         Alert.alert('图片过大', '一次发送的图片总大小过大，请减少图片后再试。');
       }
       return false;
     }
    ttsStop().catch(() => {});
     const now = Date.now();
     const mediaMessages = [];
     const imageMessages = [];
     let totalBase64Bytes = 0;
    for (let index = 0; index < imageAttachments.length; index += 1) {
      const item = sizedImages[index];
      const kind = item.kind === STICKER_MESSAGE_KIND ? STICKER_MESSAGE_KIND : 'image';
      if (kind === 'image' && !visionEnabled) {
        Alert.alert('不支持识图', '当前来源未标记为支持识图，请在设置中确认模型能力。');
        return false;
      }
       let dataUri = '';
       if (visionEnabled) {
          const estimatedBase64Bytes = Math.ceil(Number(item.size || 0) * 4 / 3);
          if (totalBase64Bytes + estimatedBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
            Alert.alert('图片过大', '图片总大小过大，请减少图片后再试。');
            return false;
          }
          totalBase64Bytes += estimatedBase64Bytes;
          try {
            dataUri = await readImageDataUri(item.uri, item.mime);
            const separator = dataUri.indexOf(',');
            const base64Length = separator >= 0 ? dataUri.length - separator - 1 : dataUri.length;
            const actualBase64Bytes = Math.ceil(base64Length * 3 / 4);
            totalBase64Bytes = Math.max(
              totalBase64Bytes,
              totalBase64Bytes - estimatedBase64Bytes + actualBase64Bytes
            );
              if (totalBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
                throw new Error('图片总大小过大');
              }
              if (isCanceled()) return false;
          } catch (error) {
           if (error && error.message === '图片总大小过大') {
             Alert.alert('图片过大', '图片总大小过大，请减少图片后再试。');
           } else {
             Alert.alert('图片读取失败', '请重新选择图片。');
           }
           return false;
         }
      }
      if (!isSessionGuardCurrent(sessionGuard)) return false;
      const mediaMessage = createMediaMessage({
        id: `${now}-${kind}-${index}`,
        kind,
        uri: item.uri,
        mime: item.mime,
        name: item.name || item.stickerName,
        width: item.width,
        height: item.height,
        stickerId: item.stickerId,
        stickerName: item.stickerName,
        timestamp: now + index,
      });
      mediaMessages.push(mediaMessage);
      imageMessages.push({
        ...mediaMessage,
        dataUri,
        includeImage: visionEnabled,
      });
    }
     const mergedText = mergeTextAttachments(text, textAttachments);
     if (!mergedText && mediaMessages.length === 0) return false;
     const textMessage = mergedText
      ? {
          id: `${now}-user-${mediaMessages.length}`,
          role: USER_ID,
          text: mergedText,
          timestamp: now + mediaMessages.length,
        }
      : null;
    const draftQuote = quoteTarget;
    if (textMessage && draftQuote) textMessage.quoted = draftQuote;
    const baseMessages = [...messages, ...mediaMessages];
    if (textMessage) baseMessages.push(textMessage);
    const payload = {
      historyMessages: messages,
      userText: mergedText,
      baseMessages,
      images: imageMessages
        .filter(item => item.includeImage)
        .map(item => item.dataUri),
      imageMessages,
      quote: textMessage ? draftQuote : null,
       expectedConfigId,
       expectedConfigFingerprint,
       sessionGuard,
    };
     if (isCanceled() || !isSessionGuardCurrent(sessionGuard)
       || (abortRef.current && abortRef.current.signal.aborted)) return false;
     try {
       const latest = await getApiConfigs();
       if (isCanceled() || !isSessionGuardCurrent(sessionGuard)) return false;
       const latestConfig = latest.configs.find(item => item.id === latest.activeId) || latest.configs[0];
        const latestConfigId = String(latestConfig && latestConfig.id || '');
        if (
          (expectedConfigId && latestConfigId !== expectedConfigId)
          || (
            expectedConfigFingerprint
            && latestConfig
            && getConfigFingerprint(latestConfig) !== expectedConfigFingerprint
          )
        ) {
         Alert.alert('模型来源已切换', '请重新发送这条消息。');
         return false;
       }
       if (
         imageAttachments.some(item => item.kind === 'image')
         && latestConfig
         && latestConfig.supportsVision !== true
       ) {
         Alert.alert('不支持识图', '当前来源未标记为支持识图，请在设置中确认模型能力。');
         return false;
       }
     } catch (error) {
       Alert.alert('配置读取失败', '请稍后重试。');
       return false;
     }
     const baseAttachmentIds = baseAttachments.map(item => String(item.id || ''));
    setInput(current => current === rawText ? '' : current);
    setAttachments(current => {
      const currentIds = current.map(item => String(item.id || ''));
      if (
        currentIds.length !== baseAttachmentIds.length
        || currentIds.some((id, index) => id !== baseAttachmentIds[index])
      ) return current;
      return [];
    });
    setQuoteTarget(current => (
      String(current && current.id || '') === String(draftQuote && draftQuote.id || '')
        ? null
        : current
    ));
      const handled = isGroupRef.current
        ? await requestGroupReply(payload)
        : await requestReply(payload);
      if (handled === false && isSessionGuardCurrent(sessionGuard)) {
        const originalIds = new Set(messages.map(item => String(item && item.id || '')));
        setMessages(current => current.filter(item => originalIds.has(String(item && item.id || ''))));
        const restoredAttachments = allAttachments;
        attachmentsRef.current = restoredAttachments;
        setAttachments(restoredAttachments);
        setInput(rawText);
        setQuoteTarget(draftQuote);
        syncProtectedAttachmentUris();
        if (sourceChangedRef.current) {
          Alert.alert('模型来源已切换', '已保留原消息草稿，请重新发送。');
        }
        return false;
      }
      return handled !== false && isSessionGuardCurrent(sessionGuard) && !(abortRef.current && abortRef.current.signal.aborted);
  }, [attachments, captureSessionGuard, greetingReady, isSessionGuardCurrent, isSwitching, messageSelectionOpen, messages, quoteTarget, ready, requestReply, requestGroupReply, sessionOwnerMissing, sessionTransitionPending, syncProtectedAttachmentUris]);

  const sendMessage = useCallback(async (...args) => {
    const token = beginSendOperation();
    if (!token) return false;
    try {
      return await performSendMessage(...args);
    } finally {
      endSendOperation(token);
    }
  }, [beginSendOperation, endSendOperation, performSendMessage]);

  const sendText = useCallback(rawText => sendMessage(rawText), [sendMessage]);

  const regenerateMessage = useCallback(async targetId => {
     if (isSending || isSwitching || sessionTransitionPending || !ready || sendLockRef.current) return;
    const token = beginSendOperation();
    if (!token) return;
    const sessionGuard = captureSessionGuard();
     try {
       if (!isSessionGuardCurrent(sessionGuard)) return false;
       const originalMessages = messages;
       if (sessionOwnerMissing) {
        Alert.alert('角色资料缺失', '恢复角色资料后才能重新生成回复。');
        return false;
      }
      const index = messages.findIndex(item => item.id === targetId);
      if (index < 0 || messages[index].role !== ASSISTANT_ID) return false;
      let userStart = index - 1;
      while (userStart >= 0 && messages[userStart].role === USER_ID) {
        userStart -= 1;
      }
      userStart += 1;
       const userMessages = messages.slice(userStart, index);
       if (userMessages.length === 0) return false;
       const quote = userMessages
         .slice()
         .reverse()
         .find(item => item && item.quoted && item.quoted.text)
         ?.quoted || null;
       let includeImage = false;
       let expectedConfigId = '';
       let expectedConfigFingerprint = '';
      try {
        const { configs, activeId } = await getApiConfigs();
        const current = configs.find(item => item.id === activeId) || configs[0];
         expectedConfigId = String(current?.id || '');
         expectedConfigFingerprint = current ? getConfigFingerprint(current) : '';
         includeImage = !!(current && current.supportsVision);
      } catch (error) {}
      if (!isSessionGuardCurrent(sessionGuard)) return false;
       const mediaItems = userMessages.filter(item => item && item.image);
       let sizedMedia = [];
       try {
         sizedMedia = await Promise.all(mediaItems.map(async item => {
           const info = await getImageFileInfo(item.image.uri);
           if (!info.exists) throw new Error('图片不存在');
             const dimensions = item.image.width > 0 && item.image.height > 0
               ? { width: item.image.width, height: item.image.height }
               : await getImageDimensions(item.image.uri);
             return {
               item,
               size: info.size,
               width: dimensions.width,
               height: dimensions.height,
             };
         }));
           validateImageBatch(sizedMedia, { requireDimensions: true });
       } catch (error) {
         Alert.alert('图片过大', '重新生成所需的图片大小或数量超限。');
         return false;
       }
        const imageMessages = [];
        let totalBase64Bytes = 0;
        for (const media of sizedMedia) {
          const { item } = media;
          let dataUri = '';
          if (includeImage) {
            const estimatedBase64Bytes = Math.ceil(Number(media.size || 0) * 4 / 3);
            if (totalBase64Bytes + estimatedBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
              Alert.alert('图片过大', '重新生成所需的图片总大小过大。');
              return false;
            }
            totalBase64Bytes += estimatedBase64Bytes;
            dataUri = await readImageDataUri(item.image.uri, item.image.mime).catch(() => '');
            const separator = dataUri.indexOf(',');
            const base64Length = separator >= 0 ? dataUri.length - separator - 1 : dataUri.length;
            const actualBase64Bytes = Math.ceil(base64Length * 3 / 4);
            totalBase64Bytes = Math.max(
              totalBase64Bytes,
              totalBase64Bytes - estimatedBase64Bytes + actualBase64Bytes
            );
            if (totalBase64Bytes > MAX_IMAGE_BASE64_BYTES) {
              Alert.alert('图片过大', '重新生成所需的图片总大小过大。');
              return false;
            }
          }
          imageMessages.push({
            ...item.item,
            dataUri,
            includeImage,
          });
        }
      const userText = userMessages
        .filter(item => item && !item.image)
        .map(item => String(item.text || ''))
        .filter(Boolean)
        .join('\n');
        if (!isSessionGuardCurrent(sessionGuard)) return false;
        const vectorOwnerId = getVectorOwnerId(
          sessionsRef.current.find(item => item.id === sessionGuard.sessionId),
          character.id
        );
        if (vectorOwnerId) {
          await removeVectorIndexForSession(vectorOwnerId, sessionGuard.sessionId);
        }

       const handled = await requestReply({
         historyMessages: messages.slice(0, userStart),
         userText,
           baseMessages: messages.slice(0, index),
           imageMessages,
           quote,
            expectedConfigId,
            expectedConfigFingerprint,
            sessionGuard,
            restoreOnFailure: true,
       });
        if (handled === false && isSessionGuardCurrent(sessionGuard)) {
          setMessages(originalMessages);
          if (sourceChangedRef.current) {
            Alert.alert('模型来源已切换', '已保留原消息，请重新生成。');
          }
          return false;
        }
        return handled !== false && isSessionGuardCurrent(sessionGuard) && !abortRef.current;
    } finally {
      endSendOperation(token);
    }
  }, [beginSendOperation, captureSessionGuard, endSendOperation, isSending, isSessionGuardCurrent, isSwitching, messages, ready, removeVectorIndexForSession, requestReply, sessionOwnerMissing, sessionTransitionPending]);

  const editUserMessage = useCallback(targetId => {
    if (isSending || isSwitching || sessionTransitionPending || !ready || abortRef.current) return;
    const sessionGuard = captureSessionGuard();
    const plan = getEditResendPlan(messagesRef.current, targetId);
    if (!plan || !isSessionGuardCurrent(sessionGuard)) return;
    Alert.alert(
      '修改重发',
      '确定撤回这条消息及其后续回复，并将原文字回退到输入框吗？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '撤回并编辑',
          style: 'destructive',
          onPress: async () => {
            if (isSending || isSwitching || !isSessionGuardCurrent(sessionGuard) || abortRef.current) return;
            const latestPlan = getEditResendPlan(messagesRef.current, targetId);
            if (!latestPlan) return;
            try {
              await resetSessionSummaries(sessionGuard.sessionId);
               const vectorOwnerId = getVectorOwnerId(
                 sessionsRef.current.find(item => item.id === sessionGuard.sessionId),
                 characterId
               );
               if (vectorOwnerId) {
                 await removeVectorIndexForSession(vectorOwnerId, sessionGuard.sessionId);
               }
              if (!isSessionGuardCurrent(sessionGuard)) return;
              setMessages(latestPlan.messages);
              setInput(latestPlan.text);
              setQuoteTarget(null);
            } catch (error) {
              Alert.alert('撤回失败', '记忆摘要未能同步重置，请稍后重试。');
            }
          },
        },
      ]
    );
  }, [captureSessionGuard, isSending, isSessionGuardCurrent, isSwitching, ready, removeVectorIndexForSession, resetSessionSummaries, sessionTransitionPending]);

  const messageActionsRef = useRef({});
  useEffect(() => {
    messageActionsRef.current = { regenerateMessage, editUserMessage };
  }, [regenerateMessage, editUserMessage]);

  const onRegenerateMessage = useCallback(targetId => {
    messageActionsRef.current.regenerateMessage?.(targetId);
  }, []);

  const onEditUserMessage = useCallback(targetId => {
    messageActionsRef.current.editUserMessage?.(targetId);
  }, []);

  const onSelectText = useCallback(text => {
    setSelectionText(String(text || ''));
  }, []);

  const onQuoteMessage = useCallback(message => {
    if (!message || !message.id) return;
    const isUserMessage = message.role === USER_ID;
    const speakerName = String(message.speakerName || '').trim();
    const name = isUserMessage
      ? (userNameRef.current || '我')
      : (speakerName || String(character?.name || '').trim());
    const payload = buildQuotePayload(message, name);
    if (!payload) return;
    setQuoteTarget(payload);
  }, [character]);

  const onPressQuoteBlock = useCallback(quote => {
    if (!quote || !quote.id) return;
    const exists = messages.some(item => item.id === quote.id);
    if (!exists) {
      Alert.alert('原消息已删除', '无法定位到被引用的消息。');
      return;
    }
    setFocusedMessageId(quote.id);
    scrollToMessage(quote.id);
  }, [messages, scrollToMessage]);

  const startMessageSelection = useCallback(messageId => {
    if (!messageId || !ready || isSending) return;
    setSelectedMessageIds(current => {
      const id = String(messageId);
      if (current.includes(id)) return current;
      return current.length > 0 ? [...current, id] : [id];
    });
    setSearchOpen(false);
    setMoreOpen(false);
  }, [isSending, ready]);

  const toggleSelectedMessage = useCallback(messageId => {
    if (!messageId || !ready || isSending) return;
    setSelectedMessageIds(current => toggleMessageSelection(current, messageId));
  }, [isSending, ready]);

  const cancelMessageSelection = useCallback(() => {
    setSelectedMessageIds([]);
  }, []);

  const confirmDeleteSelectedMessages = useCallback(() => {
    const ids = selectedMessageIds.slice();
    if (ids.length === 0 || !ready || isSending) return;
    const sessionId = activeSessionIdRef.current;
    const sessionVersion = sessionVersionRef.current;
    const session = sessionsRef.current.find(item => item.id === sessionId);
    const currentBoundary = String((session && session.summarizedUpTo) || '');
    const nextBoundary = summarizeBoundaryAfterDeletion(
      messagesRef.current,
      currentBoundary,
      ids
    );
    Alert.alert(
      '删除消息',
      `确定删除选中的 ${ids.length} 条消息吗？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            if (
              sessionVersionRef.current !== sessionVersion
              || activeSessionIdRef.current !== sessionId
            ) return;
            try {
              if (session && nextBoundary !== currentBoundary) {
                await setSessionSummarizedUpTo(sessionId, nextBoundary);
              }
            } catch (error) {
              Alert.alert('删除失败', '总结边界未能同步，请稍后重试。');
              return;
            }
            if (
              sessionVersionRef.current !== sessionVersion
              || activeSessionIdRef.current !== sessionId
            ) return;
            sessionVersionRef.current += 1;
            const vectorOwnerId = getVectorOwnerId(session, characterId);
            if (vectorOwnerId) {
              removeVectorIndexForMessages(vectorOwnerId, sessionId, ids).catch(error => {
                if (__DEV__) console.warn('[vector] message cleanup failed', error);
              });
            }
            setMessages(current => removeMessagesByIds(current, ids));
            ids.forEach(id => {
              delete errorRawRef.current[id];
              delete messageOffsetsRef.current[id];
            });
            setSelectedMessageIds([]);
            setFocusedMessageId(current => (
              ids.includes(current) ? '' : current
            ));
            setQuoteTarget(current => (
              current && ids.includes(String(current.id || '')) ? null : current
            ));
          },
        },
      ]
    );
  }, [characterId, isSending, ready, removeVectorIndexForMessages, selectedMessageIds, setSessionSummarizedUpTo]);

  const toggleBroadcast = useCallback(async () => {
    const next = { ...ttsSettings, enabled: !ttsSettings.enabled };
    setTtsSettings(next);
    ttsRef.current = next;
    if (!next.enabled) {
      ttsStop().catch(() => {});
    }
    try {
      await saveTtsSettings(next);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, [ttsSettings]);

  const broadcastMessage = useCallback(async text => {
    const settings = ttsRef.current;
    if (!settings || !settings.enabled) return;
    const content = toSpeechText(text);
    if (!content) return;
    const provider = getTtsProvider(settings.activeProvider);
    const config = (settings.providers && settings.providers[provider.id]) || {};
    try {
      await ttsSpeak({ provider, config, text: content });
    } catch (error) {
      Alert.alert('播报失败', (error && error.message) || '请稍后重试。');
    }
  }, []);

  const generateInlineImage = useCallback(async (messageId, sourceText) => {
    if (inlineImageBusyRef.current) {
      Alert.alert('配图生成中', '请稍后重试。');
      return;
    }
    const settings = inlineImageSettings;
    const providerId = settings.providerId || '';
    if (!providerId) {
      Alert.alert('未配置生图服务', '请到「设置 → 对话配图」选择生图服务并填写密钥。');
      return;
    }
    const provider = getImageProvider(providerId);
    const prompt = buildInlineImagePrompt(sourceText, settings.stylePrefix, settings.maxPromptChars);
    if (!prompt) return;

    let genConfig = null;
    try {
      const stored = await getImageGenSettings();
      genConfig = (stored.providers && stored.providers[providerId]) || null;
    } catch (error) {
      genConfig = null;
    }
    if (!genConfig || !String(genConfig.baseUrl || provider.baseUrl || '').trim()) {
      Alert.alert('未配置生图服务', '请到「设置 → 对话配图」填写服务地址与密钥。');
      return;
    }

     const controller = new AbortController();
     const sessionId = activeSessionIdRef.current;
     inlineImageControllerRef.current = controller;
     inlineImageBusyRef.current = true;
     setMessages(current => current.map(item => (

      item.id === messageId ? { ...item, inlineImage: { status: 'loading' } } : item
    )));
    try {
      const response = await generateImage({
        provider,
        config: genConfig,
         prompt,
         size: settings.size,
         signal: controller.signal,
       });
       if (controller.signal.aborted || activeSessionIdRef.current !== sessionId) return;
       const first = response.images[0] || null;

      setMessages(current => current.map(item => (
        item.id === messageId
          ? {
            ...item,
            inlineImage: first ? { status: 'done', ...first } : { status: 'error', message: '未获取到图片' },
          }
          : item
      )));
     } catch (error) {
       if (!controller.signal.aborted && activeSessionIdRef.current === sessionId) {
         setMessages(current => current.map(item => (
           item.id === messageId
             ? { ...item, inlineImage: { status: 'error', message: (error && error.message) || '配图生成失败' } }
             : item
         )));
       }
     } finally {
       if (inlineImageControllerRef.current === controller) {
         inlineImageControllerRef.current = null;
         inlineImageBusyRef.current = false;
       }

    }
  }, [inlineImageSettings]);

  const sendTextRef = useRef(sendText);
  const generateInlineImageRef = useRef(null);
  const inlineImageEnabledRef = useRef(false);
  const ttsRef = useRef({ enabled: false, activeProvider: 'system', providers: {} });
  const recordTurnRef = useRef(null);
  useEffect(() => {
    generateInlineImageRef.current = generateInlineImage;
    inlineImageEnabledRef.current = inlineImageSettings.enabled;
  }, [generateInlineImage, inlineImageSettings.enabled]);
  useEffect(() => {
    ttsRef.current = ttsSettings;
  }, [ttsSettings]);
  useEffect(() => {
    sendTextRef.current = sendText;
  }, [sendText]);

  const onSlashCommand = useCallback((command, token, sourceMessageId = '') => {
    if (
      sourceMessageId
      && !messagesRef.current.some(message => String(message && message.id || '') === String(sourceMessageId))
    ) return;
    const result = sendTextRef.current?.(String(command || '').replace(/^\/send\s+/, ''));
    if (result && typeof result.catch === 'function') {
      result.catch(error => {
        if (!isConfigChangedError(error)) {
          Alert.alert('发送失败', (error && error.message) || '请稍后重试。');
        }
      });
    }
  }, []);

  const removeAttachment = useCallback(id => {
     if (isSending || sendLockRef.current) return;
     const target = attachments.find(item => item.id === id);
     if (target && target.kind === 'image') deleteLocalImage(target.uri);
     setAttachments(current => {
       const next = current.filter(item => item.id !== id);
       attachmentsRef.current = next;
       return next;
     });
     syncProtectedAttachmentUris();
   }, [attachments, isSending, syncProtectedAttachmentUris]);

  const addAttachment = useCallback(async kind => {
    const sessionGuard = captureSessionGuard();
    if (
      !isSessionGuardCurrent(sessionGuard)
      || isSending
      || isSwitching
      || sessionTransitionPending
      || sendLockRef.current
      || attachmentLoading
      || attachmentPickerLockRef.current
      || !ready
      || messageSelectionOpen
    ) return;
    attachmentPickerLockRef.current = true;
    setAttachmentLoading(true);
    let durableUri = '';
    let picked = null;
    try {
      picked = await pickAttachment();
      if (!picked) return;
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      if (kind === 'text') {
        if (!isTextLike(picked.name, picked.mime)) {
          deleteTemporaryImage(picked.uri);
          Alert.alert('不支持的文件', '当前仅支持纯文本类文档。');
          return;
        }
        const text = await readTextAttachment(picked.uri);
        if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
          deleteTemporaryImage(picked.uri);
          return;
        }
        deleteTemporaryImage(picked.uri);
        setAttachments(current => {
          const next = [...current, {
            id: `${Date.now()}-${current.length}`,
            kind: 'text',
            name: picked.name,
            text,
          }];
          attachmentsRef.current = next;
          return next;
        });
        return;
      }
       if (!isImage(picked.name, picked.mime)) {
         deleteTemporaryImage(picked.uri);
         Alert.alert('不支持的文件', '请选择图片文件。');
         return;
       }
       if (!isVisionImage(picked.name, picked.mime)) {
         deleteTemporaryImage(picked.uri);
         Alert.alert('不支持的图片格式', '请选择 PNG、JPEG、WebP 或 GIF 图片。');
         return;
       }
       const fileInfo = await getImageFileInfo(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      if (!fileInfo.exists) throw new Error('图片不存在');
      const size = fileInfo.size || picked.size;
      validateImageSize({ size });
      if (isSending || isSwitching || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      const dimensions = picked.width && picked.height
        ? { width: picked.width, height: picked.height }
        : await getImageDimensions(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      validateImageSize({ size, width: dimensions.width, height: dimensions.height });
      if (attachmentsRef.current.filter(item => item.kind === 'image').length >= MAX_IMAGE_ATTACHMENTS) {
        deleteTemporaryImage(picked.uri);
        Alert.alert('图片过多', `一次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
        return;
      }
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current || current.supportsVision !== true) {
        deleteTemporaryImage(picked.uri);
        Alert.alert('不支持识图', '当前来源未标记为支持识图，请在设置中确认模型能力。');
        return;
      }
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      durableUri = await persistImageAttachment(picked.uri, picked.mime, picked.name);
      deleteTemporaryImage(picked.uri);
      pendingAttachmentUrisRef.current.add(durableUri);
      syncProtectedAttachmentUris();
      const mime = getImageMime(picked.name, picked.mime);
      if (!isSessionGuardCurrent(sessionGuard) || isSending || isSwitching || sessionTransitionPending || sendLockRef.current) {
        pendingAttachmentUrisRef.current.delete(durableUri);
        syncProtectedAttachmentUris();
        deleteLocalImage(durableUri);
        return;
      }
      setAttachments(list => {
        const next = [...list, {
          id: `${Date.now()}-${list.length}`,
          kind: 'image',
          name: picked.name,
          uri: durableUri,
          mime,
          size,
          width: dimensions.width,
          height: dimensions.height,
        }];
        attachmentsRef.current = next;
        return next;
      });
      pendingAttachmentUrisRef.current.delete(durableUri);
      syncProtectedAttachmentUris();
    } catch (error) {
      if (durableUri) {
        pendingAttachmentUrisRef.current.delete(durableUri);
        syncProtectedAttachmentUris();
        deleteLocalImage(durableUri);
      }
      if (picked && picked.uri) deleteTemporaryImage(picked.uri);
      Alert.alert(
        '文件读取失败',
        ['文件过大', '图片过大', '图片分辨率过大', '图片总大小过大'].includes(error && error.message)
          ? '文件过大，请选择更小的文件。'
          : '请重试。'
       );
     } finally {
       attachmentPickerLockRef.current = false;
       setAttachmentLoading(false);
     }
   }, [attachmentLoading, captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, messageSelectionOpen, ready, sessionTransitionPending, syncProtectedAttachmentUris]);

  const pickAttachmentMenu = useCallback(() => {
    Alert.alert('添加附件', '选择要上传的内容类型。', [
      { text: '取消', style: 'cancel' },
      { text: '纯文本文档', onPress: () => addAttachment('text') },
      { text: '图片', onPress: () => addAttachment('image') },
    ]);
  }, [addAttachment]);

  const openStickerNamePrompt = useCallback(source => {
    if (!source || !source.uri) return;
    setStickerNameDraft('');
    setStickerNamePrompt({
      uri: String(source.uri),
      mime: String(source.mime || 'image/jpeg'),
      name: String(source.name || ''),
       width: Number(source.width) || 0,
       height: Number(source.height) || 0,
       size: Number(source.size) || 0,
       sessionId: activeSessionIdRef.current,
       sessionVersion: sessionVersionRef.current,
     });
  }, []);

  const confirmDeleteImageMessage = useCallback(messageId => {
    if (!messageId) return;
    const sessionId = activeSessionIdRef.current;
    const sessionVersion = sessionVersionRef.current;
    const session = sessionsRef.current.find(item => item.id === sessionId);
    Alert.alert('删除图片消息', '确定删除这张图片消息吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          if (
            activeSessionIdRef.current !== sessionId
            || sessionVersionRef.current !== sessionVersion
          ) return;
          sessionVersionRef.current += 1;
          const vectorOwnerId = getVectorOwnerId(session, characterId);
          if (vectorOwnerId) {
            removeVectorIndexForMessage(vectorOwnerId, sessionId, messageId).catch(error => {
              if (__DEV__) console.warn('[vector] image cleanup failed', error);
            });
          }
          setMessages(current => removeMessagesByIds(current, [messageId]));
          setSelectedMessageIds(current => current.filter(id => id !== messageId));
          setFocusedMessageId(current => current === messageId ? '' : current);
        },
      },
    ]);
  }, [characterId, removeVectorIndexForMessage]);

  const confirmStickerName = useCallback(async () => {
    if (stickerSaveLockRef.current) return;
    const source = stickerNamePrompt;
    const name = String(stickerNameDraft || '').trim();
     if (!source || !name) {
       if (source) Alert.alert('请输入名称', '表情包需要一个名称，方便模型理解。');
       return;
     }
     if (
       String(source.sessionId || '') !== String(activeSessionIdRef.current)
       || Number(source.sessionVersion) !== Number(sessionVersionRef.current)
     ) {
       deleteTemporaryImage(source.uri);
       setStickerNamePrompt(null);
       setStickerNameDraft('');
       return;
     }
     stickerSaveLockRef.current = true;
     setStickerSaving(true);
     let processedUri = '';
     let sourceConsumed = false;
    try {
       const processed = await createStickerImage(source.uri, source.width, source.height);
       processedUri = processed.uri;
       if (
         String(source.sessionId || '') !== String(activeSessionIdRef.current)
         || Number(source.sessionVersion) !== Number(sessionVersionRef.current)
       ) {
         deleteStickerImage(processedUri);
         processedUri = '';
         sourceConsumed = true;
         return;
       }
       const saved = await saveSticker({
        id: `sticker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        uri: processed.uri,
        mime: processed.mime,
        width: processed.width,
        height: processed.height,
        createdAt: Date.now(),
      });
      stickerLoadRef.current += 1;
      setStickers(current => [saved, ...current.filter(item => item.id !== saved.id)]);
       setStickerNamePrompt(null);
       setStickerNameDraft('');
       setStickerPanelOpen(true);
       sourceConsumed = true;
    } catch (error) {
      if (processedUri) deleteStickerImage(processedUri);
      Alert.alert('保存表情包失败', (error && error.message) || '请稍后重试。');
     } finally {
       if (sourceConsumed && source && source.uri) deleteTemporaryImage(source.uri);
       stickerSaveLockRef.current = false;
       setStickerSaving(false);
     }
  }, [deleteStickerImage, deleteTemporaryImage, saveSticker, stickerNameDraft, stickerNamePrompt]);

  const addStickerFromPicker = useCallback(async () => {
    const sessionGuard = captureSessionGuard();
    if (!isSessionGuardCurrent(sessionGuard)
      || stickerSaving
      || isSending
      || isSwitching
      || stickerPickerLockRef.current) return;
    stickerPickerLockRef.current = true;
    let picked = null;
    try {
       picked = await pickStickerImage();
       if (!picked) return;
       if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
         deleteTemporaryImage(picked.uri);
         return;
       }
      if (!isImage(picked.name, picked.mime)) {
        deleteTemporaryImage(picked.uri);
        Alert.alert('不支持的文件', '请选择一张图片。');
        return;
      }
      const fileInfo = await getImageFileInfo(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      if (!fileInfo.exists) throw new Error('图片不存在');
      const size = fileInfo.size || picked.size;
      validateImageSize({ size });
      const dimensions = picked.width && picked.height
        ? { width: picked.width, height: picked.height }
        : await getImageDimensions(picked.uri);
      if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
        deleteTemporaryImage(picked.uri);
        return;
      }
      validateImageSize({ size, width: dimensions.width, height: dimensions.height });
      openStickerNamePrompt({
        uri: picked.uri,
        mime: picked.mime || 'image/jpeg',
        name: picked.name,
        width: dimensions.width,
        height: dimensions.height,
        size,
      });
    } catch (error) {
      if (picked && picked.uri) deleteTemporaryImage(picked.uri);
      Alert.alert('选择图片失败', (error && error.message) || '请重试。');
    } finally {
      stickerPickerLockRef.current = false;
    }
  }, [captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, openStickerNamePrompt, sessionTransitionPending, stickerSaving]);

  useEffect(() => {
    if (!ready || stickerSaving || stickerNamePrompt || stickerPickerLockRef.current) return undefined;
     stickerPickerLockRef.current = true;
      const sessionGuard = captureSessionGuard();
      let cancelled = false;
      let picked = null;
     (async () => {
       picked = pendingStickerResultRef.current || await getPendingStickerImage();
       pendingStickerResultRef.current = null;
       if (!picked) return;
       if (cancelled || !isSessionGuardCurrent(sessionGuard) || isSwitching) {
         pendingStickerResultRef.current = picked;
         return;
       }
        if (!isImage(picked.name, picked.mime)) {
          deleteTemporaryImage(picked.uri);
          return;
        }
        const fileInfo = await getImageFileInfo(picked.uri);
        if (!fileInfo.exists) throw new Error('图片不存在');
        const size = fileInfo.size || picked.size;
        validateImageSize({ size });
        const dimensions = picked.width && picked.height
          ? { width: picked.width, height: picked.height }
          : await getImageDimensions(picked.uri);
        if (!isSessionGuardCurrent(sessionGuard) || isSwitching) {
          deleteTemporaryImage(picked.uri);
          return;
        }
        validateImageSize({ size, width: dimensions.width, height: dimensions.height });
       if (cancelled || !isSessionGuardCurrent(sessionGuard) || isSwitching) {
         pendingStickerResultRef.current = picked;
         return;
       }
       openStickerNamePrompt({
         uri: picked.uri,
         mime: picked.mime || 'image/jpeg',
         name: picked.name,
         width: dimensions.width,
         height: dimensions.height,
         size,
       });
     })().catch(error => {
       if (picked && picked.uri) deleteTemporaryImage(picked.uri);
       if (!cancelled) Alert.alert('选择图片失败', (error && error.message) || '请重试。');
     }).finally(() => {
      stickerPickerLockRef.current = false;
    });
    return () => {
      cancelled = true;
      stickerPickerLockRef.current = false;
    };
  }, [captureSessionGuard, deleteTemporaryImage, isSending, isSessionGuardCurrent, isSwitching, openStickerNamePrompt, ready, sessionTransitionPending, stickerNamePrompt, stickerSaving]);

  const saveImage = useCallback(async image => {
    if (!image || !image.uri) return;
    try {
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (!available) throw new Error('当前设备不支持保存图片');
      await Sharing.shareAsync(String(image.uri), {
        mimeType: String(image.mime || 'image/jpeg'),
        dialogTitle: '保存图片',
        UTI: 'public.image',
      });
    } catch (error) {
      Alert.alert('保存图片失败', (error && error.message) || '请稍后重试。');
    }
  }, []);

  const openImageActions = useCallback((image, messageId) => {
    if (!image || !image.uri) return;
    Alert.alert('图片操作', image.stickerName ? `「${image.stickerName}」` : '选择图片操作', [
      { text: '取消', style: 'cancel' },
      { text: '保存', onPress: () => saveImage(image) },
      { text: '保存为表情包', onPress: () => openStickerNamePrompt(image) },
      { text: '删除消息', style: 'destructive', onPress: () => confirmDeleteImageMessage(messageId) },
    ]);
  }, [confirmDeleteImageMessage, openStickerNamePrompt, saveImage]);

  const sendSticker = useCallback(async sticker => {
     if (!sticker || messageSelectionOpen || isSending || isSwitching || sessionTransitionPending || !ready || abortRef.current) return;
    const sessionGuard = captureSessionGuard();
    if (!isSessionGuardCurrent(sessionGuard)) return;
    try {
      const sent = await sendMessage(input, [{
        id: `sticker-${Date.now()}`,
        kind: STICKER_MESSAGE_KIND,
        name: sticker.name,
        stickerName: sticker.name,
        stickerId: sticker.id,
        uri: sticker.uri,
        mime: sticker.mime,
        width: sticker.width,
        height: sticker.height,
      }], sessionGuard);
       if (sent) {
         setStickerPanelOpen(false);
       }
    } catch (error) {
      Alert.alert('发送表情包失败', (error && error.message) || '请稍后重试。');
    }
  }, [captureSessionGuard, input, isSending, isSessionGuardCurrent, isSwitching, messageSelectionOpen, ready, sendMessage, sessionTransitionPending]);

  const onSend = useCallback(async () => {
    const text = input.trim();
     if (messageSelectionOpen || (!text && attachments.length === 0) || isSending || isSwitching || sessionTransitionPending || !ready || abortRef.current) return;
    if (!isGroupRef.current && !greetingReady) {
      openGreetingPicker(activeSessionId ? 'reselect' : 'new');
      return;
    }
     await sendText(input);
   }, [activeSessionId, attachments.length, greetingReady, input, isSending, isSwitching, messageSelectionOpen, openGreetingPicker, ready, sendText, sessionTransitionPending]);

  const insertMention = useCallback(name => {
    const label = `${MENTION_PREFIX}${name} `;
    setInput(current => {
      const selection = inputSelectionRef.current || { start: current.length, end: current.length };
      const start = Math.max(0, Math.min(selection.start, current.length));
      const end = Math.max(start, Math.min(selection.end, current.length));
      const next = `${current.slice(0, start)}${label}${current.slice(end)}`;
      const caret = start + label.length;
      inputSelectionRef.current = { start: caret, end: caret };
      return next;
    });
  }, []);

  const bgUri = isGroup
    ? String(activeSession?.bgUri || '')
    : (character.bgUri || '');
  const groupAvatarUri = isGroup ? String(activeSession?.avatarUri || '') : '';
  const displayName = isGroup
    ? (activeSession?.name || groupCharacters.map(item => item.name).join('、') || '群聊')
    : (sessionOwnerMissing ? '角色资料缺失' : (character.name || 'EasyChat2 助手'));
  const inputDisabled = !ready || isSending || isSwitching || attachmentLoading || messageSelectionOpen || sessionOwnerMissing || sessionTransitionPending || (!isGroup && !greetingReady);

  const recordTurn = useCallback(async (userText, assistantText, sender = null) => {
    const settings = await getMomentsSettings().catch(() => ({ enabled: true }));
    if (!settings.enabled) return;
    const characterId = String((sender && sender.id) || activeCharacterIdRef.current || '');
    if (!characterId) return;
    const senderName = String((sender && sender.name) || '').trim() || '角色';
    const senderAvatarUri = String((sender && sender.avatarUri) || '').trim();
    const { delta, milestone } = evaluateTurn({ userText, assistantText });
    const affinityStatus = await getAffinityStatus().catch(() => ({ status: 'corrupt', map: {} }));
    if (affinityStatus.status === 'corrupt') return;
    const map = affinityStatus.map;
    const current = map[characterId] || { score: 0, turnCount: 0, triggers: [] };
    const next = {
      score: clampAffinity(current.score + delta),
      turnCount: current.turnCount + 1,
      triggers: Array.isArray(current.triggers) ? current.triggers : [],
    };
    const trigger = shouldTrigger({
      affinity: next.score,
      turnCount: next.turnCount,
      milestone,
      triggers: next.triggers,
    });
    if (!trigger) {
       await saveAffinity({ ...map, [characterId]: next }).catch(error => {
         if (__DEV__) console.warn('[moments] affinity save failed', error);
       });
       return;

    }
    next.triggers = [...next.triggers, trigger];
     await saveAffinity({ ...map, [characterId]: next }).catch(error => {
       if (__DEV__) console.warn('[moments] affinity save failed', error);
     });

    const moment = {
      id: `${Date.now()}-${trigger}`,
      characterId,
      characterName: senderName,
      avatarUri: senderAvatarUri,
      sessionId: String((sender && sender.sessionId) || activeSessionIdRef.current || ''),
      trigger,
      text: buildMomentText({
        trigger,
        character: { name: senderName },
        seed: next.turnCount,
      }),
      createdAt: Date.now(),
      likedByUser: false,
      likes: [],
      comments: [],
    };
     await updateMoments(moments => appendMoment(moments, moment)).catch(error => {
       if (__DEV__) console.warn('[moments] dynamic save failed', error);
     });

  }, []);
  // recordTurn 声明在下方，这里用 ref 暴露给它上面的回调，避免依赖数组引用“后声明”的 const（TDZ）。
  useEffect(() => {
    recordTurnRef.current = recordTurn;
  }, [recordTurn]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      {bgUri ? (
        <Image key={bgUri} source={{ uri: bgUri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" pointerEvents="none" />
      ) : null}
      <View style={styles.topBar}>
        {messageSelectionOpen ? (
          <>
            <TouchableOpacity
              style={styles.selectionAction}
              onPress={cancelMessageSelection}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="取消选择消息"
            >
              <Ionicons name="close" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.selectionActionText}>取消</Text>
            </TouchableOpacity>
            <Text style={styles.selectionCount}>已选择 {selectedMessageIds.length} 条</Text>
            <TouchableOpacity
              style={[styles.selectionAction, isSending && styles.actionDisabled]}
              onPress={confirmDeleteSelectedMessages}
              disabled={isSending}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="删除选中消息"
            >
              <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
              <Text style={[styles.selectionActionText, styles.selectionDeleteText]}>删除</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity
              style={styles.characterChip}
              onPress={() => setSwitcherOpen(true)}
              disabled={!loaded}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={isGroup ? '切换群聊' : '切换角色'}
              accessibilityState={{ disabled: !loaded }}
            >
              {isGroup ? (
                groupAvatarUri ? (
                  <Image source={{ uri: groupAvatarUri }} style={styles.characterAvatar} />
                ) : (
                  <View style={[styles.characterAvatar, styles.characterAvatarFallback]}>
                    <Ionicons name="people" size={13} color={theme.colors.primarySoft} />
                  </View>
                )
              ) : character.avatarUri ? (
                <Image source={{ uri: character.avatarUri }} style={styles.characterAvatar} />
              ) : (
                <View style={[styles.characterAvatar, styles.characterAvatarFallback]}>
                  <Ionicons name="person" size={13} color={theme.colors.primarySoft} />
                </View>
              )}
              <Text style={styles.characterName} numberOfLines={1}>
                {displayName}
              </Text>
              <Ionicons name="chevron-down" size={14} color={theme.colors.primaryMuted} style={styles.characterCaret} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.noticeButton, (isSending || !ready) && styles.actionDisabled]}
              onPress={onNewChat}
              disabled={isSending || !ready}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="新建对话"
              accessibilityState={{ disabled: isSending || !ready }}
            >
              <Ionicons name="add-circle-outline" size={13} color={theme.colors.primarySoft} />
              <Text style={styles.noticeButtonText}>新建</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.noticeButton, !ttsSettings.enabled && styles.actionDisabled]}
              onPress={toggleBroadcast}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={ttsSettings.enabled ? '关闭语音播报' : '开启语音播报'}
            >
              <Ionicons
                name={ttsSettings.enabled ? 'volume-high-outline' : 'volume-mute-outline'}
                size={13}
                color={theme.colors.primarySoft}
              />
              <Text style={styles.noticeButtonText}>{ttsSettings.enabled ? '播报开' : '播报关'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.noticeButton}
              onPress={() => setMoreOpen(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="更多功能"
            >
              <Ionicons name="ellipsis-horizontal" size={15} color={theme.colors.primarySoft} />
            </TouchableOpacity>
          </>
        )}
      </View>
      <View style={styles.aiNoticeBar} pointerEvents="none">
        <Text style={styles.aiNoticeText}>{AI_DISCLAIMER_TEXT}</Text>
      </View>
      {searchOpen ? (
        <View style={styles.searchBar}>
          <Ionicons name="search" size={15} color={theme.colors.textFaint} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="在本对话中搜索"
            placeholderTextColor={theme.colors.textFaint}
            autoFocus
            returnKeyType="search"
            onSubmitEditing={() => goToMatch(1)}
          />
          <Text style={styles.searchCount}>
            {searchMatches.length ? `${activeMatchIndex + 1}/${searchMatches.length}` : '0/0'}
          </Text>
          <TouchableOpacity
            onPress={() => goToMatch(-1)}
            disabled={searchMatches.length === 0}
            hitSlop={6}
            style={styles.searchNav}
          >
            <Ionicons
              name="chevron-up"
              size={18}
              color={searchMatches.length ? theme.colors.primarySoft : theme.colors.textFaint}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => goToMatch(1)}
            disabled={searchMatches.length === 0}
            hitSlop={6}
            style={styles.searchNav}
          >
            <Ionicons
              name="chevron-down"
              size={18}
              color={searchMatches.length ? theme.colors.primarySoft : theme.colors.textFaint}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={closeSearch} hitSlop={6} style={styles.searchNav}>
            <Ionicons name="close" size={18} color={theme.colors.primarySoft} />
          </TouchableOpacity>
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        onContentSizeChange={autoScrollToBottom}
        onScroll={onMessagesScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIconBadge}>
              <Ionicons name="chatbubbles-outline" size={36} color={theme.colors.primaryMuted} />
            </View>
            <Text style={styles.emptyTitle}>开始聊天</Text>
            <Text style={styles.emptyText}>
              当前角色：{sessionOwnerMissing ? '角色资料缺失' : (character.name || 'EasyChat2 助手')}{'\n'}
              {sessionOwnerMissing
                ? '这段历史对话仍可查看，角色资料恢复后才能发送。'
                : !greetingReady
                  ? '先选择开场白，再开始发送消息。'
                  : '请先在“设置”里填写 API Key，然后输入消息。'}{'\n'}
            </Text>
            {!isGroup && !sessionOwnerMissing ? (
              <TouchableOpacity
                style={styles.emptyGreetingButton}
                onPress={() => openGreetingPicker(activeSessionId ? 'reselect' : 'new')}
                activeOpacity={0.8}
              >
                <Text style={styles.emptyGreetingButtonText}>选择开场白</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
          renderedMessages.map(message => {
            const speaker = message.speakerId ? characterMap.get(message.speakerId) : null;
            const selected = selectedMessageIdSet.has(String(message.id || ''));
            return (
              <Pressable
                key={message.id}
                onLongPress={!messageSelectionOpen ? () => {
                  if (message.image) openImageActions(message.image, message.id);
                  else startMessageSelection(message.id);
                } : undefined}
                onPress={messageSelectionOpen ? () => toggleSelectedMessage(message.id) : undefined}
                delayLongPress={350}
                disabled={!ready || isSending || message.pending}
                accessibilityRole="button"
                accessibilityLabel="长按选择消息"
                accessibilityState={{ selected }}
              >
                <View onLayout={event => onMessageLayout(message.id, event)}>
                  {message.role === SYSTEM_ERROR_ID ? (
                    <ErrorBubble
                      message={message}
                      rawError={errorRawRef.current[message.id]}
                      fullWidth={chatOptions.fullWidth}
                      selectionMode={messageSelectionOpen}
                      selected={selected}
                    />
                  ) : (
                    <MessageBubble
                      message={message}
                      rawText={rawTextById.get(message.id)}
                      characterName={
                        isGroup
                          ? ((speaker && speaker.name) || message.speakerName || displayName)
                          : (sessionOwnerMissing ? '角色资料缺失' : ((speaker && speaker.name) || message.speakerName || character.name))
                      }
                      characterAvatar={
                        isGroup
                          ? (
                            (speaker && speaker.avatarUri)
                            || (message.speakerName
                              ? (groupCharacters.find(item => item.name === message.speakerName) || {}).avatarUri
                              : '')
                            || groupAvatarUri
                            || ''
                          )
                          : (speaker ? (speaker.avatarUri || '') : (message.speakerId ? '' : character.avatarUri))
                      }
                      userAvatarUri={userAvatar}
                      onSlashCommand={onSlashCommand}
                      canRegenerate={!isGroup && regenerableIds.has(message.id)}
                      onRegenerate={onRegenerateMessage}
                       onEditUserMessage={!isGroup ? onEditUserMessage : undefined}
                      onSelectText={onSelectText}
                      onQuote={onQuoteMessage}
                      onPressQuote={onPressQuoteBlock}
                      onGenerateImage={generateInlineImage}
                      onBroadcast={broadcastMessage}
                      highlightKeyword={searchQuery.trim()}
                      isMatch={searchMatches.includes(message.id)}
                      isActiveMatch={focusedMessageId === message.id}
                      fullWidth={chatOptions.fullWidth}
                      richHtmlEnabled={chatOptions.richHtml !== false}
                      onReselectGreeting={sessionOwnerMissing ? undefined : () => openGreetingPicker('reselect')}
                      thinkingDisplay={thinkingDisplay}
                      overlayActions={!!bgUri}
                      selectionMode={messageSelectionOpen}
                      selected={selected}
                    />
                  )}
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>

      {quoteTarget ? (
        <View style={[styles.quoteBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
          <View style={styles.quoteBarBody}>
            <Text style={styles.quoteBarName} numberOfLines={1}>{quoteTarget.name || '原文'}</Text>
            <Text style={styles.quoteBarText} numberOfLines={1}>{quoteTarget.text}</Text>
          </View>
           <TouchableOpacity
             onPress={() => {
               if (!isSending && !sendLockRef.current) setQuoteTarget(null);
             }}
             disabled={isSending || !!sendLockRef.current}
             hitSlop={8}
             accessibilityLabel="取消引用"
           >
            <Ionicons name="close" size={16} color={theme.colors.textFaint} />
          </TouchableOpacity>
        </View>
      ) : null}
      {attachments.length > 0 ? (
        <View style={[styles.attachmentBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
          {attachments.map(item => (
            <View key={item.id} style={styles.attachmentChip}>
              {item.kind === 'image' && item.uri ? (
                <Image source={{ uri: item.uri }} style={styles.attachmentThumb} />
              ) : (
                <Ionicons name="document-text-outline" size={14} color={theme.colors.primarySoft} />
              )}
              <Text style={styles.attachmentName} numberOfLines={1}>{item.name}</Text>
               <TouchableOpacity
                 onPress={() => removeAttachment(item.id)}
                 disabled={isSending || !!sendLockRef.current}
                 hitSlop={6}
               >
                 <Ionicons name="close" size={14} color={theme.colors.textFaint} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}
      <View style={[styles.inputBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
        {messages.length > 0 && !messageSelectionOpen ? (
          <TouchableOpacity
            style={[styles.clearButton, isSending && styles.clearButtonDisabled]}
            onPress={onClear}
            disabled={isSending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="清空当前聊天"
            accessibilityState={{ disabled: isSending }}
          >
            <Text style={styles.clearText}>清空</Text>
          </TouchableOpacity>
        ) : null}
        {isGroup ? (
          <>
            <TouchableOpacity
              style={styles.attachButton}
              onPress={pickAttachmentMenu}
              disabled={inputDisabled}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="添加附件"
            >
              <Ionicons name="add-circle-outline" size={22} color={theme.colors.primarySoft} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.attachButton}
              onPress={() => setMentionPickerOpen(true)}
              disabled={inputDisabled}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="提及成员"
            >
              <Text style={styles.mentionButtonText}>{MENTION_PREFIX}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={styles.attachButton}
            onPress={pickAttachmentMenu}
            disabled={inputDisabled}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="添加附件"
          >
            <Ionicons name="add-circle-outline" size={22} color={theme.colors.primarySoft} />
          </TouchableOpacity>
        )}
        <TextInput
          style={[styles.input, bgUri && styles.inputOverlay, inputFocused && styles.inputFocused]}
          value={input}
          onChangeText={setInput}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          onSelectionChange={event => {
            inputSelectionRef.current = event.nativeEvent.selection;
          }}
          placeholder="输入消息..."
           placeholderTextColor={theme.colors.textFaint}
           multiline
           editable={!inputDisabled}
         />
         <TouchableOpacity
           style={styles.stickerButton}
           onPress={() => setStickerPanelOpen(true)}
           disabled={inputDisabled}
           activeOpacity={0.7}
           accessibilityRole="button"
           accessibilityLabel="表情包"
         >
           <Ionicons name="happy-outline" size={21} color={theme.colors.primarySoft} />
         </TouchableOpacity>
         <TouchableOpacity
           style={styles.fullScreenButton}
          onPress={() => {
            setFullScreenText(input);
            setFullScreenOpen(true);
          }}
          disabled={!ready || sessionOwnerMissing || (!isGroup && !greetingReady)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="全屏输入"
        >
          <Ionicons name="expand-outline" size={18} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        {isSending ? (
          <TouchableOpacity
            style={[styles.sendButton, styles.stopButton]}
            onPress={onStop}
            accessibilityLabel="停止"
            activeOpacity={0.8}
          >
            <Ionicons name="stop" size={18} color={theme.colors.text} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[
              styles.sendButton,
              (inputDisabled || (!input.trim() && attachments.length === 0)) && styles.sendButtonDisabled,
            ]}
            onPress={onSend}
            disabled={inputDisabled || (!input.trim() && attachments.length === 0)}
            accessibilityLabel="发送"
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-up" size={20} color={theme.colors.text} />
          </TouchableOpacity>
        )}
      </View>

      <Modal
        visible={stickerPanelOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setStickerPanelOpen(false)}
      >
        <View style={styles.stickerBackdrop}>
          <View style={styles.stickerSheet}>
            <View style={styles.stickerHeader}>
              <Text style={styles.stickerTitle}>表情包</Text>
              <TouchableOpacity
                onPress={() => setStickerPanelOpen(false)}
                hitSlop={8}
                accessibilityLabel="关闭表情包"
              >
                <Ionicons name="close" size={22} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.stickerScroll}
              contentContainerStyle={styles.stickerGrid}
              showsVerticalScrollIndicator={false}
            >
              <TouchableOpacity
                style={styles.stickerAddTile}
                onPress={addStickerFromPicker}
                disabled={stickerSaving}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="添加表情包"
              >
                <Ionicons name="add" size={25} color={theme.colors.primarySoft} />
                <Text style={styles.stickerAddText}>添加</Text>
              </TouchableOpacity>
              {stickers.map(sticker => (
                <TouchableOpacity
                  key={sticker.id}
                  style={styles.stickerTile}
                  onPress={() => sendSticker(sticker)}
                  disabled={inputDisabled || stickerSaving}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`发送表情包 ${sticker.name}`}
                >
                  <Image source={{ uri: sticker.uri }} style={styles.stickerImage} resizeMode="contain" />
                  <Text style={styles.stickerName} numberOfLines={1}>{sticker.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!stickerNamePrompt}
        transparent
        animationType="fade"
         onRequestClose={closeStickerNamePrompt}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>保存为表情包</Text>
            <TextInput
              style={styles.stickerNameInput}
              value={stickerNameDraft}
              onChangeText={setStickerNameDraft}
              placeholder="请输入表情包名称"
              placeholderTextColor={theme.colors.textFaint}
              autoFocus
              maxLength={40}
              editable={!stickerSaving}
            />
            <View style={styles.stickerNameActions}>
              <TouchableOpacity
                style={[styles.selectButton, styles.selectButtonGhost]}
                 onPress={closeStickerNamePrompt}
                disabled={stickerSaving}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.selectButton, stickerSaving && styles.sendButtonDisabled]}
                onPress={confirmStickerName}
                disabled={stickerSaving}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>{stickerSaving ? '保存中' : '保存'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={fullScreenOpen}
        animationType="slide"
        onRequestClose={() => setFullScreenOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.fullScreenContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.fullScreenHeader}>
            <Text style={styles.fullScreenTitle}>全屏输入</Text>
            <TouchableOpacity
              onPress={() => setFullScreenOpen(false)}
              hitSlop={8}
              accessibilityLabel="退出全屏"
            >
              <Ionicons name="close" size={24} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.fullScreenInput}
            value={fullScreenText}
            onChangeText={setFullScreenText}
            placeholder="输入消息..."
            placeholderTextColor={theme.colors.textFaint}
            multiline
            textAlignVertical="top"
            autoFocus
          />
          <TouchableOpacity
            style={[styles.fullScreenSend, !fullScreenText.trim() && styles.sendButtonDisabled]}
             onPress={async () => {
               const text = fullScreenText.trim();
               const draft = fullScreenText;
               const sessionGuard = captureSessionGuard();
               setFullScreenOpen(false);
               if (!text) {
                 setFullScreenText('');
                 return;
               }
               const sent = await sendMessage(text, [], sessionGuard);
               if (!isSessionGuardCurrent(sessionGuard)) return;
               if (sent) {
                 setFullScreenText('');
                 setInput('');
               } else {
                 setFullScreenText(draft);
               }
             }}
            disabled={!fullScreenText.trim()}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-up" size={18} color={theme.colors.text} />
            <Text style={styles.fullScreenSendText}>发送</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={switcherOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSwitcherOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setSwitcherOpen(false)}
        >
          <TouchableOpacity style={styles.modalSheet} activeOpacity={1} onPress={() => {}}>
            <Text style={styles.modalTitle}>选择角色或群聊</Text>
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
              {characters.map(item => {
                const selected = !isGroup && item.id === activeId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.modalRow, selected && styles.modalRowActive]}
                    onPress={() => onSwitch(item.id)}
                    activeOpacity={0.7}
                  >
                    {item.avatarUri ? (
                      <Image source={{ uri: item.avatarUri }} style={styles.modalRowAvatar} />
                    ) : (
                      <View style={styles.modalRowAvatarFallback}>
                        <Text style={styles.modalRowAvatarText}>
                          {(item.name || '?').charAt(0)}
                        </Text>
                      </View>
                    )}
                    <Text
                      style={[styles.modalRowText, selected && styles.modalRowTextActive]}
                      numberOfLines={1}
                    >
                      {item.name || '未命名角色'}
                    </Text>
                    {selected ? (
                      <View style={styles.modalBadge}>
                        <Ionicons name="checkmark" size={12} color={theme.colors.text} />
                        <Text style={styles.modalBadgeText}>当前</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
              {groupSessions.map(item => {
                const selected = item.id === activeSessionId;
                return (
                  <TouchableOpacity
                    key={`group-${item.id}`}
                    style={[styles.modalRow, selected && styles.modalRowActive]}
                    onPress={() => onSwitchGroup(item.id)}
                    activeOpacity={0.7}
                  >
                    {item.avatarUri ? (
                      <Image source={{ uri: item.avatarUri }} style={styles.modalRowAvatar} />
                    ) : (
                      <View style={[styles.modalRowAvatarFallback, styles.modalRowGroupFallback]}>
                        <Ionicons name="people" size={14} color={theme.colors.primarySoft} />
                      </View>
                    )}
                    <Text
                      style={[styles.modalRowText, selected && styles.modalRowTextActive]}
                      numberOfLines={1}
                    >
                      {groupSessionName(item)}
                    </Text>
                    {selected ? (
                      <View style={styles.modalBadge}>
                        <Ionicons name="checkmark" size={12} color={theme.colors.text} />
                        <Text style={styles.modalBadgeText}>当前</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={mentionPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMentionPickerOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setMentionPickerOpen(false)}
        >
          <TouchableOpacity style={styles.modalSheet} activeOpacity={1} onPress={() => {}}>
            <Text style={styles.modalTitle}>提及成员</Text>
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
              <TouchableOpacity
                style={styles.modalRow}
                onPress={() => {
                  setMentionPickerOpen(false);
                  insertMention(EVERYONE_MENTION);
                }}
                activeOpacity={0.7}
              >
                <View style={styles.modalRowAvatarFallback}>
                  <Ionicons name="people" size={14} color={theme.colors.primarySoft} />
                </View>
                <Text style={styles.modalRowText}>@{EVERYONE_MENTION}</Text>
              </TouchableOpacity>
              {groupCharacters.map(item => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.modalRow}
                  onPress={() => {
                    setMentionPickerOpen(false);
                    insertMention(String(item.name || '').trim());
                  }}
                  activeOpacity={0.7}
                >
                  {item.avatarUri ? (
                    <Image source={{ uri: item.avatarUri }} style={styles.modalRowAvatar} />
                  ) : (
                    <View style={styles.modalRowAvatarFallback}>
                      <Text style={styles.modalRowAvatarText}>
                        {(item.name || '?').charAt(0)}
                      </Text>
                    </View>
                  )}
                  <Text style={styles.modalRowText} numberOfLines={1}>
                    {item.name || '未命名角色'}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={!!selectionText}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectionText('')}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>选择文本</Text>
            <ScrollView style={styles.selectScroll} keyboardShouldPersistTaps="handled">
              <Text selectable style={styles.selectText}>{selectionText}</Text>
            </ScrollView>
            <View style={styles.selectActions}>
              <TouchableOpacity
                style={styles.selectButton}
                onPress={() => { Clipboard.setStringAsync(selectionText).catch(() => {}); }}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>复制</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.selectButton, styles.selectButtonGhost]}
                onPress={() => setSelectionText('')}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>关闭</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={moreOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMoreOpen(false)}
      >
        <TouchableOpacity
          style={styles.moreBackdrop}
          activeOpacity={1}
          onPress={() => setMoreOpen(false)}
        >
          <View style={styles.moreSheet}>
            {[
              {
                key: 'notice',
                label: '公告',
                icon: 'megaphone-outline',
                onPress: () => setNoticeOpen(true),
              },
              {
                key: 'model',
                label: '模型',
                icon: 'cube-outline',
                onPress: openModelPanel,
              },
              {
                key: 'thinking',
                label: '思考',
                icon: 'bulb-outline',
                onPress: openThinkingPanel,
              },
              {
                key: 'scrubber',
                label: '定位',
                icon: 'options-outline',
                disabled: scrubberMessages.length === 0,
                onPress: () => setScrubberOpen(true),
              },
              {
                key: 'search',
                label: '搜索',
                icon: 'search',
                active: searchOpen,
                onPress: () => (searchOpen ? closeSearch() : setSearchOpen(true)),
              },
              {
                key: 'summary',
                label: summarizing ? '总结中' : '总结',
                icon: 'book-outline',
                disabled: summarizing || !ready,
                onPress: onSummarize,
              },
              {
                key: 'settings',
                label: '设置',
                icon: 'settings-outline',
                onPress: () => setChatSettingsOpen(true),
              },
            ].map(item => (
              <TouchableOpacity
                key={item.key}
                style={[styles.moreRow, item.disabled && styles.actionDisabled]}
                disabled={item.disabled}
                onPress={() => {
                  setMoreOpen(false);
                  if (typeof item.onPress === 'function') item.onPress();
                }}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={item.icon}
                  size={16}
                  color={item.active ? theme.colors.primary : theme.colors.primaryMuted}
                />
                <Text style={[styles.moreRowText, item.active && styles.moreRowTextActive]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={chatSettingsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setChatSettingsOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setChatSettingsOpen(false)}
        >
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>聊天设置</Text>
            <TouchableOpacity
              style={styles.linkRow}
              onPress={() => {
                setChatSettingsOpen(false);
                if (navigation) navigation.navigate('设置');
              }}
              activeOpacity={0.7}
            >
              <View style={styles.linkLeft}>
                <Ionicons name="settings-outline" size={17} color={theme.colors.primaryMuted} />
                <Text style={styles.chatSettingsText}>系统设置</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.linkRow}
              onPress={() => {
                setChatSettingsOpen(false);
                if (isGroup) setGroupEditOpen(true);
                else setCharacterEditOpen(true);
              }}
              activeOpacity={0.7}
            >
              <View style={styles.linkLeft}>
                <Ionicons name="create-outline" size={17} color={theme.colors.primaryMuted} />
                <Text style={styles.chatSettingsText}>{isGroup ? '编辑群聊' : '编辑角色'}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <CharacterEditForm
        visible={characterEditOpen}
        character={character}
        onClose={() => setCharacterEditOpen(false)}
        onSaved={() => {
          setCharacterEditOpen(false);
          Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');
        }}
      />

      <GroupEditForm
        visible={groupEditOpen}
        session={activeSession}
        members={groupCharacters}
        onClose={() => setGroupEditOpen(false)}
        onSaved={() => {
          setGroupEditOpen(false);
          refreshSessions().catch(() => {});
          Alert.alert('已保存', '群聊信息已更新。');
        }}
      />

      <GreetingPickerModal
        visible={!!greetingPicker}
        mode="select"
        candidates={greetingPicker ? greetingPicker.candidates : []}
        initialSelectedIndex={greetingPicker ? greetingPicker.initialSelectedIndex : undefined}
        onCancel={() => setGreetingPicker(null)}
        onConfirm={confirmGreeting}
      />

      <DisclaimerModal
        visible={noticeOpen}
        title="公告"
        onClose={() => setNoticeOpen(false)}
      />

      <Modal
        visible={modelPanelOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setModelPanelOpen(false)}
      >
        <Pressable
          style={styles.modelBackdrop}
          onPress={() => setModelPanelOpen(false)}
        >
          <Pressable style={styles.modelSheet} onPress={() => {}}>
            <Text style={styles.modelTitle}>切换模型</Text>
            <Text style={styles.modelLabel}>来源</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.modelSourceRow}>
                {apiConfigs.map(config => {
                  const selected = config.id === modelSourceId;
                  return (
                    <TouchableOpacity
                      key={config.id}
                       style={[styles.modelSourceChip, selected && styles.modelSourceChipActive, isSending && styles.actionDisabled]}
                       onPress={() => setModelSourceId(config.id)}
                       disabled={isSending}
                       activeOpacity={0.8}
                    >
                      <Text
                        style={[styles.modelSourceText, selected && styles.modelSourceTextActive]}
                        numberOfLines={1}
                      >
                        {config.name || '未命名配置'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
            <Text style={styles.modelLabel}>模型</Text>
            <ScrollView style={styles.modelListScroll}>
              {(() => {
                const source = apiConfigs.find(item => item.id === modelSourceId);
                const models = (source && source.models) || [];
                if (models.length === 0) {
                  return <Text style={styles.modelEmpty}>该来源没有模型。</Text>;
                }
                return models.map(model => {
                  const isActive = source.activeModel === model;
                  return (
                    <TouchableOpacity
                      key={model}
                       style={[styles.modelOption, isSending && styles.actionDisabled]}
                       onPress={() => applyModelSelection(source.id, model)}
                       disabled={isSending}
                       activeOpacity={0.8}
                    >
                      <Text style={styles.modelOptionText} numberOfLines={1}>{model}</Text>
                      {isActive ? (
                        <Ionicons name="checkmark" size={16} color={theme.colors.primaryMuted} />
                      ) : null}
                    </TouchableOpacity>
                  );
                });
              })()}
            </ScrollView>
            <TouchableOpacity
              style={styles.modelClose}
              onPress={() => setModelPanelOpen(false)}
              activeOpacity={0.8}
            >
              <Text style={styles.modelCloseText}>关闭</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={thinkingOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setThinkingOpen(false)}
      >
        <Pressable
          style={styles.modelBackdrop}
          onPress={() => setThinkingOpen(false)}
        >
          <Pressable style={styles.modelSheet} onPress={() => {}}>
            <Text style={styles.modelTitle}>思考设置</Text>
            {!thinkingSupported ? (
              <Text style={styles.modelEmpty}>
                当前来源未标记为支持思考，请在设置中确认模型能力。
              </Text>
            ) : null}
            <View style={styles.thinkingRow}>
              <Text style={styles.thinkingLabel}>开启思考</Text>
              <Switch
                value={thinkingEnabled}
                onValueChange={value => applyThinking({ enabled: value })}
                disabled={!thinkingSupported}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>
            <Text style={styles.modelLabel}>思考深度</Text>
            <View style={styles.thinkingLevels}>
              {THINKING_LEVELS.map(level => {
                const active = thinkingLevel === level;
                const disabled = !thinkingSupported || !thinkingEnabled;
                return (
                  <TouchableOpacity
                    key={level}
                    style={[
                      styles.thinkingLevelChip,
                      active && styles.thinkingLevelChipActive,
                      disabled && styles.actionDisabled,
                    ]}
                    disabled={disabled}
                    onPress={() => applyThinking({ level })}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.thinkingLevelText,
                        active && styles.thinkingLevelTextActive,
                      ]}
                    >
                      {THINKING_LEVEL_LABELS[level]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.modelLabel}>思考内容展示</Text>
            <View style={styles.thinkingLevels}>
              {THINKING_DISPLAYS.map(display => {
                const active = thinkingDisplay === display;
                const disabled = !thinkingSupported || !thinkingEnabled;
                return (
                  <TouchableOpacity
                    key={display}
                    style={[
                      styles.thinkingLevelChip,
                      active && styles.thinkingLevelChipActive,
                      disabled && styles.actionDisabled,
                    ]}
                    disabled={disabled}
                    onPress={() => applyThinking({ display })}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.thinkingLevelText,
                        active && styles.thinkingLevelTextActive,
                      ]}
                    >
                      {THINKING_DISPLAY_LABELS[display]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              style={styles.modelClose}
              onPress={() => setThinkingOpen(false)}
              activeOpacity={0.8}
            >
              <Text style={styles.modelCloseText}>关闭</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <ScrollScrubber
        visible={scrubberOpen}
        onClose={() => setScrubberOpen(false)}
        messageCount={scrubberMessages.length}
        previews={scrubberPreviews}
        onSeek={onScrubberSeek}
        onToStart={onScrubberToStart}
        onToEnd={onScrubberToEnd}
      />
    </KeyboardAvoidingView>
  );
}

const createChatStyles = (theme, fonts, tokens) => StyleSheet.create({
  aiNoticeBar: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 2,
    alignItems: 'center',
  },
  aiNoticeText: {
    color: theme.colors.textFaint,
    fontSize: 11,
    opacity: 0.7,
    textAlign: 'center',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
    backgroundColor: hexToRgba(theme.colors.background, theme.id === 'light' ? 0.92 : 0.85),
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  selectionAction: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 62,
    paddingVertical: 6,
    paddingHorizontal: tokens.spacing.sm,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primaryAlpha(0.12),
  },
  selectionActionText: {
    color: theme.colors.primarySoft,
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 4,
  },
  selectionDeleteText: {
    color: theme.colors.danger,
  },
  selectionCount: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  characterChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: tokens.spacing.sm,
    paddingVertical: 5,
    paddingHorizontal: tokens.spacing.sm,
    borderRadius: tokens.radius.bubble,
    backgroundColor: theme.colors.primaryAlpha(0.12),
  },
  characterAvatar: { width: 26, height: 26, borderRadius: tokens.radius.pill, marginRight: tokens.spacing.sm, borderWidth: tokens.border.thin, borderColor: theme.colors.primaryMutedAlpha(0.35) },
  characterAvatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceBorder },
  characterName: { color: theme.colors.text, fontWeight: '700', flexShrink: 1 },
  characterCaret: { marginLeft: 6 },
  noticeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.45),
    backgroundColor: theme.colors.primaryAlpha(0.12),
    borderRadius: tokens.radius.md,
    paddingVertical: 5,
    paddingHorizontal: tokens.spacing.sm + 2,
  },
  noticeButtonText: { color: theme.colors.primarySoft, fontSize: 12, fontWeight: '700', marginLeft: tokens.spacing.xs },
  actionDisabled: { opacity: 0.5 },
  modelBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  modelSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    padding: tokens.metrics.cardPadding,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    maxHeight: '75%',
  },
  modelTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '800', marginBottom: 10 },
  modelLabel: { color: theme.colors.textFaint, fontSize: 12, marginTop: tokens.spacing.sm, marginBottom: 6 },
  modelSourceRow: { flexDirection: 'row' },
  modelSourceChip: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: 7,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginRight: tokens.spacing.sm,
    maxWidth: 140,
  },
  modelSourceChipActive: { backgroundColor: theme.colors.primaryAlpha(0.2), borderColor: theme.colors.primary },
  modelSourceText: { color: theme.colors.textMuted, fontSize: 12, fontWeight: '700' },
  modelSourceTextActive: { color: theme.colors.primarySoft },
  modelListScroll: { maxHeight: 240, marginTop: 2 },
  modelOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.surface,
  },
  modelOptionText: { color: theme.colors.text, fontSize: 14, flex: 1, marginRight: tokens.spacing.sm },
  modelEmpty: { color: theme.colors.textFaint, fontSize: 13, paddingVertical: tokens.spacing.md },
  modelClose: {
    marginTop: tokens.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm + 2,
    paddingVertical: 10,
    alignItems: 'center',
  },
  modelCloseText: { color: theme.colors.primarySoft, fontSize: 14, fontWeight: '700' },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: tokens.spacing.md,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.surface,
  },
  thinkingLabel: { color: theme.colors.text, fontSize: 15, fontWeight: '700' },
  thinkingLevels: { flexDirection: 'row', marginTop: tokens.spacing.xs },
  thinkingLevelChip: {
    paddingHorizontal: tokens.spacing.lg + 2,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginRight: tokens.spacing.sm,
  },
  thinkingLevelChipActive: {
    backgroundColor: theme.colors.primaryAlpha(0.2),
    borderColor: theme.colors.primary,
  },
  thinkingLevelText: { color: theme.colors.textMuted, fontSize: 13, fontWeight: '700' },
  thinkingLevelTextActive: { color: theme.colors.primarySoft },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
    paddingHorizontal: 14,
    paddingVertical: tokens.spacing.sm,
  },
  searchInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 14,
    paddingVertical: 6,
    marginLeft: tokens.spacing.sm,
  },
  searchCount: { color: theme.colors.textFaint, fontSize: 12, marginHorizontal: tokens.spacing.sm },
  searchNav: { paddingHorizontal: tokens.spacing.xs },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: tokens.spacing.xl,
  },
  modalSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    padding: tokens.metrics.cardPadding,
    maxHeight: '70%',
    ...tokens.elevation(2, theme),
  },
  modalTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '800', marginBottom: tokens.spacing.md },
  moreBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'flex-end',
    paddingTop: 64,
    paddingRight: tokens.spacing.md,
  },
  moreSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md + 2,
    paddingVertical: 6,
    minWidth: 168,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    ...tokens.elevation(2, theme),
  },
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  moreRowText: { color: theme.colors.textMuted, fontSize: 14, marginLeft: tokens.spacing.sm + 2 },
  moreRowTextActive: { color: theme.colors.primary },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  linkLeft: { flexDirection: 'row', alignItems: 'center' },
  chatSettingsText: { color: theme.colors.textMuted, fontSize: 15, marginLeft: tokens.spacing.sm + 2 },
  chatSettingsHint: { color: theme.colors.textFaint, fontSize: 13 },
  modalList: { maxHeight: 360 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    paddingVertical: 10,
    paddingHorizontal: tokens.spacing.md,
    marginBottom: tokens.spacing.sm,
  },
  modalRowActive: { borderWidth: tokens.border.thin, borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.16) },
  modalRowAvatar: { width: tokens.metrics.avatarSm, height: tokens.metrics.avatarSm, borderRadius: tokens.radius.pill, marginRight: 10 },
  modalRowAvatarFallback: {
    width: tokens.metrics.avatarSm,
    height: tokens.metrics.avatarSm,
    borderRadius: tokens.radius.pill,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
  },
  modalRowAvatarText: { color: theme.colors.text, fontSize: 14, fontWeight: '800' },
  modalRowGroupFallback: { backgroundColor: theme.colors.surfaceBorder },
  modalRowText: { color: theme.colors.textMuted, flex: 1, marginRight: 8 },
  modalRowTextActive: { color: theme.colors.text, fontWeight: '700' },
  modalBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.radius.sm,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  modalBadgeText: { color: theme.colors.text, fontSize: 11, fontWeight: '700', marginLeft: 2 },
  selectScroll: { maxHeight: 360, marginBottom: 12 },
  selectText: { color: theme.colors.text, fontSize: 15, lineHeight: 22 },
  selectActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  selectButton: {
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: 9,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.primary,
    marginLeft: tokens.spacing.sm,
  },
  selectButtonGhost: {
    backgroundColor: theme.colors.surface,
  },
  selectButtonText: { color: theme.colors.text, fontWeight: '700' },
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    flexGrow: 1,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacing.xl,
  },
  emptyIconBadge: {
    width: 76,
    height: 76,
    borderRadius: tokens.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.14),
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
    marginBottom: tokens.spacing.lg,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 8,
  },
  emptyText: {
    color: theme.colors.textFaint,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  emptyGreetingButton: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 18,
    backgroundColor: theme.colors.primaryAlpha(0.14),
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  emptyGreetingButtonText: {
    color: theme.colors.primarySoft,
    fontSize: 13,
    fontWeight: '700',
  },
  messageRow: {
    marginVertical: 5,
    flexDirection: 'row',
  },
   messageRowLeft: {
     justifyContent: 'flex-start',
   },
   messageRowFullWidth: {
     flexDirection: 'column',
     alignSelf: 'stretch',
     marginHorizontal: -14,
   },
   messageRowRight: {
    justifyContent: 'flex-end',
  },
  avatarContainer: {
    width: 36,
    height: 36,
    borderRadius: tokens.radius.pill,
    marginRight: tokens.spacing.sm,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    marginTop: tokens.spacing.lg,
    borderWidth: tokens.border.thick,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
  },
   avatarContainerFullWidth: {
     marginTop: 0,
     marginRight: tokens.spacing.sm,
   },
   fullWidthMessageHeader: {
     width: '100%',
     flexDirection: 'row',
     alignItems: 'center',
     paddingHorizontal: 14,
     marginBottom: 3,
   },
   fullWidthNameLabel: {
     color: theme.colors.text,
     fontSize: 11,
     fontWeight: '700',
     flexShrink: 1,
   },
   avatarContainerRight: {
    width: 36,
    height: 36,
    borderRadius: tokens.radius.pill,
    marginLeft: tokens.spacing.sm,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    marginTop: tokens.spacing.lg,
    borderWidth: tokens.border.thick,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
  },
  avatarImage: {
    width: 32,
    height: 32,
    borderRadius: tokens.radius.lg,
  },
  avatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: tokens.radius.lg,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderUser: {
    width: 32,
    height: 32,
    borderRadius: tokens.radius.lg,
    backgroundColor: theme.colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: {
    color: theme.colors.text,
    fontWeight: '800',
    fontSize: 14,
  },
  messageContent: {
    maxWidth: '92%',
  },
   messageContentFullWidth: {
     maxWidth: '100%',
     minWidth: 0,
     flex: 1,
     flexBasis: 0,
   },
   messageContentFullWidthColumn: {
     width: '100%',
     maxWidth: '100%',
     minWidth: 0,
     alignSelf: 'stretch',
   },
  mediaBubble: {
    padding: 4,
    backgroundColor: theme.colors.surface,
  },
  userMediaBox: {
    alignItems: 'center',
  },
   userMessageImage: {
     maxWidth: '100%',
     borderRadius: tokens.radius.md,
     backgroundColor: theme.colors.surfaceBorder,
   },
  userMediaName: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(10),
    marginTop: 3,
    maxWidth: '100%',
  },
   inlineImageWrap: {
     marginTop: 6,
     maxWidth: '92%',
   },
   inlineImageFullWidth: {
     width: '100%',
     maxWidth: '100%',
   },
  inlineImageBox: {
    borderRadius: tokens.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: tokens.spacing.lg + 2,
    paddingHorizontal: tokens.spacing.lg,
    borderWidth: tokens.border.thin,
  },
  inlineImageLoading: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.divider,
  },
  inlineImageError: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.danger,
  },
  inlineImageHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginTop: 6,
    textAlign: 'center',
  },
  inlineImageRetry: {
    marginTop: 10,
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: 7,
  },
  inlineImageRetryText: {
    color: theme.colors.primaryContrast,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
  },
  inlineImage: {
    width: 220,
    height: 300,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
  },
  quoteBlock: {
    borderLeftWidth: 3,
    borderRadius: tokens.radius.xs + 2,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 6,
    marginBottom: tokens.spacing.sm,
  },
  quoteBlockUser: {
    borderLeftColor: theme.colors.primarySoft,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  quoteBlockAssistant: {
    borderLeftColor: theme.colors.primary,
    backgroundColor: theme.colors.primaryAlpha(0.1),
  },
  quoteName: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
  quoteNameUser: { color: '#f0efff' },
  quoteNameAssistant: { color: theme.colors.primary },
  quoteText: { fontSize: 12, lineHeight: 17 },
  quoteTextUser: { color: '#e8e6ff' },
  quoteTextAssistant: { color: theme.colors.textMuted },
  quoteBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: tokens.spacing.sm,
    paddingBottom: 6,
  },
  quoteBarBody: {
    flex: 1,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.primary,
    paddingLeft: tokens.spacing.sm,
    marginRight: tokens.spacing.sm,
  },
  quoteBarName: { color: theme.colors.primaryMuted, fontSize: 11, fontWeight: '700' },
  quoteBarText: { color: theme.colors.textFaint, fontSize: 12, marginTop: 2 },
  nameLabel: {
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 2,
    marginLeft: 2,
  },
  reasoningBox: {
    backgroundColor: theme.colors.primaryAlpha(0.1),
    borderRadius: tokens.radius.sm + 2,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: tokens.spacing.sm,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  reasoningBoxCollapsed: { paddingVertical: tokens.spacing.xs + 1 },
  reasoningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: tokens.spacing.xs,
  },
  reasoningHeaderCollapsed: { marginBottom: 0 },
  reasoningLabel: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 4,
    marginRight: 4,
  },
  reasoningText: {
    color: theme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  messageActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: tokens.spacing.xs,
  },
  messageActionsLeft: {
    justifyContent: 'flex-start',
  },
  messageActionsRight: {
    justifyContent: 'flex-end',
  },
  messageActionButton: {
    paddingHorizontal: 10,
    paddingVertical: tokens.spacing.xs,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
    marginRight: 6,
    marginTop: tokens.spacing.xs,
  },
  messageActionButtonOverlay: {
    backgroundColor: 'rgba(45,45,68,0.30)',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  messageActionText: {
    color: theme.colors.primarySoft,
    fontSize: 12,
    fontWeight: '700',
  },
  greetingReselectButton: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
  },
  greetingReselectText: {
    color: theme.colors.primarySoft,
    fontSize: 12,
    fontWeight: '700',
  },
  markdownCodeScroll: {
    maxWidth: '100%',
  },
  markdownTableScroll: {
    maxWidth: '100%',
  },
  bubble: {
    maxWidth: '95%',
    borderRadius: tokens.radius.bubble,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...tokens.elevation(1, theme),
  },
  bubbleBounded: {
    maxWidth: '95%',
  },
  bubbleFullWidth: {
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    flexShrink: 1,
    alignSelf: 'stretch',
  },
  userBubble: {
    backgroundColor: theme.colors.primary,
    borderBottomRightRadius: 6,
  },
  assistantBubble: {
    backgroundColor: theme.colors.bubbleAssistant,
    borderBottomLeftRadius: 6,
  },
  bubbleMatch: {
    borderWidth: 2,
    borderColor: 'rgba(242,193,78,0.9)',
  },
  bubbleActiveMatch: {
    borderWidth: 2,
    borderColor: '#ff8c42',
  },
  bubbleSelected: {
    borderWidth: 2,
    borderColor: theme.colors.primary,
  },
  thinkingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 28,
  },
  thinkingText: {
    color: theme.colors.textFaint,
    fontSize: 14,
    lineHeight: 22,
    marginRight: 6,
  },
  thinkingDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginLeft: 4,
    backgroundColor: theme.colors.primary,
  },
  panelButton: {
    marginTop: 6,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#344f5d',
  },
  panelButtonPressed: {
    opacity: 0.75,
  },
  panelButtonText: {
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 18,
  },
  errorBubbleBounded: {
     backgroundColor: theme.id === 'light' ? '#fde8e8' : '#3a1719',
     borderColor: theme.colors.danger,
     borderWidth: tokens.border.thin,
     borderBottomLeftRadius: 6,
     maxWidth: '92%',
   },
   errorBubbleFullWidth: {
     backgroundColor: theme.id === 'light' ? '#fde8e8' : '#3a1719',
     borderColor: theme.colors.danger,
     borderWidth: tokens.border.thin,
     borderBottomLeftRadius: 6,
     maxWidth: '100%',
   },
  errorBadge: {
    color: theme.colors.danger,
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 6,
  },
  errorSummary: {
    color: theme.id === 'light' ? '#991b1b' : '#ffcdd2',
    fontSize: 15,
    lineHeight: 21,
  },
  errorDetail: {
    color: theme.id === 'light' ? '#b91c1c' : '#ef9a9a',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
  },
  errorActions: {
    marginTop: 10,
    alignItems: 'flex-end',
  },
  copyButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: tokens.metrics.buttonRadius,
    backgroundColor: theme.colors.danger,
  },
  copyButtonText: {
    color: theme.colors.primaryContrast,
    fontSize: 12,
    fontWeight: '700',
  },
  messageText: {
    color: theme.colors.text,
    fontSize: 15,
    lineHeight: 21,
  },
  highlightText: {
    backgroundColor: 'rgba(255,214,102,0.6)',
    color: '#3a2a00',
    fontWeight: '700',
  },
  attachmentBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginRight: 8,
    marginBottom: 6,
    maxWidth: 220,
  },
  attachmentThumb: { width: 20, height: 20, borderRadius: tokens.spacing.xs, marginRight: 6 },
  stickerButton: {
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  stickerBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  stickerSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: tokens.radius.lg,
    borderTopRightRadius: tokens.radius.lg,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
    maxHeight: '72%',
  },
  stickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  stickerTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  stickerScroll: {
    maxHeight: 360,
  },
  stickerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  stickerAddTile: {
    width: 78,
    height: 92,
    marginRight: 10,
    marginBottom: 10,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.1),
  },
  stickerAddText: {
    color: theme.colors.primarySoft,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  stickerTile: {
    width: 78,
    height: 92,
    marginRight: 10,
    marginBottom: 10,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 5,
  },
  stickerImage: {
    width: 62,
    height: 62,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surfaceBorder,
  },
  stickerName: {
    color: theme.colors.textFaint,
    fontSize: 10,
    maxWidth: 66,
    marginTop: 3,
  },
  stickerNameInput: {
    minHeight: 44,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  stickerNameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 14,
  },
  attachmentName: { color: theme.colors.textMuted, fontSize: 12, flexShrink: 1, marginRight: 6, marginLeft: 4 },
  attachButton: { paddingHorizontal: 6, paddingVertical: 6 },
  mentionButtonText: {
    color: theme.colors.primarySoft,
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
    paddingHorizontal: 4,
  },
  fullScreenButton: { paddingHorizontal: 6, paddingVertical: 6 },
  fullScreenContainer: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 48 },
  fullScreenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.surface,
  },
  fullScreenTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '800' },
  fullScreenInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 16,
    lineHeight: 23,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 14,
  },
  fullScreenSend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 16,
    marginBottom: 20,
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 12,
  },
  fullScreenSendText: { color: theme.colors.text, fontSize: 15, fontWeight: '700', marginLeft: 6 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: tokens.spacing.md,
    paddingTop: tokens.spacing.sm + 2,
    paddingBottom: tokens.spacing.md,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
  },
  inputBarSurface: {
    backgroundColor: theme.colors.background,
  },
  inputBarOverlay: {
    backgroundColor: 'rgba(20,20,34,0.26)',
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 110,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    color: theme.colors.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  inputFocused: {
    borderColor: theme.colors.primaryMuted,
  },
  inputOverlay: {
    backgroundColor: 'rgba(45,45,68,0.28)',
    borderColor: 'rgba(255,255,255,0.22)',
  },
  sendButton: {
    marginLeft: tokens.spacing.sm,
    width: 44,
    height: 44,
    borderRadius: tokens.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    ...tokens.elevation(2, theme),
    shadowColor: theme.colors.primary,
  },
  sendButtonDisabled: {
    opacity: tokens.opacity.disabled,
    elevation: 0,
    shadowOpacity: 0,
  },
  stopButton: {
    backgroundColor: theme.colors.danger,
    shadowColor: theme.colors.danger,
  },
  clearButton: {
    marginRight: tokens.spacing.sm,
    height: 44,
    borderRadius: tokens.radius.pill,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  clearButtonDisabled: {
    opacity: tokens.opacity.disabled,
  },
  clearText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
});
