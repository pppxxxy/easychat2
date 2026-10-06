import React from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  CollapsibleSelect,
  FieldLabel,
  SecondaryButton,
  TextField,
} from '../../ui/index.js';

export default function PersonaSection(props) {
  const {
    styles,
    theme,
    t,
    userName,
    setUserName,
    userPersona,
    setUserPersona,
    userAvatarUri,
    userProfileSaved,
    personas,
    setPersonas,
    activePersonaId,
    saveUserProfileDelayed,
    changeUserAvatar,
    selectPersona,
    addPersona,
    removePersona,
    pickUserAvatar,
    saveUserProfileNow,
  } = props;
  return (
    <>
          <Text style={styles.fieldHint}>
            {t('settings.persona.hint')}
          </Text>
          <FieldLabel style={styles.label}>{t('settings.persona.identity')}</FieldLabel>
          <CollapsibleSelect
            label={t('settings.persona.current')}
            value={activePersonaId}
            valueMeta={userPersona ? userPersona.slice(0, 40) : t('settings.persona.noDescription')}
            options={personas.map(item => ({
              value: item.id,
              label: String(item.userName || '').trim() || t('settings.persona.unnamed'),
              meta: String(item.persona || '').trim().slice(0, 40) || t('settings.persona.noDescription'),
            }))}
            onSelect={id => selectPersona(id)}
            placeholder={t('settings.persona.noneSelected')}
          />
          <View style={styles.personaActions}>
            <TouchableOpacity style={styles.personaAddChip} onPress={addPersona} activeOpacity={0.8}>
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.personaAddText}>{t('settings.persona.add')}</Text>
            </TouchableOpacity>
            {personas.length > 1 ? (
              <TouchableOpacity
                style={styles.personaAddChip}
                onPress={() => removePersona(activePersonaId)}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
                <Text style={[styles.personaAddText, { color: theme.colors.danger }]}>{t('settings.persona.deleteCurrent')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.avatarRow}>
            <View style={styles.avatarBox}>
              {userAvatarUri ? (
                <Image source={{ uri: userAvatarUri }} style={styles.avatarImg} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarPlaceholderText}>
                    {userName ? userName.charAt(0) : t('settings.persona.avatarFallback')}
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.imageActions}>
              <TouchableOpacity style={styles.smallButton} onPress={pickUserAvatar} activeOpacity={0.8}>
                <Text style={styles.smallButtonText}>{userAvatarUri ? t('settings.persona.changeAvatar') : t('settings.persona.pickAvatar')}</Text>
              </TouchableOpacity>
              {userAvatarUri ? (
                <TouchableOpacity onPress={() => changeUserAvatar('')} hitSlop={8}>
                  <Text style={styles.removeText}>{t('settings.persona.clear')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
          <FieldLabel style={styles.label}>{t('settings.persona.name')}</FieldLabel>
          <TextField
            value={userName}
            onChangeText={text => {
              setUserName(text);
              setPersonas(list => list.map(item => (
                item.id === activePersonaId ? { ...item, userName: text } : item
              )));
              saveUserProfileDelayed(text, userPersona, userAvatarUri);
            }}
            placeholder={t('settings.persona.namePlaceholder')}
          />
          <FieldLabel style={styles.label}>{t('settings.persona.description')}</FieldLabel>
          <TextField
            style={styles.multilineInput}
            value={userPersona}
            onChangeText={text => { setUserPersona(text); saveUserProfileDelayed(userName, text, userAvatarUri); }}
            placeholder={t('settings.persona.descriptionPlaceholder')}
            multiline
            textAlignVertical="top"
          />
          <SecondaryButton
            title={t('settings.persona.save')}
            icon="save-outline"
            onPress={saveUserProfileNow}
            style={styles.actionBtn}
          />
          {userProfileSaved ? <Text style={styles.savedHint}>{t('settings.persona.autoSaved')}</Text> : null}
    </>
  );
}
