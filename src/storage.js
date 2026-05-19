import AsyncStorage from '@react-native-async-storage/async-storage';

const API_CONFIG_KEY = '@easychat2_api_config';

export async function getApiConfig() {
  try {
    const raw = await AsyncStorage.getItem(API_CONFIG_KEY);
    return raw ? JSON.parse(raw) : {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: ''
    };
  } catch (error) {
    return { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' };
  }
}

export async function saveApiConfig(config) {
  await AsyncStorage.setItem(API_CONFIG_KEY, JSON.stringify(config));
}
