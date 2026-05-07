'use strict';

/**
 * MessageQueue.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Persistent offline message queue backed by IndexedDB.
 *
 * When a message cannot be delivered immediately (no route to target),
 * it is stored here and flushed when the target becomes reachable.
 *
 * Usage:
 *   const queue = new MessageQueue();
 *   await queue.init();
 *   await queue.enqueue({ targetNodeId, payload, ttl });
 *   const pending = await queue.getAll();
 *   await queue.flush(router, connectedNodeIds);
 *   await queue.remove(id);
 *   await queue.clear();
 */

const DB_NAME    = 'meshnet-queue';
const DB_VERSION = 1;
const STORE      = 'messages';
const MAX_QUEUE  = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export default class MessageQueue {
  constructor() {
    this._db = null;
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  /**
   * Open (or create) the IndexedDB database.
   * Safe to call multiple times — returns immediately if already open.
   */
  async init() {
    if (this._db) return;

    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (ev) => {
        const db    = ev.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('targetNodeId', 'targetNodeId', { unique: false });
          store.createIndex('createdAt',    'createdAt',    { unique: false });
        }
      };

      req.onsuccess  = (ev) => resolve(ev.target.result);
      req.onerror    = ()  => reject(new Error('IndexedDB open failed'));
    });
  }

  // ── Enqueue ───────────────────────────────────────────────────────────────

  /**
   * Add a message to the queue.
   * @param {{ targetNodeId: string, payload: object, ttl?: number }} item
   * @returns {Promise<number>} auto-assigned id
   */
  async enqueue({ targetNodeId, payload, ttl = 7 }) {
    await this.init();
    await this._pruneExpired();

    const count = await this.count();
    if (count >= MAX_QUEUE) {
      // Remove oldest entry to make room
      await this._removeOldest();
    }

    return new Promise((resolve, reject) => {
      const tx    = this._db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const item  = { targetNodeId, payload, ttl, createdAt: Date.now(), attempts: 0 };
      const req   = store.add(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(new Error('Enqueue failed'));
    });
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  /** Return all queued messages. */
  async getAll() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx    = this._db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror   = () => reject(new Error('getAll failed'));
    });
  }

  /** Return messages for a specific target. */
  async getByTarget(targetNodeId) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx    = this._db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const index = store.index('targetNodeId');
      const req   = index.getAll(targetNodeId);
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror   = () => reject(new Error('getByTarget failed'));
    });
  }

  /** Count queued messages. */
  async count() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx    = this._db.transaction(STORE, 'readonly');
      const req   = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(new Error('count failed'));
    });
  }

  // ── Flush ─────────────────────────────────────────────────────────────────

  /**
   * Attempt to deliver all queued messages via the router.
   * Removes successfully sent messages from the queue.
   *
   * @param {import('./Router.js').default} router
   * @param {string[]} reachableNodeIds  – node IDs currently reachable
   * @returns {Promise<{ sent: number, remaining: number }>}
   */
  async flush(router, reachableNodeIds = []) {
    await this.init();
    const all    = await this.getAll();
    const reach  = new Set(reachableNodeIds);
    let   sent   = 0;

    for (const item of all) {
      if (!reach.has(item.targetNodeId)) continue;
      if (item.ttl <= 0) { await this.remove(item.id); continue; }

      try {
        const result = router.send(item.targetNodeId, item.payload, { ttl: item.ttl });
        if (result.sent) {
          await this.remove(item.id);
          sent++;
        } else {
          await this._incrementAttempts(item.id);
        }
      } catch (_) {
        await this._incrementAttempts(item.id);
      }
    }

    const remaining = await this.count();
    return { sent, remaining };
  }

  // ── Remove ────────────────────────────────────────────────────────────────

  async remove(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = resolve;
      req.onerror   = () => reject(new Error('remove failed'));
    });
  }

  async clear() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = resolve;
      req.onerror   = () => reject(new Error('clear failed'));
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _pruneExpired() {
    const cutoff = Date.now() - MAX_AGE_MS;
    const all    = await this.getAll();
    for (const item of all) {
      if (item.createdAt < cutoff) await this.remove(item.id);
    }
  }

  async _removeOldest() {
    const all = await this.getAll();
    if (all.length === 0) return;
    all.sort((a, b) => a.createdAt - b.createdAt);
    await this.remove(all[0].id);
  }

  async _incrementAttempts(id) {
    await this.init();
    return new Promise((resolve) => {
      const tx    = this._db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req   = store.get(id);
      req.onsuccess = () => {
        const item = req.result;
        if (!item) { resolve(); return; }
        item.attempts = (item.attempts ?? 0) + 1;
        store.put(item);
        resolve();
      };
      req.onerror = resolve; // non-fatal
    });
  }
}
