// i18n 词条 · vectorProvider 域（English）。聚合入口见 ../en.js。
export const vectorProvider = {
  'vectorProvider.openaiEmbeddings': 'OpenAI-compatible',
  // See the zh-CN entry: deliberately not phrased as "invalid config" — the user may simply have
  // come back from a build that shipped more providers. States the fact and why we stopped.
  'vectorProvider.unknownProvider': 'This version does not recognize the saved vector service "{id}", so vector memory was stopped to avoid sending content to an unknown service.',
};
