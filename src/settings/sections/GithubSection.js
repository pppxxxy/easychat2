import React from 'react';
import { Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  FieldHint,
  FieldLabel,
  GhostButton,
  SecondaryButton,
} from '../../ui/index.js';
import SecretTextField from '../SecretTextField.js';

export default function GithubSection(props) {
  const {
    styles,
    theme,
    t,
    githubMcp,
    githubPat,
    setGithubPat,
    githubBusy,
    connectGithubPat,
    connectGithubWeb,
    disconnectGithub,
  } = props;
  return (
    <>
          <FieldHint style={styles.hint}>{t('settings.github.subtitle')}</FieldHint>
          {githubMcp && githubMcp.enabled && githubMcp.connectedAt > 0 ? (
            <>
              <View style={styles.capabilityRow}>
                <View style={styles.linkLeft}>
                  <Ionicons name="checkmark-circle-outline" size={17} color={theme.colors.primary} />
                  <Text style={styles.linkText}>
                    {t('settings.github.connected', {
                      login: githubMcp.accountLogin || t('settings.github.connected.anonymous'),
                      count: githubMcp.toolCatalog.length,
                    })}
                  </Text>
                </View>
              </View>
              <FieldHint style={styles.hint}>{t('settings.github.riskHint')}</FieldHint>
              <View style={styles.formActions}>
                <GhostButton title={t('settings.github.disconnect.action')} small onPress={disconnectGithub} />
              </View>
            </>
          ) : (
            <>
              <FieldLabel style={styles.label}>{t('settings.github.pat.label')}</FieldLabel>
              <SecretTextField
                value={githubPat}
                onChangeText={setGithubPat}
                placeholder={t('settings.github.pat.placeholder')}
                theme={theme}
                styles={styles}
              />
              <FieldHint style={styles.hint}>{t('settings.github.pat.hint')}</FieldHint>
              <View style={styles.formActions}>
                <GhostButton
                  title={githubBusy ? t('settings.github.busy') : t('settings.github.pat.action')}
                  small
                  onPress={connectGithubPat}
                />
                <SecondaryButton
                  title={t('settings.github.web.action')}
                  small
                  onPress={connectGithubWeb}
                />
              </View>
              <FieldHint style={styles.hint}>{t('settings.github.web.hint')}</FieldHint>
              <FieldHint style={styles.hint}>{t('settings.github.riskHint')}</FieldHint>
            </>
          )}
    </>
  );
}
