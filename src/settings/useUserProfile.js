// 用户人设域：人设列表、当前人设、头像与防抖落盘。
//
// 从 src/SettingsScreen.js 原样抽出（该域与 API / 向量 / 采样等设置域零交叉，
// 可独立搬运）。对外暴露与原来同名的状态与操作，使设置页 JSX 无需改动。
// 含防抖保存队列：编辑即时改内存、600ms 防抖落盘；切换人设/删除等先 flush 再操作。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import {
  createPersona,
  deletePersona,
  getActivePersonaId,
  getPersonas,
  getUserProfile,
  saveUserProfile,
  setActivePersonaId,
} from '../storage/personas.js';
import { markMediaWrite } from '../storage/mediaProtection.js';
import { getPickedAsset } from '../character/cardHelpers.js';
import { useTranslation } from '../i18n/I18nContext.js';

export default function useUserProfile() {
  const { t } = useTranslation();
  const [userName, setUserName] = useState('');
  const [userPersona, setUserPersona] = useState('');
  const [userAvatarUri, setUserAvatarUri] = useState('');
  const [userProfileLoaded, setUserProfileLoaded] = useState(false);
  const [userProfileSaved, setUserProfileSaved] = useState(false);
  const [personas, setPersonas] = useState([]);
  const [activePersonaId, setActivePersonaIdState] = useState('');
  const profileTimerRef = useRef(null);
  const profileHintTimerRef = useRef(null);
  const profileSavingRef = useRef(null);
  const profileWriteQueueRef = useRef(Promise.resolve());
  const profileRevisionRef = useRef(0);
  const lastSavedProfileRef = useRef(null);
  const profileFlushRef = useRef(null);
  const profileMountedRef = useRef(true);
  const profileStateRef = useRef(null);
  profileStateRef.current = { userName, persona: userPersona, avatarUri: userAvatarUri };

  useEffect(() => {
    profileMountedRef.current = true;
    return () => {
      profileFlushRef.current?.();
      profileMountedRef.current = false;
      clearTimeout(profileTimerRef.current);
      clearTimeout(profileHintTimerRef.current);
    };
  }, []);

  const flushUserProfile = useCallback(async () => {
    if (profileTimerRef.current) {
      clearTimeout(profileTimerRef.current);
      profileTimerRef.current = null;
    }
    const snapshot = profileStateRef.current;
    if (!snapshot) return true;
    const revision = profileRevisionRef.current;
    const saving = profileWriteQueueRef.current.then(() => saveUserProfile(snapshot));
    profileWriteQueueRef.current = saving.catch(() => {});
    profileSavingRef.current = saving;
    try {
      await saving;
      const previous = lastSavedProfileRef.current;
      lastSavedProfileRef.current = snapshot;
      if (
        previous
        && previous.avatarUri
        && previous.avatarUri !== snapshot.avatarUri
        && String(previous.avatarUri).includes('/user-avatar-')
      ) {
        FileSystem.deleteAsync(previous.avatarUri, { idempotent: true }).catch(() => {});
      }
      if (profileMountedRef.current && revision === profileRevisionRef.current) {
        setUserProfileSaved(true);
        clearTimeout(profileHintTimerRef.current);
        profileHintTimerRef.current = setTimeout(() => setUserProfileSaved(false), 2000);
      }
      return true;
    } catch (error) {
      if (profileMountedRef.current) {
        Alert.alert(t('settings.profile.alert.saveFailed.title'), t('settings.profile.alert.saveFailed.body'));
      }
      return false;
    } finally {
      if (profileSavingRef.current === saving) profileSavingRef.current = null;
    }
  }, [t]);
  profileFlushRef.current = flushUserProfile;

  const saveUserProfileDelayed = useMemo(() => {
    return (name, persona, avatar) => {
      profileStateRef.current = {
        userName: name,
        persona,
        avatarUri: avatar ?? profileStateRef.current?.avatarUri,
      };
      profileRevisionRef.current += 1;
      setUserProfileSaved(false);
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      profileTimerRef.current = setTimeout(() => {
        flushUserProfile();
      }, 600);
    };
  }, [flushUserProfile]);

  const changeUserAvatar = avatarUri => {
    if (!userProfileLoaded || !profileMountedRef.current) return;
    setUserAvatarUri(avatarUri);
    const profile = profileStateRef.current;
    saveUserProfileDelayed(profile.userName, profile.persona, avatarUri);
  };

  const refreshPersonas = useCallback(async () => {
    try {
      const list = await getPersonas();
      const id = await getActivePersonaId(list);
      setPersonas(list);
      setActivePersonaIdState(id);
      const active = list.find(item => item.id === id);
      const next = {
        userName: active ? active.userName : '',
        persona: active ? active.persona : '',
        avatarUri: profileStateRef.current?.avatarUri || '',
      };
      profileStateRef.current = next;
      lastSavedProfileRef.current = next;
      setUserName(next.userName);
      setUserPersona(next.persona);
    } catch (error) {}
  }, []);

  const selectPersona = async id => {
    if (id === activePersonaId) return;
    const saved = await flushUserProfile();
    if (!saved) return;
    try {
      const resolved = await setActivePersonaId(id);
      setActivePersonaIdState(resolved);
      await refreshPersonas();
    } catch (error) {
      Alert.alert(t('settings.profile.alert.switchFailed.title'), t('settings.profile.alert.switchFailed.body'));
    }
  };

  const addPersona = async () => {
    const saved = await flushUserProfile();
    if (!saved) return;
    try {
      await createPersona({ userName: '', persona: '' });
      await refreshPersonas();
    } catch (error) {
      Alert.alert(t('settings.profile.alert.addFailed.title'), t('settings.profile.alert.addFailed.body'));
    }
  };

  const removePersona = id => {
    if (personas.length <= 1) {
      Alert.alert(t('settings.profile.alert.cannotDelete.title'), t('settings.profile.alert.cannotDelete.body'));
      return;
    }
    Alert.alert(t('settings.profile.alert.delete.title'), t('settings.profile.alert.delete.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          const saved = await flushUserProfile();
          if (!saved) return;
          try {
            await deletePersona(id);
            await refreshPersonas();
          } catch (error) {
            Alert.alert(t('settings.profile.alert.deleteFailed.title'), t('settings.profile.alert.deleteFailed.body'));
          }
        },
      },
    ]);
  };

  const pickUserAvatar = async () => {
    if (!userProfileLoaded) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = getPickedAsset(result);
      if (!asset?.uri) return;
      const dir = `${FileSystem.documentDirectory}avatars/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const mime = String(asset.mimeType || '').toLowerCase();
      const ext = mime === 'image/png' || /\.png(?:$|\?)/i.test(asset.uri) ? '.png' : '.jpg';
      const dest = `${dir}user-avatar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      markMediaWrite(dest);
      await FileSystem.copyAsync({ from: asset.uri, to: dest });
      changeUserAvatar(dest);
    } catch (error) {
      Alert.alert(t('settings.profile.alert.avatarFailed.title'), t('settings.profile.alert.avatarFailed.body'));
    }
  };

  const saveUserProfileNow = async () => {
    if (!userProfileLoaded) return;
    const saved = await flushUserProfile();
    if (saved) Alert.alert(t('settings.profile.alert.saved.title'), t('settings.profile.alert.saved.body'));
  };

  // 加载：人设列表、激活人设与用户资料。挂载时调用一次。
  const loadUserProfile = useCallback(() => {
    getPersonas()
      .then(list => {
        setPersonas(list);
        return getActivePersonaId(list);
      })
      .then(id => setActivePersonaIdState(id))
      .catch(() => {});
    return getUserProfile()
      .then(profile => {
        const next = {
          userName: profile.userName,
          persona: profile.persona,
          avatarUri: profile.avatarUri || '',
        };
        profileStateRef.current = next;
        lastSavedProfileRef.current = next;
        setUserName(next.userName);
        setUserPersona(next.persona);
        setUserAvatarUri(next.avatarUri);
      })
      .catch(() => {})
      .finally(() => setUserProfileLoaded(true));
  }, []);

  return {
    userName,
    setUserName,
    userPersona,
    setUserPersona,
    userAvatarUri,
    setUserAvatarUri,
    userProfileLoaded,
    userProfileSaved,
    personas,
    setPersonas,
    activePersonaId,
    profileStateRef,
    loadUserProfile,
    flushUserProfile,
    saveUserProfileDelayed,
    changeUserAvatar,
    refreshPersonas,
    selectPersona,
    addPersona,
    removePersona,
    pickUserAvatar,
    saveUserProfileNow,
  };
}
