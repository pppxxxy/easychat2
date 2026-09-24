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
import Ionicons from '@expo/vector-icons/Ionicons';
import Markdown from 'react-native-markdown-display';
import RenderHtml, { HTMLContentModel, HTMLElementModel } from 'react-native-render-html';

import { isCanceledError, sendChatMessage } from './api';
import {
  isImage,
  isTextLike,
  mergeTextAttachments,
  pickAttachment,
  readImageDataUri,
  readTextAttachment,
} from './attachments';
import { buildRequestMessages } from './chatPipeline';
import { isGreetingMessage, listGreetingCandidates } from './cardGreetings';
import {
  applySummary,
  buildMemorySummaryText,
  isSessionScopedMemory,
  selectManualSummarizable,
  selectSummarizable,
  shouldSummarize,
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
  getThinkingSettings,
  getUserProfile,
  saveApiConfigs,
  saveMessagesBySession,
  saveThinkingSettings,
  getTtsSettings,
  getMomentsSettings,
  getAffinityStatus,
  saveAffinity,
  getMomentsStatus,
  saveMoments,
  saveTtsSettings,
  setSessionGreetingSelected,
  startNewSession,
  THINKING_DISPLAYS,
  THINKING_LEVELS,
  updateSessionMemberProfiles,
  getVectorMemoryConfig,
  getVectorIndex,
  saveVectorIndex,
} from './storage';
import { runPlugins } from './plugins/registry';
import {
  buildMemoryContext,
  indexMessages,
  retrieve,
} from './vectorMemory';
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

const HTML_TAG_PATTERN = /<\/?(?:div|span|blockquote|q|section|article|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|hr|br|b|i|u|strong|em|font|img|a|code|pre|audio|video)\b[^>]*>/i;

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

function containsHtml(text) {
  return HTML_TAG_PATTERN.test(String(text || ''));
}

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

