import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine';
import { maskSecrets } from './secrets';
import {
  getEnabledGlobalPresetPrompts,
  getMemorySummarySettings,
  getMessagesBySession,
  getUserProfile,
  saveMessagesBySession,
} from './storage';

const USER_ID = 'user';
const ASSISTANT_ID = 'assistant';
const SYSTEM_ERROR_ID = 'system-error';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const THINKING_PLACEHOLDER = '正在思考...';
const NEAR_BOTTOM_THRESHOLD = 80;

const markdownStyles = {
  body: { color: '#1a1a2e', fontSize: 15, lineHeight: 22 },
  heading1: { color: '#000' },
  heading2: { color: '#000' },
  heading3: { color: '#000' },
  heading4: { color: '#000' },
  heading5: { color: '#000' },
  heading6: { color: '#000' },
  hr: { backgroundColor: '#ddd' },
  blockquote: { backgroundColor: '#f5f5f5', borderColor: '#6c63ff' },
  code_inline: {
    color: '#c7254e',
    backgroundColor: '#f5f5f5',
    borderWidth: 0,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontFamily: MONO_FONT,
  },
  code_block: {
    color: '#333',
    backgroundColor: '#f5f5f5',
    borderWidth: 0,
    borderRadius: 8,
    padding: 10,
    fontFamily: MONO_FONT,
  },
  fence: {
    color: '#333',
    backgroundColor: '#f5f5f5',
    borderWidth: 0,
    borderRadius: 8,
    padding: 10,
    fontFamily: MONO_FONT,
  },
  link: { color: '#6c63ff' },
  bullet_list_icon: { color: '#1a1a2e' },
  ordered_list_icon: { color: '#1a1a2e' },
  bullet_list_content: { flex: 1, color: '#1a1a2e' },
  ordered_list_content: { flex: 1, color: '#1a1a2e' },
};

const HTML_TAG_PATTERN = /<\/?(?:div|span|blockquote|q|section|article|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|hr|br|b|i|u|strong|em|font|img|a|code|pre)\b[^>]*>/i;

