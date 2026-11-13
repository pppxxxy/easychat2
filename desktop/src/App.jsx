// S1 骨架屏：验证 preload 桥、主进程能力与主题令牌的最小闭环。
// 完整桌面界面在 S2-S4（角色/会话/聊天）逐步替换本入口。
import { useEffect, useState } from 'react';

import { CAPABILITIES } from './platform/capabilities.js';
import { mediaUrl } from './platform/mediaUrl.js';
import { Alert } from './platform/alert.js';

const styles = {
  page: {
    minHeight: '100vh',
    margin: 0,
    background: '#11131a',
    color: '#e7e9f0',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  card: {
    width: 'min(680px, 100%)',
    background: '#1a1d27',
    border: '1px solid #2a2f3d',
    borderRadius: 14,
    padding: 28,
    boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
  },
  title: { fontSize: 22, fontWeight: 800, margin: 0 },
  subtitle: { color: '#9aa3b5', margin: '8px 0 20px', fontSize: 13, lineHeight: 1.7 },
  row: { display: 'flex', justifyContent: 'space-between', gap: 16, padding: '7px 0', borderBottom: '1px solid #232838', fontSize: 13 },
  key: { color: '#9aa3b5' },
  value: { color: '#e7e9f0', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all', textAlign: 'right' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#232838', color: '#9aa3b5', fontSize: 11, marginRight: 6, marginTop: 6 },
  button: { marginTop: 22, padding: '10px 16px', borderRadius: 10, border: 'none', background: '#4c6ef5', color: '#fff', fontWeight: 700, cursor: 'pointer' },
};

export default function App() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const bridge = globalThis.easychat2;
    if (!bridge) {
      setError('preload bridge unavailable');
      return;
    }
    bridge.app.info().then(setInfo).catch(cause => setError(String((cause && cause.message) || cause)));
  }, []);

  const smoke = () => {
    Alert.alert('EasyChat2 Desktop', 'S1 skeleton is alive: preload bridge, platform adapters and IPC are wired.');
    // 顺带验证媒体 URL 映射与能力位（不阻塞 UI）。
    void mediaUrl(`${info && info.documents ? info.documents : 'file:///C:/EasyChat2/documents/'}chat-images/demo.jpg`);
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>EasyChat2 Desktop</h1>
        <p style={styles.subtitle}>
          S1 骨架：Electron 外壳 + preload 白名单 + 平台适配层已接通。
          角色 / 会话 / 聊天界面在后续阶段（S2-S4）接入共享层。
        </p>
        {error ? <div style={{ ...styles.row, color: '#ff8787' }}>{error}</div> : null}
        <div style={styles.row}><span style={styles.key}>Version</span><span style={styles.value}>{info ? info.version : '…'}</span></div>
        <div style={styles.row}><span style={styles.key}>Documents</span><span style={styles.value}>{info ? info.documents : '…'}</span></div>
        <div style={styles.row}><span style={styles.key}>Cache</span><span style={styles.value}>{info ? info.cache : '…'}</span></div>
        <div style={{ marginTop: 18 }}>
          <span style={styles.key}>Capabilities</span>
          <div>
            {Object.entries(CAPABILITIES).filter(([, enabled]) => enabled).map(([name]) => (
              <span key={name} style={styles.badge}>{name}</span>
            ))}
          </div>
        </div>
        <button type="button" style={styles.button} onClick={smoke}>Smoke test (Alert + IPC)</button>
      </div>
    </div>
  );
}
