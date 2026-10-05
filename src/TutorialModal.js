import React from 'react';

import ChapterModal from './books/ChapterModal.js';
import { useTranslation } from './i18n/I18nContext.js';

export default function TutorialModal({ visible, onClose }) {
  const { t } = useTranslation();
  return (
    <ChapterModal
      visible={visible}
      onClose={onClose}
      title={t('tutorial.title')}
      buttonText={t('common.close')}
    />
  );
}
