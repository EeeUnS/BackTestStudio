import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './style.css';
import './preview-theme.css';
import './phase2.css';

const root = document.getElementById('root');
if (!root) { throw new Error('앱 마운트 지점이 없습니다.'); }
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
