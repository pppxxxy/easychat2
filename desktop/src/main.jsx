import { createRoot } from 'react-dom/client';

// 顺序敏感：polyfills 必须先于任何共享层模块执行（Buffer / XMLHttpRequest）。
import './polyfills.js';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