function toPlainText(text) {
  let out = String(text || '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(?:p|div|h[1-6]|li|tr|section|article)>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');
  out = out.replace(/&nbsp;/gi, ' ');
  out = out.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  out = out.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  out = out.replace(/&amp;/gi, '&');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function messageCopyText(text) {
  return containsHtml(text) ? toPlainText(text) : String(text || '');
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

const MessageBubble = React.memo(function MessageBubble({ message, rawText, characterName, characterAvatar, userAvatarUri, onSlashCommand, canRegenerate, onRegenerate, onEditUserMessage, onSelectText, onQuote, onPressQuote, onGenerateImage, onBroadcast, highlightKeyword, isMatch, isActiveMatch, fullWidth, thinkingDisplay, overlayActions, richHtmlEnabled, onReselectGreeting }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const markdownStyles = useMemo(() => createMarkdownStyles(theme, fonts, tokens), [theme, fonts, tokens]);
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
  const onCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {}
  }, [plainText]);
  const contentWidth = Math.max(200, Math.floor((width - 28) * 0.88) - 28);
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
    <View style={styles.avatarContainer}>
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

  return (
    <View style={[styles.messageRow, isUser ? styles.messageRowRight : styles.messageRowLeft]}>
      {!isUser ? avatarElement : null}
      <View style={[
        styles.messageContent,
        (fullWidth || renderRichHtml) ? styles.messageContentFullWidth : null,
      ]}>
        {!isUser ? <Text style={styles.nameLabel}>{characterName || ''}</Text> : null}
        <View style={[
          styles.bubble,
          (fullWidth || renderRichHtml) ? styles.bubbleFullWidth : styles.bubbleBounded,
          isUser ? styles.userBubble : styles.assistantBubble,
          isMatch ? styles.bubbleMatch : null,
          isActiveMatch ? styles.bubbleActiveMatch : null,
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
          {isUser ? (
            <Text style={styles.messageText}>
              {highlightKeyword ? renderHighlightedText(message.text, highlightKeyword, styles) : message.text}
            </Text>
          ) : message.pending && message.waitingForResponse ? (
            <ThinkingIndicator />
          ) : renderRichHtml ? (
            <RichHtmlMessage html={message.text} onCommand={onSlashCommand} />
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
            <Markdown style={markdownStyles}>{message.text}</Markdown>
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
          <View style={styles.inlineImageWrap}>
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
        {!message.pending ? (
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
            {isUser ? (
              <TouchableOpacity
                style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
                onPress={() => onEditUserMessage?.(message.id)}
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

function ErrorBubble({ message, rawError, onCopied, fullWidth }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    const payload = rawError || message.detail || message.text || '';
    try {
      await Clipboard.setStringAsync(payload);
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {}
  }, [message.detail, message.text, onCopied, rawError]);

  return (
    <View style={[styles.messageRow, styles.messageRowLeft]}>
      <View style={[styles.bubble, fullWidth ? styles.bubbleFullWidth : styles.bubbleBounded, styles.errorBubble]}>
        <Text style={styles.errorBadge}>系统报错</Text>
        <TouchableOpacity onPress={() => setExpanded(current => !current)} activeOpacity={0.8}>
          <Text style={styles.errorSummary}>请求失败，点击查看详情</Text>
        </TouchableOpacity>
        {expanded ? (
          <Text style={styles.errorDetail} selectable>
            {maskSecrets(message.detail || message.text || '')}
          </Text>
        ) : null}
        <View style={styles.errorActions}>
          <TouchableOpacity style={styles.copyButton} onPress={onCopy}>
            <Text style={styles.copyButtonText}>{copied ? '已复制' : '复制报错'}</Text>
          </TouchableOpacity>
        </View>
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
  const sessionVersionRef = useRef(0);
  const [input, setInput] = useState('');
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const inputSelectionRef = useRef({ start: 0, end: 0 });
  const [inputFocused, setInputFocused] = useState(false);
  const [messages, setMessages] = useState([]);
  const [greetingReady, setGreetingReady] = useState(false);
  const [isSending, setIsSending] = useState(false);
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
  const [ttsSettings, setTtsSettings] = useState({ enabled: false, activeProvider: 'system', providers: {} });
  const [fullScreenOpen, setFullScreenOpen] = useState(false);
  const [fullScreenText, setFullScreenText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [focusedMessageId, setFocusedMessageId] = useState('');
  const [quoteTarget, setQuoteTarget] = useState(null);
  const navigation = useNavigation();

  const onSwitch = useCallback(id => {
    setSwitcherOpen(false);
    // 群聊会话下 activeCharacterIdRef 仍是上次单聊角色，此时点同一角色也要切回其会话。
    if (id === activeCharacterIdRef.current && !isGroupRef.current) return;
    activeCharacterIdRef.current = id;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsSending(false);
    setQuoteTarget(null);
    setAttachments([]);
    switchCharacter(id)
      .then(() => ensureCharacterSession(id))
      .catch(() => {
        activeCharacterIdRef.current = characterId;
        Alert.alert('切换失败', '请检查存储空间或权限。');
      });
  }, [switchCharacter, ensureCharacterSession, characterId]);

  const onSwitchGroup = useCallback(id => {
    setSwitcherOpen(false);
    if (id === activeSessionIdRef.current) return;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsSending(false);
    setQuoteTarget(null);
    setAttachments([]);
    switchSession(id).catch(() => {
      Alert.alert('切换失败', '请检查存储空间或权限。');
    });
  }, [switchSession]);

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
    if (!loaded) return;
    activeCharacterIdRef.current = characterId;
    activeSessionIdRef.current = activeSessionId;
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
            '本次没能读出该会话的消息（可能因数据过大）。原内容已自动备份，未丢失；继续发送会以新记录覆盖原消息。'
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
            (async () => {
              try {
                const [profile, presets] = await Promise.all([
                  getUserProfile().catch(() => null),
                  getEnabledGlobalPresetPrompts().catch(() => []),
                ]);
                const opening = await generateOpening({
                  characters: members,
                  userProfile: profile,
                  globalPresets: presets,
                });
                if (cancelled || !opening) return;
                if (activeSessionIdRef.current !== openingSessionId) return;
                setMessages([{
                  id: `${Date.now()}-opening`,
                  role: ASSISTANT_ID,
                  text: opening.opening,
                  speakerId: opening.speakerId,
                  speakerName: opening.speakerName,
                  timestamp: Date.now(),
                }]);
              } catch (error) {}
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
    const indexedCharacterId = character.id || 'default';
    const messagesToIndex = persistableMessages;
    // 会话条目若已从存储里缺失（历史版本的 startNewSession 会误删），
    // 把归属角色一并传下去，让本次写盘把会话行补回来；群聊没有单一归属角色，跳过。
    const ownerRow = sessionsRef.current.find(item => item.id === activeSessionId);
    const recoverOwnerId = isGroupRef.current
      ? ''
      : String((ownerRow && ownerRow.characterId) || character.id || '');
    saveMessagesBySession(activeSessionId, persistableMessages, recoverOwnerId)
      .then(() => {
        saveFailedRef.current = false;
        getVectorMemoryConfig()
          .then(config => getVectorIndex(indexedCharacterId)
            .then(existing => indexMessages({
              characterId: indexedCharacterId,
              messages: messagesToIndex,
              config,
              existing,
            }))
            .then(next => saveVectorIndex(indexedCharacterId, next)))
          .catch(() => {});
      })
      .catch(() => {
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
          errorRawRef.current = {};
          if (canClear() && !isGroupRef.current) {
            setGreetingReady(false);
            setSessionGreetingSelected(clearSessionId, false)
              .then(() => refreshSessions())
              .catch(() => {});
          }
          setMessages(current => canClear() ? [] : current);
        }
      }
    ]);
  }, [refreshSessions]);

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
    try {
      await updateCharacter({
        id: characterId,
        firstMes: result.firstMes,
        alternateGreetings: result.alternateGreetings,
      });
      if (activeCharacterIdRef.current !== characterId) return;
      if (flow.purpose === 'new') {
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        setIsSending(false);
        const openingTemplate = String(result.firstMes || '');
        const openingText = openingTemplate.replace(/\{\{user\}\}/g, userNameRef.current || '用户');
        await startNewSession(characterId, {
          text: openingText,
          template: openingTemplate,
        });
        await refreshSessions();
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
      Alert.alert('开场白保存失败', '请稍后重试。');
    }
  }, [greetingPicker, messages, refreshSessions, updateCharacter]);

  const onNewChat = useCallback(() => {
    if (isSending || !ready || abortRef.current) return;
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
            if (abortRef.current) {
              abortRef.current.abort();
              abortRef.current = null;
            }
            setIsSending(false);
            try {
              const current = sessionsRef.current.find(item => item.id === activeSessionIdRef.current);
              await createGroupSession(groupCharactersRef.current, (current && current.name) || '群聊');
              await refreshSessions();
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
              Alert.alert('新建对话失败', '请稍后重试。');
            }
          },
        },
      ]);
      return;
    }
    openGreetingPicker('new');
  }, [isSending, openGreetingPicker, ready, refreshSessions, sessionOwnerMissing]);

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return messages
      .filter(message => (
        message
        && (message.role === USER_ID || message.role === ASSISTANT_ID)
        && String(message.text || '').toLowerCase().includes(query)
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
        text: String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 60),
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
    try {
      const { configs: list, activeId: id } = await getApiConfigs();
      setApiConfigs(list);
      setApiActiveId(id);
      setModelSourceId(id);
      setModelPanelOpen(true);
    } catch (error) {
      Alert.alert('读取失败', '无法读取 API 配置。');
    }
  }, []);

  const applyModelSelection = useCallback(async (sourceId, model) => {
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
  }, [apiConfigs]);

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
      const result = await applySummary({
        session,
        character: sessionCharacter,
        messages: picked,
        updateCharacter,
        userName: userProfile.userName,
        scoped,
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

  const requestReply = useCallback(async ({ historyMessages, userText, baseMessages, images, quote }) => {
    if (isSending || !ready || abortRef.current) return;
    const sendCharacterId = activeCharacterIdRef.current;
    const sendSessionId = activeSessionIdRef.current;
    const sendSessionVersion = sessionVersionRef.current;
    const isCurrentSession = () =>
      sessionVersionRef.current === sendSessionVersion
      && !isStaleReply(activeCharacterIdRef.current, sendCharacterId)
      && activeSessionIdRef.current === sendSessionId;
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

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const [userProfile, globalPresets, enabledPlugins] = await Promise.all([
        getUserProfile(),
        getEnabledGlobalPresetPrompts(),
        getEnabledPlugins(),
      ]);
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
        const index = await getVectorIndex(character.id);
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
        summaryText,
        memorySnippets,
        pluginContext,
        images,
        quote,
      });

      const reply = await sendChatMessage(
        requestMessages,
        {
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
        recordTurnRef.current?.(userText, reply || '');
      }
    } catch (error) {
      if (isCanceledError(error)) {
        // 停止：已有内容（含只生成了思考）就保留并落盘，只有占位符才整条移除
        setMessages(current => (
          isCurrentSession()
            ? settlePendingMessage(current, pendingAssistantMessage.id)
            : current
        ));
        return;
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
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (isCurrentSession()) {
          setIsSending(false);
          autoScrollToBottom();
        }
      }
    }
  }, [autoScrollToBottom, character, characters, isSending, maybeAutoSummarize, ready, scrollToBottom]);

  const requestGroupReply = useCallback(async ({ historyMessages, userText, baseMessages, quote }) => {
    if (isSending || !ready || abortRef.current) return;
    const members = groupCharactersRef.current;
    if (members.length === 0) {
      // 输入框在 onSend 里已清空，这里必须给个提示，不能让用户以为发出去又什么都没发生。
      Alert.alert('无法发送', '这个群聊没有可用的角色（成员可能已被删除）。');
      return;
    }
    const sendSessionId = activeSessionIdRef.current;
    const sendSessionVersion = sessionVersionRef.current;
    const isCurrent = () =>
      sessionVersionRef.current === sendSessionVersion
      && activeSessionIdRef.current === sendSessionId;

    setIsSending(true);
    atBottomRef.current = true;
    setMessages(baseMessages);
    scrollToBottom();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const [userProfile, globalPresets] = await Promise.all([
        getUserProfile(),
        getEnabledGlobalPresetPrompts(),
      ]);
      const groupSessionId = String(activeSessionRef.current?.id || '');
      const cachedProfiles = memberProfilesRef.current.sessionId === groupSessionId
        ? memberProfilesRef.current.profiles
        : (activeSessionRef.current?.memberProfiles || {});
      let memberProfiles = cachedProfiles;
      try {
        const ensured = await ensureMemberProfiles({
          characters: members,
          profiles: cachedProfiles,
        });
        const added = Object.keys(ensured).some(key => !cachedProfiles[key]);
        memberProfiles = ensured;
        memberProfilesRef.current = { sessionId: groupSessionId, profiles: ensured };
        if (added && groupSessionId) {
          await updateSessionMemberProfiles(groupSessionId, ensured);
        }
      } catch (error) {}
      const everyone = hasEveryoneMention(userText);
      const mentions = parseMentions(userText, members);
      let working = baseMessages;

      const runTurnSpeakers = async () => {
        const speakerIds = await selectSpeakers({
          characters: members,
          history: historyMessages,
          userText,
          mentions,
          everyone,
        });
        for (const speakerId of speakerIds) {
          if (!isCurrent() || controller.signal.aborted) break;
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
          const roundHistory = working.filter(
            (item, index) => item
              && !item.pending
              && (item.role === USER_ID || item.role === ASSISTANT_ID)
              && index < baseMessages.length - 1
          );
          working = [...working, pendingMessage];
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
            });
            const reply = await sendChatMessage(requestMessages, {
              signal: controller.signal,
              stream: chatOptions.stream,
            });
            if (!isCurrent()) return;
            working = working.map(item => (
              item.id === pendingMessage.id
                ? { ...item, text: reply || '没有收到回复。', pending: false, waitingForResponse: false }
                : item
            ));
            setMessages(working);
          } catch (error) {
            if (isCanceledError(error)) {
              // 停止：结算占位气泡，避免留下永远“正在思考”的僵尸消息
              setMessages(current => (
                isCurrent() ? settlePendingMessage(current, pendingMessage.id) : current
              ));
              break;
            }
            if (!isCurrent()) return;
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
      };

      const runEnsemble = async () => {
        const historyForPrompt = working.filter(
          (item, index) => item
            && !item.pending
            && (item.role === USER_ID || item.role === ASSISTANT_ID)
            && index < baseMessages.length - 1
        );
        const requestMessages = buildEnsemblePrompt({
          characters: members,
          historyMessages: historyForPrompt,
          userText,
          userProfile,
          globalPresets,
          profiles: memberProfiles,
          mentions,
          everyone,
        });
        if (requestMessages.length === 0) return false;
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
        setMessages(working);
        scrollToBottom();
        let reply = '';
        try {
          reply = await sendChatMessage(requestMessages, {
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
        if (!isCurrent()) return true;
        const segments = mergeAdjacentSegments(parseEnsembleReply(reply, members));
        if (segments.length === 0) {
          // 回退：移除临时消息后交给逐角色模式
          working = working.filter(item => item.id !== pendingMessage.id);
          setMessages(working);
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
          if (isCanceledError(error)) return;
          handled = false;
        }
      }
      if (!handled) {
        await runTurnSpeakers();
      }
    } catch (error) {
      if (isCurrent()) {
        Alert.alert('群聊回复失败', '请稍后重试。');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (isCurrent()) {
          setIsSending(false);
          autoScrollToBottom();
        }
      }
    }
  }, [autoScrollToBottom, isSending, ready, scrollToBottom]);

  const sendText = useCallback(rawText => {
    const text = String(rawText || '').trim();
    const imageAttachments = attachments.filter(item => item.kind === 'image');
    if ((!text && imageAttachments.length === 0) || isSending || !ready || abortRef.current) return;
    if (!isGroupRef.current && !greetingReady) return;
    if (sessionOwnerMissing) {
      Alert.alert('角色资料缺失', '这段历史对话可以查看，恢复角色资料后才能发送消息。');
      return;
    }
    ttsStop().catch(() => {});
    const mergedText = mergeTextAttachments(text, attachments)
      || (imageAttachments.length > 0 ? '（见图片）' : '');
    const userMessage = {
      id: `${Date.now()}-user`,
      role: USER_ID,
      text: text || '（图片）',
      timestamp: Date.now(),
    };
    if (quoteTarget) userMessage.quoted = quoteTarget;
    const payload = {
      historyMessages: messages,
      userText: mergedText,
      baseMessages: [...messages, userMessage],
      images: imageAttachments.map(item => item.dataUri),
      quote: quoteTarget,
    };
    setAttachments([]);
    setQuoteTarget(null);
    if (isGroupRef.current) {
      requestGroupReply(payload);
    } else {
      requestReply(payload);
    }
  }, [attachments, greetingReady, isSending, messages, quoteTarget, ready, requestReply, requestGroupReply, sessionOwnerMissing]);

  const regenerateMessage = useCallback(targetId => {
    if (isSending || !ready) return;
    if (sessionOwnerMissing) {
      Alert.alert('角色资料缺失', '恢复角色资料后才能重新生成回复。');
      return;
    }
    const index = messages.findIndex(item => item.id === targetId);
    if (index < 0 || messages[index].role !== ASSISTANT_ID) return;
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i].role === USER_ID) {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    requestReply({
      historyMessages: messages.slice(0, userIndex),
      userText: messages[userIndex].text,
      baseMessages: messages.slice(0, index),
    });
  }, [isSending, messages, ready, requestReply, sessionOwnerMissing]);

  const editUserMessage = useCallback(targetId => {
    if (isSending || !ready || abortRef.current) return;
    const index = messages.findIndex(item => item.id === targetId);
    if (index < 0 || messages[index].role !== USER_ID) return;
    setMessages(messages.slice(0, index));
    setInput(messages[index].text);
  }, [isSending, messages, ready]);

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
      });
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
      setMessages(current => current.map(item => (
        item.id === messageId
          ? { ...item, inlineImage: { status: 'error', message: (error && error.message) || '配图生成失败' } }
          : item
      )));
    } finally {
      inlineImageBusyRef.current = false;
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

  const onSlashCommand = useCallback(command => {
    sendTextRef.current?.(command);
  }, []);

  const removeAttachment = useCallback(id => {
    setAttachments(current => current.filter(item => item.id !== id));
  }, []);

  const addAttachment = useCallback(async kind => {
    try {
      const picked = await pickAttachment();
      if (!picked) return;
      if (kind === 'text') {
        if (!isTextLike(picked.name, picked.mime)) {
          Alert.alert('不支持的文件', '当前仅支持纯文本类文档。');
          return;
        }
        const text = await readTextAttachment(picked.uri);
        setAttachments(current => [...current, {
          id: `${Date.now()}-${current.length}`,
          kind: 'text',
          name: picked.name,
          text,
        }]);
        return;
      }
      if (!isImage(picked.name, picked.mime)) {
        Alert.alert('不支持的文件', '请选择图片文件。');
        return;
      }
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current || current.supportsVision !== true) {
        Alert.alert('不支持识图', '当前来源未标记为支持识图，请在设置中确认模型能力。');
        return;
      }
      const dataUri = await readImageDataUri(picked.uri, picked.mime);
      setAttachments(list => [...list, {
        id: `${Date.now()}-${list.length}`,
        kind: 'image',
        name: picked.name,
        uri: picked.uri,
        dataUri,
      }]);
    } catch (error) {
      Alert.alert(
        '文件读取失败',
        error && error.message === '文件过大' ? '文件过大，请选择更小的文档。' : '请重试。'
      );
    }
  }, []);

  const pickAttachmentMenu = useCallback(() => {
    Alert.alert('添加附件', '选择要上传的内容类型。', [
      { text: '取消', style: 'cancel' },
      { text: '纯文本文档', onPress: () => addAttachment('text') },
      { text: '图片', onPress: () => addAttachment('image') },
    ]);
  }, [addAttachment]);

  const onSend = useCallback(() => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isSending || !ready || abortRef.current) return;
    if (!isGroupRef.current && !greetingReady) {
      openGreetingPicker(activeSessionId ? 'reselect' : 'new');
      return;
    }
    setInput('');
    sendText(text);
  }, [activeSessionId, attachments.length, greetingReady, input, isSending, openGreetingPicker, ready, sendText]);

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
  const inputDisabled = !ready || isSending || sessionOwnerMissing || (!isGroup && !greetingReady);

  const recordTurn = useCallback(async (userText, assistantText) => {
    const settings = await getMomentsSettings().catch(() => ({ enabled: true }));
    if (!settings.enabled) return;
    const characterId = activeCharacterIdRef.current;
    if (!characterId) return;
    const { delta, milestone } = evaluateTurn({ userText, assistantText });
    const affinityStatus = await getAffinityStatus().catch(() => ({ status: 'corrupt', map: {} }));
    // 好感度读不出时不要写回：否则会用空快照把其它角色的好感度清零。
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
      await saveAffinity({ ...map, [characterId]: next }).catch(() => {});
      return;
    }
    next.triggers = [...next.triggers, trigger];
    await saveAffinity({ ...map, [characterId]: next }).catch(() => {});
    const speaker = characters.find(item => item.id === characterId);
    // 查不到角色就不要用当前活跃角色顶替：那会把名字/头像永久冻进动态，显示成另一个人。
    if (!speaker) return;
    const moment = {
      id: `${Date.now()}-${trigger}`,
      characterId,
      characterName: String((speaker && speaker.name) || ''),
      avatarUri: String((speaker && speaker.avatarUri) || ''),
      // 记下这条动态来自哪段对话：用户在动态下评论时，角色会依据这段记忆来回复
      sessionId: String(activeSessionIdRef.current || ''),
      trigger,
      text: buildMomentText({ trigger, character: speaker, seed: next.turnCount }),
      createdAt: Date.now(),
      likedByUser: false,
      likes: [],
      comments: [],
    };
    const momentsStatus = await getMomentsStatus().catch(() => ({ status: 'corrupt', moments: [] }));
    // 动态读不出时不要写回：否则会用空列表把整表动态清掉。
    if (momentsStatus.status === 'corrupt') return;
    await saveMoments(appendMoment(momentsStatus.moments, moment)).catch(() => {});
  }, [characters]);
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
            return (
              <View
                key={message.id}
                onLayout={event => onMessageLayout(message.id, event)}
              >
                {message.role === SYSTEM_ERROR_ID ? (
                  <ErrorBubble
                    message={message}
                    rawError={errorRawRef.current[message.id]}
                    fullWidth={chatOptions.fullWidth}
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
                    onEditUserMessage={onEditUserMessage}
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
                  />
                )}
              </View>
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
          <TouchableOpacity onPress={() => setQuoteTarget(null)} hitSlop={8} accessibilityLabel="取消引用">
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
              <TouchableOpacity onPress={() => removeAttachment(item.id)} hitSlop={6}>
                <Ionicons name="close" size={14} color={theme.colors.textFaint} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}
      <View style={[styles.inputBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
        {messages.length > 0 ? (
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
            onPress={() => {
              const text = fullScreenText.trim();
              setFullScreenOpen(false);
              setFullScreenText('');
              setInput('');
              if (text) sendText(text);
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
                      style={[styles.modelSourceChip, selected && styles.modelSourceChipActive]}
                      onPress={() => setModelSourceId(config.id)}
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
                      style={styles.modelOption}
                      onPress={() => applyModelSelection(source.id, model)}
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
  inlineImageWrap: {
    marginTop: 6,
    maxWidth: '92%',
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
  errorBubble: {
    backgroundColor: theme.id === 'light' ? '#fde8e8' : '#3a1719',
    borderColor: theme.colors.danger,
    borderWidth: tokens.border.thin,
    borderBottomLeftRadius: 6,
    maxWidth: '92%',
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
