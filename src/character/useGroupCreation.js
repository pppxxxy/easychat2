import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { ROUTE_NAMES } from '../navigation/routeNames.js';
import { createGroupSession } from '../storage/sessions.js';

// 群聊创建的状态与编排：成员选择（上限 8）、头像/背景挑选、创建会话与跳转。
// 从 CharacterLibraryScreen 原样搬出（行为不变），依赖经参数注入。
export default function useGroupCreation({ characters, refreshSessions, navigation, t }) {
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [groupSelected, setGroupSelected] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [groupAvatarUri, setGroupAvatarUri] = useState('');
  const [groupBgUri, setGroupBgUri] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);

  const toggleGroupMember = useCallback(id => {
    if (!groupSelected.includes(id) && groupSelected.length >= 8) {
      Alert.alert(t('character.library.group.limit.title'), t('character.library.group.limit.body'));
      return;
    }
    setGroupSelected(current => (
      current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id]
    ));
  }, [groupSelected, t]);

  const onCreateGroup = useCallback(async () => {
    if (groupSelected.length < 2 || groupSelected.length > 8) {
      Alert.alert(t('character.library.group.count.title'), t('character.library.group.count.body'));
      return;
    }
    if (creatingGroup) return;
    setCreatingGroup(true);
    try {
      const members = groupSelected.slice();
      const fallbackName = characters
        .filter(item => members.includes(item.id))
        .map(item => item.name || t('common.unnamedCharacter'))
        .join(t('character.library.group.nameJoin'));
      await createGroupSession(members, groupName.trim() || fallbackName, {
        avatarUri: groupAvatarUri,
        bgUri: groupBgUri,
      });
      try {
        await refreshSessions();
      } catch (error) {
        Alert.alert(t('character.library.group.created.title'), t('character.library.group.created.body'));
        return;
      }
      setGroupPanelOpen(false);
      setGroupSelected([]);
      setGroupName('');
      setGroupAvatarUri('');
      setGroupBgUri('');
      navigation.navigate(ROUTE_NAMES.chat);
    } catch (error) {
      Alert.alert(t('character.library.group.createFail.title'), t('common.error.storageOrPermission'));
    } finally {
      setCreatingGroup(false);
    }
  }, [characters, creatingGroup, groupAvatarUri, groupBgUri, groupName, groupSelected, navigation, refreshSessions, t]);

  return {
    groupPanelOpen,
    setGroupPanelOpen,
    groupSelected,
    groupName,
    setGroupName,
    groupAvatarUri,
    setGroupAvatarUri,
    groupBgUri,
    setGroupBgUri,
    creatingGroup,
    toggleGroupMember,
    onCreateGroup,
  };
}
