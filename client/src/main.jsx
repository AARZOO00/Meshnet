import React from 'react';
import ReactDOM from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import App from './App.jsx';

// ── Tailwind base styles ──────────────────────────────────────────────────────
import './index.css';

// NOTE: StrictMode is intentionally omitted — it double-invokes effects in dev
// which conflicts with the one-time WebRTC boot sequence.
// Re-enable StrictMode only if you add idempotent cleanup to the boot effect.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);