const STYLE_BLOCK_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const BUTTON_BLOCK_PATTERN = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
const ONCLICK_ATTRIBUTE_PATTERN = /onclick\s*=\s*("[^"]*"|'[^']*')/i;
const SLASH_SEND_PATTERN = /\/send\s+([^'"]+)/i;
const GRADIENT_DECLARATION_PATTERN = /(?:background(?:-image)?)\s*:\s*(?:repeating-)?(?:linear|radial)-gradient\(((?:[^()]|\([^()]*\))*)\)/gi;
const GRADIENT_COLOR_STOP_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/;

const htmlBaseStyle = {
  color: '#1a1a2e',
  fontSize: 15,
  lineHeight: 22,
};

const htmlTagsStyles = {
  a: { color: '#6c63ff' },
  code: { fontFamily: MONO_FONT, color: '#c7254e', backgroundColor: '#f5f5f5' },
  pre: { fontFamily: MONO_FONT, color: '#333', backgroundColor: '#f5f5f5' },
  q: { color: '#1a1a2e' },
  h4: { color: '#344f5d', fontSize: 13, marginTop: 0, marginBottom: 6 },
};

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

function ThinkingIndicator() {
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

const MessageBubble = React.memo(function MessageBubble({ message, characterName, characterAvatar, userAvatarUri, onSlashCommand, canRegenerate, onRegenerate, onEditUserMessage, onSelectText }) {
  const isUser = message.role === USER_ID;
  const { width } = useWindowDimensions();
  const [copied, setCopied] = useState(false);
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
      <View style={[styles.messageContent]}>
        {!isUser ? <Text style={styles.nameLabel}>{characterName || ''}</Text> : null}
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          {isUser ? (
            <Text style={styles.messageText}>{message.text}</Text>
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

function ErrorBubble({ message, rawError, onCopied }) {
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
      <View style={[styles.bubble, styles.errorBubble]}>
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
  } = useApp();
  const characterId = character.id || 'default';
  const activeCharacterIdRef = useRef(characterId);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const summarizingRef = useRef(false);
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
  const [selectionText, setSelectionText] = useState('');
  const [summarizing, setSummarizing] = useState(false);

  const onSwitch = useCallback(id => {
    setSwitcherOpen(false);
    if (id === activeCharacterIdRef.current) return;
    activeCharacterIdRef.current = id;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsSending(false);
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
      setUserAvatar(profile.avatarUri || '');
    }).catch(() => {});
    getMessagesBySession(activeSessionId)
      .then(async list => {
        if (cancelled) return;
        await profilePromise;
        if (cancelled) return;
        const initial = Array.isArray(list) ? list : [];
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
    const session = sessionsRef.current.find(
      item => item.id === activeSessionIdRef.current
    );
    if (!session) {
      Alert.alert('无法总结', '当前没有可总结的会话。');
      return;
    }
    runSummarize(session, messages, true);
  }, [isSending, ready, messages, runSummarize]);

  const requestReply = useCallback(async ({ historyMessages, userText, baseMessages }) => {
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
      const [userProfile, globalPresets] = await Promise.all([
        getUserProfile(),
        getEnabledGlobalPresetPrompts(),
      ]);
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
      });

      const reply = await sendChatMessage(
        requestMessages,
        {
          signal: controller.signal,
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

  const sendText = useCallback(rawText => {
    const text = String(rawText || '').trim();
    if (!text || isSending || !ready || abortRef.current) return;
    const userMessage = {
      id: `${Date.now()}-user`,
      role: USER_ID,
      text,
    };
    requestReply({
      historyMessages: messages,
      userText: text,
      baseMessages: [...messages, userMessage],
    });
  }, [isSending, messages, ready, requestReply]);

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

  const sendTextRef = useRef(sendText);
  useEffect(() => {
    sendTextRef.current = sendText;
  }, [sendText]);

  const onSlashCommand = useCallback(command => {
    sendTextRef.current?.(command);
  }, []);

  const onSend = useCallback(() => {
    const text = input.trim();
    if (!text || isSending || !ready || abortRef.current) return;
    setInput('');
    sendText(text);
  }, [input, isSending, ready, sendText]);

  const bgUri = character.bgUri || '';

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
          accessibilityLabel="切换角色"
          accessibilityState={{ disabled: !loaded }}
        >
          {character.avatarUri ? (
            <Image source={{ uri: character.avatarUri }} style={styles.characterAvatar} />
          ) : (
            <View style={[styles.characterAvatar, styles.characterAvatarFallback]}>
              <Ionicons name="person" size={13} color="#c8c4ff" />
            </View>
          )}
          <Text style={styles.characterName} numberOfLines={1}>
            {character.name || 'EasyChat2 助手'}
          </Text>
          <Ionicons name="chevron-down" size={14} color="#8b85ff" style={styles.characterCaret} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.noticeButton}
          onPress={() => setNoticeOpen(true)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="查看公告"
        >
          <Ionicons name="megaphone-outline" size={13} color="#c8c4ff" />
          <Text style={styles.noticeButtonText}>公告</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.noticeButton, (summarizing || !ready) && styles.actionDisabled]}
          onPress={onSummarize}
          disabled={summarizing || !ready}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="总结记忆"
        >
          <Ionicons name="book-outline" size={13} color="#c8c4ff" />
          <Text style={styles.noticeButtonText}>{summarizing ? '总结中' : '总结'}</Text>
        </TouchableOpacity>
      </View>
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
              <Ionicons name="chatbubbles-outline" size={36} color="#8b85ff" />
            </View>
            <Text style={styles.emptyTitle}>开始聊天</Text>
            <Text style={styles.emptyText}>
              当前角色：{character.name || 'EasyChat2 助手'}{'\n'}
              请先在“设置”里填写 API Key，然后输入消息。
            </Text>
          </View>
        ) : (
          renderedMessages.map(message =>
            message.role === SYSTEM_ERROR_ID ? (
              <ErrorBubble
                key={message.id}
                message={message}
                rawError={errorRawRef.current[message.id]}
              />
            ) : (
              <MessageBubble
                key={message.id}
                message={message}
                characterName={character.name}
                characterAvatar={character.avatarUri}
                userAvatarUri={userAvatar}
                onSlashCommand={onSlashCommand}
                canRegenerate={regenerableIds.has(message.id)}
                onRegenerate={onRegenerateMessage}
                onEditUserMessage={onEditUserMessage}
                onSelectText={onSelectText}
              />
            )
          )
        )}
      </ScrollView>

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
        <TextInput
          style={[styles.input, bgUri && styles.inputOverlay, inputFocused && styles.inputFocused]}
          value={input}
          onChangeText={setInput}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          placeholder="输入消息..."
          placeholderTextColor={bgUri ? '#cfcfe4' : '#888'}
          multiline
          editable={!isSending && ready}
        />
        {isSending ? (
          <TouchableOpacity
            style={[styles.sendButton, styles.stopButton]}
            onPress={onStop}
            accessibilityLabel="停止"
            activeOpacity={0.8}
          >
            <Ionicons name="stop" size={18} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendButton, (!input.trim() || !ready) && styles.sendButtonDisabled]}
            onPress={onSend}
            disabled={!input.trim() || !ready}
            accessibilityLabel="发送"
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-up" size={20} color="#fff" />
          </TouchableOpacity>
        )}
      </View>

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
                        <Ionicons name="checkmark" size={12} color="#ffffff" />
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#2d2d44',
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
  characterAvatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#3a3a58' },
  characterName: { color: '#fff', fontWeight: '700', flexShrink: 1 },
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
  noticeButtonText: { color: '#c8c4ff', fontSize: 12, fontWeight: '700', marginLeft: 4 },
  actionDisabled: { opacity: 0.5 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: '#24243b',
    borderRadius: 16,
    padding: 16,
    maxHeight: '70%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '800', marginBottom: 12 },
  modalList: { maxHeight: 360 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#2d2d44',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  modalRowActive: { borderWidth: 1, borderColor: '#6c63ff', backgroundColor: 'rgba(108,99,255,0.16)' },
  modalRowAvatar: { width: 34, height: 34, borderRadius: 17, marginRight: 10 },
  modalRowAvatarFallback: {
    width: 34,
    height: 34,
    borderRadius: 17,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6c63ff',
  },
  modalRowAvatarText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  modalRowText: { color: '#d9d9e6', flex: 1, marginRight: 8 },
  modalRowTextActive: { color: '#fff', fontWeight: '700' },
  modalBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#6c63ff',
    borderRadius: 10,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  modalBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700', marginLeft: 2 },
  selectScroll: { maxHeight: 360, marginBottom: 12 },
  selectText: { color: '#e6e6f0', fontSize: 15, lineHeight: 22 },
  selectActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  selectButton: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#6c63ff',
    marginLeft: 8,
  },
  selectButtonGhost: {
    backgroundColor: '#2d2d44',
  },
  selectButtonText: { color: '#fff', fontWeight: '700' },
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
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
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 8,
  },
  emptyText: {
    color: '#aaa',
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
    backgroundColor: '#6c63ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderUser: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#555',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  messageContent: {
    maxWidth: '92%',
  },
  nameLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 2,
    marginLeft: 2,
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
    backgroundColor: '#2d2d44',
    marginRight: 6,
    marginTop: 4,
  },
  messageActionText: {
    color: '#c8c4ff',
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
  userBubble: {
    backgroundColor: '#6c63ff',
    borderBottomRightRadius: 6,
  },
  assistantBubble: {
    backgroundColor: '#f0f0f0',
    borderBottomLeftRadius: 6,
  },
  thinkingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 28,
  },
  thinkingText: {
    color: '#55516f',
    fontSize: 14,
    lineHeight: 22,
    marginRight: 6,
  },
  thinkingDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginLeft: 4,
    backgroundColor: '#6c63ff',
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
    color: '#ffffff',
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
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  messageText: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 21,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: '#2d2d44',
  },
  inputBarSurface: {
    backgroundColor: '#1a1a2e',
  },
  inputBarOverlay: {
    backgroundColor: 'rgba(20,20,34,0.42)',
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 110,
    borderRadius: 21,
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#3a3a58',
    color: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  inputFocused: {
    borderColor: '#8b85ff',
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
    backgroundColor: '#6c63ff',
    shadowColor: '#6c63ff',
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
    borderColor: '#3a3a58',
    backgroundColor: 'rgba(45,45,68,0.6)',
  },
  clearButtonDisabled: {
    opacity: 0.45,
  },
  clearText: {
    color: '#b8b8d0',
    fontSize: 13,
    fontWeight: '700',
  },
});
