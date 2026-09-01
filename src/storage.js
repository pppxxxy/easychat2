import AsyncStorage from '@react-native-async-storage/async-storage';

const API_CONFIG_KEY = '@easychat2_api_config';
const CHARACTER_KEY = '@easychat2_character';
const MESSAGES_KEY = '@easychat2_messages';

const DEFAULT_API_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: ''
};

const DEFAULT_CHARACTER = {
  name: 'EasyChat2 助手',
  systemPrompt: '你是 EasyChat2 的智能助手，回答简洁清晰。'
};

async function readJson(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

export async function getApiConfig() {
  const config = await readJson(API_CONFIG_KEY, DEFAULT_API_CONFIG);
  return {
    ...DEFAULT_API_CONFIG,
    ...config
  };
}

export async function saveApiConfig(config) {
  await AsyncStorage.setItem(API_CONFIG_KEY, JSON.stringify(config));
}

export async function getCharacter() {
  const character = await readJson(CHARACTER_KEY, DEFAULT_CHARACTER);
  return {
    ...DEFAULT_CHARACTER,
    ...character
  };
}

export async function saveCharacter(character) {
  await AsyncStorage.setItem(CHARACTER_KEY, JSON.stringify(character));
}

export async function getMessages() {
  const messages = await readJson(MESSAGES_KEY, []);
  return Array.isArray(messages) ? messages.filter(item => item && !item.pending) : [];
}

export async function saveMessages(messages) {
  const persistable = (messages || []).filter(item => item && !item.pending);
  await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(persistable));
}
