'use strict';
/**
 * useMessageHistory.js
 * Persists mesh messages in IndexedDB so they survive page refresh.
 * Auto-clears messages older than 24 hours.
 */
import { useEffect, useCallback } from 'react';

const DB_NAME   = 'meshnet-history';
const DB_VER    = 1;
const STORE     = 'messages';
const MAX_AGE   = 24 * 60 * 60 * 1000;
const MAX_MSGS  = 500;

let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess  = ev => { _db = ev.target.result; res(_db); };
    req.onerror    = ()  => rej(new Error('IndexedDB open failed'));
  });
}

async function saveMessage(msg) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const st  = tx.objectStore(STORE);
    // Don't persist voice blobs — too large
    const toSave = msg.payload?.type === 'VOICE'
      ? { ...msg, payload: { ...msg.payload, chunks: [] } }
      : msg;
    const req = st.put({ ...toSave, savedAt: Date.now() });
    req.onsuccess = res;
    req.onerror   = rej;
  });
}

async function loadMessages() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result ?? []);
    req.onerror   = rej;
  });
}

async function deleteMessage(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = res;
    req.onerror   = rej;
  });
}

async function clearAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = res;
    req.onerror   = rej;
  });
}

async function pruneOld() {
  const db  = await openDB();
  const cutoff = Date.now() - MAX_AGE;
  const all = await loadMessages();
  // Sort by timestamp, keep newest MAX_MSGS, delete rest + old
  const sorted = all.sort((a,b) => b.timestamp - a.timestamp);
  const toDelete = sorted.filter((m, i) => i >= MAX_MSGS || m.timestamp < cutoff);
  for (const m of toDelete) await deleteMessage(m.id);
}

export default function useMessageHistory(messages, setMessages) {
  // Load on mount
  useEffect(() => {
    loadMessages()
      .then(stored => {
        const cutoff = Date.now() - MAX_AGE;
        const valid  = stored
          .filter(m => m.timestamp > cutoff)
          .sort((a, b) => a.timestamp - b.timestamp);
        if (valid.length > 0) setMessages(valid);
      })
      .catch(() => {});
    // Prune old on mount
    pruneOld().catch(() => {});
  }, []);

  // Save new messages as they arrive
  useEffect(() => {
    if (!messages.length) return;
    const last = messages[messages.length - 1];
    if (!last?.id) return;
    saveMessage(last).catch(() => {});
  }, [messages.length]);

  const clearHistory = useCallback(async () => {
    await clearAll();
    setMessages([]);
  }, [setMessages]);

  const exportHistory = useCallback(() => {
    const data = JSON.stringify(messages, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `meshnet-log-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages]);

  return { clearHistory, exportHistory };
}