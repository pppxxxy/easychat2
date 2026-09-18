import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import {
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
import {
  applySummary,
  buildMemorySummaryText,
  selectSummarizable,
  shouldSummarize,
} from './memorySummary';
import { isStaleReply } from './chatRace';
import { useApp } from './context/AppContext';
import DisclaimerModal from './disclaimer';
import {
  buildGroupRequest,
  generateOpening,
  parseMentions,
  selectSpeakers,
} from './groupChat';
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine';
import ScrollScrubber from './ScrollScrubber';import { maskSecrets } from './secrets';
import {
  createGroupSession,
  getApiConfigs,
  getChatOptions,
  getEnabledGlobalPresetPrompts,
  getEnabledPlugins,
  getMemorySummarySettings,
  getMessagesBySession,
  getThinkingSettings,
  getUserProfile,
  saveApiConfigs,
  saveMessagesBySession,
  saveThinkingSettings,
  startNewSession,
  THINKING_LEVELS,
} from './storage';
import { runPlugins } from './plugins/registry';

const USER_ID = 'user';
const ASSISTANT_ID = 'assistant';
const SYSTEM_ERROR_ID = 'system-error';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const THINKING_PLACEHOLDER = '正在思考...';
const NEAR_BOTTOM_THRESHOLD = 80;
const AI_DISCLAIMER_TEXT = 'AI 生成可能有误，仅供参考';
const QUOTE_TEXT_MAX = 200;

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

const createMarkdownStyles = (theme, fonts) => ({
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
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontFamily: MONO_FONT,
  },
  code_block: {
    color: theme.colors.bubbleAssistantText,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 0,
    borderRadius: 8,
    padding: 10,
    fontFamily: MONO_FONT,
  },
  fence: {
    color: theme.colors.bubbleAssistantText,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 0,
    borderRadius: 8,
    padding: 10,
    fontFamily: MONO_FONT,
  },
  link: { color: theme.colors.primary },
  bullet_list_icon: { color: theme.colors.bubbleAssistantText },
  ordered_list_icon: { color: theme.colors.bubbleAssistantText },
  bullet_list_content: { flex: 1, color: theme.colors.bubbleAssistantText },
  ordered_list_content: { flex: 1, color: theme.colors.bubbleAssistantText },
});

const HTML_TAG_PATTERN = /<\/?(?:div|span|blockquote|q|section|article|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|hr|br|b|i|u|strong|em|font|img|a|code|pre)\b[^>]*>/i;

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

const VARIANT_STATUS_BAR_PATTERN =
  /(^|\r?\n)[\t ]*【数值状态栏】[\t ]*\r?\n[\t ]*好感度[：:][\t ]*\d+\/200[\t ]*\r?\n[\t ]*心情[：:][\t ]*\d+\/100[\t ]*\r?\n[\t ]*友情[：:][\t ]*\d+\/100[\t ]*(?=\r?\n|$)/g;
const VARIANT_STATUS_LINE_PATTERN =
  /(^|\r?\n)[\t ]*(?:【触碰度】[^\r\n]*|【特殊】[^\r\n]*|(?:心情|友情)[：:][\t ]*\d+\/100[\t ]*)(?=\r?\n|$)/g;

function hideVariantStatusBar(text) {
  return String(text ?? '')
    .replace(VARIANT_STATUS_BAR_PATTERN, '$1')
    .replace(VARIANT_STATUS_LINE_PATTERN, '$1');
}

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
  let html = String(raw || '').replace(STYLE_BLOCK_PATTERN, '');
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
  };
}

function formatScrubberTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ThinkingIndicator() {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts), [theme, fonts]);
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

