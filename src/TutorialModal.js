import React from 'react';

import ChapterModal from './ChapterModal';

export default function TutorialModal({ visible, onClose }) {
  return (
    <ChapterModal
      visible={visible}
      onClose={onClose}
      title="使用教程"
      buttonText="关闭"
    />
  );
}