function renderHighlightedText(text, keyword) {
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

const MessageBubble = React.memo(function MessageBubble({ message, characterName, characterAvatar, userAvatarUri, onSlashCommand, canRegenerate, onRegenerate, onEditUserMessage, onSelectText, onQuote, onPressQuote, highlightKeyword, isMatch, isActiveMatch, fullWidth, thinkingDisplay }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts), [theme, fonts]);
  const markdownStyles = useMemo(() => createMarkdownStyles(theme, fonts), [theme, fonts]);
  const htmlBaseStyle = useMemo(() => createHtmlBaseStyle(theme, fonts), [theme, fonts]);
  const htmlTagsStyles = useMemo(() => createHtmlTagsStyles(theme, fonts), [theme, fonts]);
  const isUser = message.role === USER_ID;
  const { width } = useWindowDimensions();
  const [copied, setCopied] = useState(false);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const renderHtml =
    !isUser && !message.pending && containsHtml(message.text);
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
      <View style={[styles.messageContent, fullWidth ? styles.messageContentFullWidth : null]}>
        {!isUser ? <Text style={styles.nameLabel}>{characterName || ''}</Text> : null}
        <View style={[
          styles.bubble,
          fullWidth ? styles.bubbleFullWidth : styles.bubbleBounded,
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
            thinkingDisplay === 'open' ? (
              <View style={styles.reasoningBox}>
                <Text style={styles.reasoningLabel}>思考过程</Text>
                <Text style={styles.reasoningText} selectable>{message.reasoning}</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.reasoningBox}
                onPress={() => setReasoningExpanded(current => !current)}
                activeOpacity={0.8}
              >
                <View style={styles.reasoningHeader}>
                  <Ionicons name="bulb-outline" size={12} color={theme.colors.textFaint} />
                  <Text style={styles.reasoningLabel}>思考过程</Text>
                  <Ionicons
                    name={reasoningExpanded ? 'chevron-up' : 'chevron-down'}
                    size={12}
                    color={theme.colors.textFaint}
                  />
                </View>
                <Text
                  style={styles.reasoningText}
                  numberOfLines={reasoningExpanded ? undefined : 1}
                >
                  {message.reasoning}
                </Text>
              </TouchableOpacity>
            )
          ) : null}
          {isUser ? (
            <Text style={styles.messageText}>
              {highlightKeyword ? renderHighlightedText(message.text, highlightKeyword) : message.text}
            </Text>
          ) : message.pending && message.waitingForResponse ? (
            <ThinkingIndicator />
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
        </View>
        {!message.pending ? (
          <View style={[styles.messageActions, isUser ? styles.messageActionsRight : styles.messageActionsLeft]}>
            <TouchableOpacity style={styles.messageActionButton} onPress={onCopy} activeOpacity={0.8}>
              <Text style={styles.messageActionText}>{copied ? '已复制' : '复制'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.messageActionButton}
              onPress={() => onQuote?.(message)}
              activeOpacity={0.8}
            >
              <Text style={styles.messageActionText}>引用</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.messageActionButton}
              onPress={() => onSelectText?.(plainText)}
              activeOpacity={0.8}
            >
              <Text style={styles.messageActionText}>选择文本</Text>
            </TouchableOpacity>
            {isUser ? (
              <TouchableOpacity
                style={styles.messageActionButton}
                onPress={() => onEditUserMessage?.(message.id)}
                activeOpacity={0.8}
              >
                <Text style={styles.messageActionText}>修改重发</Text>
              </TouchableOpacity>
            ) : canRegenerate ? (
              <TouchableOpacity
                style={styles.messageActionButton}
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
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts), [theme, fonts]);
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
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts), [theme, fonts]);
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
  const isGroup = activeSession?.type === 'group';
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
  const isGroupRef = useRef(isGroup);
  isGroupRef.current = isGroup;
  const summarizingRef = useRef(false);
  const messageOffsetsRef = useRef({});
  const atBottomRef = useRef(true);
  const abortRef = useRef(null);
  const sessionVersionRef = useRef(0);
  const [input, setInput] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
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
  const [chatOptions, setChatOptions] = useState({ streaming: true, fullWidth: false });
  const [fullScreenOpen, setFullScreenOpen] = useState(false);
  const [fullScreenText, setFullScreenText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [focusedMessageId, setFocusedMessageId] = useState('');
  const [quoteTarget, setQuoteTarget] = useState(null);
  const navigation = useNavigation();

  const onSwitch = useCallback(id => {
    setSwitcherOpen(false);
    if (id === activeCharacterIdRef.current) return;
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
        if (!Object.prototype.hasOwnProperty.call(item, 'waitingForResponse')) return item;
        const next = { ...item };
        delete next.waitingForResponse;
        return next;
      }),
    [messages]
  );
  const persistableSnapshot = useMemo(
    () => JSON.stringify(persistableMessages),
    [persistableMessages]
  );
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
          character.regexScripts,
          REGEX_PLACEMENT.AI_OUTPUT,
          { mode: 'display', depth }
        );
        return text === message.text ? message : { ...message, text };
      }
      if (message.role === USER_ID) {
        const text = applyRegexScripts(
          message.text,
          character.regexScripts,
          REGEX_PLACEMENT.USER_INPUT,
          { mode: 'display', depth }
        );
        return text === message.text ? message : { ...message, text };
      }
      return message;
    }),
    [messages, character.regexScripts]
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
      setReady(true);
      return () => {
        cancelled = true;
        sessionVersionRef.current += 1;
      };
    }
    let userProfileCache = null;
    const profilePromise = getUserProfile().then(profile => {
      if (cancelled) return;
      userProfileCache = profile;
      userNameRef.current = String(profile.userName || '').trim();
      setUserAvatar(profile.avatarUri || '');
    }).catch(() => {});
    getMessagesBySession(activeSessionId)
      .then(async list => {
        if (cancelled) return;
        await profilePromise;
        if (cancelled) return;
        const initial = Array.isArray(list) ? list : [];
        if (initial.length === 0 && isGroupRef.current) {
          const members = groupCharactersRef.current;
          lastSavedSnapshotRef.current = '[]';
          setMessages([]);
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
                }]);
              } catch (error) {}
            })();
          }
          return;
        }
        const greeting = initial.length === 0
          ? buildGreetingMessage(activeSessionId, character.firstMes, userProfileCache?.userName)
          : null;
        lastSavedSnapshotRef.current = JSON.stringify(initial);
        setMessages(greeting ? [greeting] : initial);
      })
      .catch(() => {
        if (cancelled) return;
        lastSavedSnapshotRef.current = '[]';
        setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      sessionVersionRef.current += 1;
    };
  }, [activeSessionId, loaded]);

  useEffect(() => {
    if (!ready) return;
    if (!activeSessionId) return;
    if (persistableSnapshot === lastSavedSnapshotRef.current) return;
    lastSavedSnapshotRef.current = persistableSnapshot;
    saveMessagesBySession(activeSessionId, persistableMessages)
      .then(() => {
        saveFailedRef.current = false;
      })
      .catch(() => {
        if (!saveFailedRef.current) {
          saveFailedRef.current = true;
          Alert.alert('聊天记录保存失败', '请检查存储空间或权限。');
        }
      });
  }, [activeSessionId, persistableSnapshot, ready]);

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
          setMessages(current => canClear() ? [] : current);
        }
      }
    ]);
  }, []);

  const onNewChat = useCallback(() => {
    if (isSending || !ready || abortRef.current) return;
    if (persistableMessages.length === 0) {
      Alert.alert('当前对话还没有内容', '发送一条消息后再新建对话。');
      return;
    }
    Alert.alert('新建对话', '将为当前角色开启一段新对话，旧对话保留在「记忆」中。', [
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
            if (isGroupRef.current && groupCharactersRef.current.length > 0) {
              const current = sessionsRef.current.find(
                item => item.id === activeSessionIdRef.current
              );
              await createGroupSession(
                groupCharactersRef.current,
                (current && current.name) || '群聊'
              );
            } else {
              await startNewSession(activeCharacterIdRef.current);
            }
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
  }, [isSending, persistableMessages.length, ready, refreshSessions]);

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
    () => messages.filter(message => message && !message.pending),
    [messages]
  );

  const scrubberPreviews = useMemo(
    () => scrubberMessages.map(message => {
      const timestamp = Number(String(message.id || '').split('-')[0]);
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
      setThinkingOpen(true);
    } catch (error) {
      Alert.alert('读取失败', '无法读取思考设置。');
    }
  }, []);

  const applyThinking = useCallback(async (enabled, level) => {
    try {
      const saved = await saveThinkingSettings({ enabled, level });
      setThinkingEnabled(saved.enabled);
      setThinkingLevel(saved.level);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, []);

  const runSummarize = useCallback(async (session, list, manual) => {
    if (summarizingRef.current) return;
    const picked = selectSummarizable(list, session.summarizedUpTo);
    if (picked.length === 0) {
      if (manual) Alert.alert('无法总结', '当前没有可总结的消息。');
      return;
    }
    summarizingRef.current = true;
    setSummarizing(true);
    try {
      const userProfile = await getUserProfile();
      await applySummary({
        session,
        character,
        messages: picked,
        updateCharacter,
        userName: userProfile.userName,
      });
      await refreshSessions().catch(() => {});
      if (manual) Alert.alert('已完成', '记忆总结已写入角色世界书。');
    } catch (error) {
      Alert.alert('记忆总结失败', '请稍后重试。');
    } finally {
      summarizingRef.current = false;
      setSummarizing(false);
    }
  }, [character, updateCharacter, refreshSessions]);

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
    runSummarize(session, messages, true);
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
    let receivedChunk = false;

    const pendingAssistantMessage = {
      id: `${Date.now()}-assistant`,
      role: ASSISTANT_ID,
      text: THINKING_PLACEHOLDER,
      reasoning: '',
      pending: true,
      waitingForResponse: true,
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
      const requestMessages = buildRequestMessages({
        character,
        historyMessages: trimmedHistory,
        userText,
        userProfile,
        globalPresets,
        summaryText: buildMemorySummaryText(character),
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
            receivedChunk = true;
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
      }
    } catch (error) {
      if (isCanceledError(error)) {
        setMessages(current => {
          if (!isCurrentSession()) return current;
          const pendingItem = current.find(item => item.id === pendingAssistantMessage.id);
          const hasPartial = !!pendingItem
            && receivedChunk
            && typeof pendingItem.text === 'string'
            && pendingItem.text.trim().length > 0;
          if (hasPartial) {
            return current.map(item => (
              item.id === pendingAssistantMessage.id
                ? { ...item, pending: false, waitingForResponse: false }
                : item
            ));
          }
          return current.filter(item => item.id !== pendingAssistantMessage.id);
        });
        return;
      }
      const rawText = buildErrorRawText(error);
      const errorMessage = {
        id: `${pendingAssistantMessage.id}-error`,
        role: SYSTEM_ERROR_ID,
        text: '请求失败，点击查看详情',
        detail: maskSecrets(rawText),
      };
      if (isCurrentSession()) {
        errorRawRef.current[errorMessage.id] = rawText;
      }
      setMessages(current => {
        if (!isCurrentSession()) return current;
        const pendingItem = current.find(item => item.id === pendingAssistantMessage.id);
        const hasPartial = !!pendingItem
          && receivedChunk
          && typeof pendingItem.text === 'string'
          && pendingItem.text.trim().length > 0;
        if (hasPartial) {
          return current
            .map(item => (
              item.id === pendingAssistantMessage.id
                ? { ...item, pending: false, waitingForResponse: false }
                : item
            ))
            .concat(errorMessage);
        }
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
  }, [autoScrollToBottom, character, isSending, maybeAutoSummarize, ready, scrollToBottom]);

  const requestGroupReply = useCallback(async ({ historyMessages, userText, baseMessages, quote }) => {
    if (isSending || !ready || abortRef.current) return;
    const members = groupCharactersRef.current;
    if (members.length === 0) return;
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
      const mentions = parseMentions(userText, members);
      const speakerIds = await selectSpeakers({
        characters: members,
        history: historyMessages,
        userText,
        mentions,
      });
      let working = baseMessages;
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
        };
        working = [...working, pendingMessage];
        setMessages(working);
        scrollToBottom();
        try {
          const requestMessages = buildGroupRequest({
            speaker,
            characters: members,
            historyMessages,
            userText,
            userProfile,
            globalPresets,
            quote,
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
          if (isCanceledError(error)) break;
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
    const mergedText = mergeTextAttachments(text, attachments)
      || (imageAttachments.length > 0 ? '（见图片）' : '');
    const userMessage = {
      id: `${Date.now()}-user`,
      role: USER_ID,
      text: text || '（图片）',
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
  }, [attachments, isSending, messages, quoteTarget, ready, requestReply, requestGroupReply]);

  const regenerateMessage = useCallback(targetId => {
    if (isSending || !ready) return;
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
  }, [isSending, messages, ready, requestReply]);

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

  const sendTextRef = useRef(sendText);
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
    setInput('');
    sendText(text);
  }, [attachments.length, input, isSending, ready, sendText]);

  const bgUri = character.bgUri || '';
  const displayName = isGroup
    ? (activeSession?.name || groupCharacters.map(item => item.name).join('、') || '群聊')
    : (character.name || 'EasyChat2 助手');

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
          disabled={!loaded || isGroup}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={isGroup ? '群聊' : '切换角色'}
          accessibilityState={{ disabled: !loaded || isGroup }}
        >
          {isGroup ? (
            <View style={[styles.characterAvatar, styles.characterAvatarFallback]}>
              <Ionicons name="people" size={13} color={theme.colors.primarySoft} />
            </View>
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
          {isGroup ? null : (
            <Ionicons name="chevron-down" size={14} color={theme.colors.primaryMuted} style={styles.characterCaret} />
          )}
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
          style={styles.noticeButton}
          onPress={() => setNoticeOpen(true)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="查看公告"
        >
          <Ionicons name="megaphone-outline" size={13} color={theme.colors.primarySoft} />
          <Text style={styles.noticeButtonText}>公告</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.noticeButton}
          onPress={openModelPanel}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="切换模型"
        >
          <Ionicons name="cube-outline" size={13} color={theme.colors.primarySoft} />
          <Text style={styles.noticeButtonText}>模型</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.noticeButton}
          onPress={openThinkingPanel}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="思考设置"
        >
          <Ionicons name="bulb-outline" size={13} color={theme.colors.primarySoft} />
          <Text style={styles.noticeButtonText}>思考</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.noticeButton, scrubberMessages.length === 0 && styles.actionDisabled]}
          onPress={() => setScrubberOpen(true)}
          disabled={scrubberMessages.length === 0}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="快速定位"
        >
          <Ionicons name="options-outline" size={13} color={theme.colors.primarySoft} />
          <Text style={styles.noticeButtonText}>定位</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.noticeButton}
          onPress={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="搜索当前对话"
        >
          <Ionicons name="search" size={13} color={theme.colors.primarySoft} />
          <Text style={styles.noticeButtonText}>搜索</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.noticeButton, (summarizing || !ready) && styles.actionDisabled]}
          onPress={onSummarize}
          disabled={summarizing || !ready}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="总结记忆"
        >
          <Ionicons name="book-outline" size={13} color={theme.colors.primarySoft} />
          <Text style={styles.noticeButtonText}>{summarizing ? '总结中' : '总结'}</Text>
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
              当前角色：{character.name || 'EasyChat2 助手'}{'\n'}
              请先在“设置”里填写 API Key，然后输入消息。
            </Text>
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
                    characterName={(speaker && speaker.name) || message.speakerName || character.name}
                    characterAvatar={
                      speaker
                        ? (speaker.avatarUri || '')
                        : (message.speakerId ? '' : character.avatarUri)
                    }
                    userAvatarUri={userAvatar}
                    onSlashCommand={onSlashCommand}
                    canRegenerate={!isGroup && regenerableIds.has(message.id)}
                    onRegenerate={onRegenerateMessage}
                    onEditUserMessage={onEditUserMessage}
                    onSelectText={onSelectText}
                    onQuote={onQuoteMessage}
                    onPressQuote={onPressQuoteBlock}
                    highlightKeyword={searchQuery.trim()}
                    isMatch={searchMatches.includes(message.id)}
                    isActiveMatch={focusedMessageId === message.id}
                    fullWidth={chatOptions.fullWidth}
                    thinkingDisplay={thinkingDisplay}
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
        <TouchableOpacity
          style={styles.attachButton}
          onPress={pickAttachmentMenu}
          disabled={!ready || isSending}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="添加附件"
        >
          <Ionicons name="add-circle-outline" size={22} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        <TextInput
          style={[styles.input, bgUri && styles.inputOverlay, inputFocused && styles.inputFocused]}
          value={input}
          onChangeText={setInput}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          placeholder="输入消息..."
          placeholderTextColor={theme.colors.textFaint}
          multiline
          editable={!isSending && ready}
        />
        <TouchableOpacity
          style={styles.fullScreenButton}
          onPress={() => {
            setFullScreenText(input);
            setFullScreenOpen(true);
          }}
          disabled={!ready}
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
              ((!input.trim() && attachments.length === 0) || !ready) && styles.sendButtonDisabled,
            ]}
            onPress={onSend}
            disabled={(!input.trim() && attachments.length === 0) || !ready}
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
            <Text style={styles.modalTitle}>选择角色</Text>
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
              {characters.map(item => {
                const selected = item.id === activeId;
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
        <TouchableOpacity
          style={styles.modelBackdrop}
          activeOpacity={1}
          onPress={() => setModelPanelOpen(false)}
        >
          <View style={styles.modelSheet}>
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
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={thinkingOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setThinkingOpen(false)}
      >
        <TouchableOpacity
          style={styles.modelBackdrop}
          activeOpacity={1}
          onPress={() => setThinkingOpen(false)}
        >
          <View style={styles.modelSheet}>
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
                onValueChange={value => applyThinking(value, thinkingLevel)}
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
                    onPress={() => applyThinking(thinkingEnabled, level)}
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
            <TouchableOpacity
              style={styles.modelClose}
              onPress={() => setThinkingOpen(false)}
              activeOpacity={0.8}
            >
              <Text style={styles.modelCloseText}>关闭</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
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

const createChatStyles = (theme, fonts) => StyleSheet.create({
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
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface,
    backgroundColor: 'rgba(26,26,46,0.72)',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  characterChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(108,99,255,0.10)',
  },
  characterAvatar: { width: 26, height: 26, borderRadius: 13, marginRight: 8, borderWidth: 1, borderColor: 'rgba(139,133,255,0.35)' },
  characterAvatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceBorder },
  characterName: { color: theme.colors.text, fontWeight: '700', flexShrink: 1 },
  characterCaret: { marginLeft: 6 },
  noticeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(139,133,255,0.45)',
    backgroundColor: 'rgba(108,99,255,0.10)',
    borderRadius: 14,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  noticeButtonText: { color: theme.colors.primarySoft, fontSize: 12, fontWeight: '700', marginLeft: 4 },
  actionDisabled: { opacity: 0.5 },
  modelBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  modelSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    maxHeight: '75%',
  },
  modelTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '800', marginBottom: 10 },
  modelLabel: { color: theme.colors.textFaint, fontSize: 12, marginTop: 8, marginBottom: 6 },
  modelSourceRow: { flexDirection: 'row' },
  modelSourceChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
    maxWidth: 140,
  },
  modelSourceChipActive: { backgroundColor: 'rgba(108,99,255,0.25)', borderColor: theme.colors.primary },
  modelSourceText: { color: theme.colors.textMuted, fontSize: 12, fontWeight: '700' },
  modelSourceTextActive: { color: theme.colors.primarySoft },
  modelListScroll: { maxHeight: 240, marginTop: 2 },
  modelOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface,
  },
  modelOptionText: { color: theme.colors.text, fontSize: 14, flex: 1, marginRight: 8 },
  modelEmpty: { color: theme.colors.textFaint, fontSize: 13, paddingVertical: 12 },
  modelClose: {
    marginTop: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  modelCloseText: { color: theme.colors.primarySoft, fontSize: 14, fontWeight: '700' },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface,
  },
  thinkingLabel: { color: theme.colors.text, fontSize: 15, fontWeight: '700' },
  thinkingLevels: { flexDirection: 'row', marginTop: 4 },
  thinkingLevelChip: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
  },
  thinkingLevelChipActive: {
    backgroundColor: 'rgba(108,99,255,0.25)',
    borderColor: theme.colors.primary,
  },
  thinkingLevelText: { color: theme.colors.textMuted, fontSize: 13, fontWeight: '700' },
  thinkingLevelTextActive: { color: theme.colors.primarySoft },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 14,
    paddingVertical: 6,
    marginLeft: 8,
  },
  searchCount: { color: theme.colors.textFaint, fontSize: 12, marginHorizontal: 8 },
  searchNav: { paddingHorizontal: 4 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 16,
    padding: 16,
    maxHeight: '70%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  modalTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '800', marginBottom: 12 },
  modalList: { maxHeight: 360 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  modalRowActive: { borderWidth: 1, borderColor: theme.colors.primary, backgroundColor: 'rgba(108,99,255,0.16)' },
  modalRowAvatar: { width: 34, height: 34, borderRadius: 17, marginRight: 10 },
  modalRowAvatarFallback: {
    width: 34,
    height: 34,
    borderRadius: 17,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
  },
  modalRowAvatarText: { color: theme.colors.text, fontSize: 14, fontWeight: '800' },
  modalRowText: { color: theme.colors.textMuted, flex: 1, marginRight: 8 },
  modalRowTextActive: { color: theme.colors.text, fontWeight: '700' },
  modalBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
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
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: theme.colors.primary,
    marginLeft: 8,
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
    padding: 24,
  },
  emptyIconBadge: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(108,99,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(139,133,255,0.35)',
    marginBottom: 16,
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
    borderRadius: 18,
    marginRight: 8,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    marginTop: 16,
    borderWidth: 2,
    borderColor: 'rgba(139,133,255,0.35)',
  },
  avatarContainerRight: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginLeft: 8,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    marginTop: 16,
    borderWidth: 2,
    borderColor: 'rgba(139,133,255,0.35)',
  },
  avatarImage: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  avatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderUser: {
    width: 32,
    height: 32,
    borderRadius: 16,
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
    flex: 1,
  },
  quoteBlock: {
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 8,
  },
  quoteBlockUser: {
    borderLeftColor: theme.colors.primarySoft,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  quoteBlockAssistant: {
    borderLeftColor: theme.colors.primary,
    backgroundColor: 'rgba(108,99,255,0.10)',
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
    paddingTop: 8,
    paddingBottom: 6,
  },
  quoteBarBody: {
    flex: 1,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.primary,
    paddingLeft: 8,
    marginRight: 8,
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
    backgroundColor: 'rgba(108,99,255,0.10)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 8,
  },
  reasoningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  reasoningLabel: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 4,
    marginRight: 4,
  },
  reasoningText: {
    color: theme.colors.surfaceBorder,
    fontSize: 12,
    lineHeight: 18,
  },
  messageActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
  },
  messageActionsLeft: {
    justifyContent: 'flex-start',
  },
  messageActionsRight: {
    justifyContent: 'flex-end',
  },
  messageActionButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    marginRight: 6,
    marginTop: 4,
  },
  messageActionText: {
    color: theme.colors.primarySoft,
    fontSize: 12,
    fontWeight: '700',
  },
  bubble: {
    maxWidth: '95%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 3,
    elevation: 2,
  },
  bubbleBounded: {
    maxWidth: '95%',
  },
  bubbleFullWidth: {
    maxWidth: '100%',
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
    borderRadius: 8,
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
    backgroundColor: '#5a1d1d',
    borderColor: '#8b2e2e',
    borderWidth: 1,
    borderBottomLeftRadius: 6,
    maxWidth: '92%',
  },
  errorBadge: {
    color: '#ffb4b4',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 6,
  },
  errorSummary: {
    color: '#ffd6d6',
    fontSize: 15,
    lineHeight: 21,
  },
  errorDetail: {
    color: '#ffd6d6',
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
    borderRadius: 12,
    backgroundColor: '#7a2a2a',
  },
  copyButtonText: {
    color: theme.colors.text,
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
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginRight: 8,
    marginBottom: 6,
    maxWidth: 220,
  },
  attachmentThumb: { width: 20, height: 20, borderRadius: 4, marginRight: 6 },
  attachmentName: { color: theme.colors.textMuted, fontSize: 12, flexShrink: 1, marginRight: 6, marginLeft: 4 },
  attachButton: { paddingHorizontal: 6, paddingVertical: 6 },
  fullScreenButton: { paddingHorizontal: 6, paddingVertical: 6 },
  fullScreenContainer: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 48 },
  fullScreenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
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
    borderRadius: 12,
    paddingVertical: 12,
  },
  fullScreenSendText: { color: theme.colors.text, fontSize: 15, fontWeight: '700', marginLeft: 6 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface,
  },
  inputBarSurface: {
    backgroundColor: theme.colors.background,
  },
  inputBarOverlay: {
    backgroundColor: 'rgba(20,20,34,0.42)',
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 110,
    borderRadius: 21,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
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
    backgroundColor: 'rgba(45,45,68,0.42)',
    borderColor: 'rgba(255,255,255,0.22)',
  },
  sendButton: {
    marginLeft: 8,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  sendButtonDisabled: {
    opacity: 0.45,
    elevation: 0,
    shadowOpacity: 0,
  },
  stopButton: {
    backgroundColor: '#b0463f',
    shadowColor: '#b0463f',
  },
  clearButton: {
    marginRight: 8,
    height: 42,
    borderRadius: 21,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: 'rgba(45,45,68,0.6)',
  },
  clearButtonDisabled: {
    opacity: 0.45,
  },
  clearText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
});
