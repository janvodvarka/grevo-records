// IndexedDB persistent storage for recordings.
// Each recording is one row: id, name, createdAt, size, mimeType, durationMs, blob.
// Recordings are filtered by ownerEmail so each logged-in user sees only their own.

import type { StoredRecording } from '../types';
import { currentSession } from './auth';

const DB_NAME = 'video-recorder';
const DB_VERSION = 2;
const STORE = 'recordings';
// Live recording buffer — chunks are appended here every ~1 s while recording
// so a tab/browser crash never loses more than the last second.
const BUFFER_STORE = 'recording-buffer';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1: recordings store — MUST be preserved on upgrade (create only if missing)
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt');
      }
      // v2: crash-safe live-recording chunk buffer
      if (!db.objectStoreNames.contains(BUFFER_STORE)) {
        const os = db.createObjectStore(BUFFER_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        os.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode: IDBTransactionMode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function bufferTx(mode: IDBTransactionMode) {
  return openDb().then((db) =>
    db.transaction(BUFFER_STORE, mode).objectStore(BUFFER_STORE)
  );
}

function genId() {
  return (
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  );
}

export async function saveRecording(input: {
  blob: Blob;
  name: string;
  durationMs: number;
  mimeType: string;
}): Promise<StoredRecording> {
  const session = currentSession();
  const rec: StoredRecording = {
    id: genId(),
    name: input.name,
    createdAt: Date.now(),
    size: input.blob.size,
    mimeType: input.mimeType,
    durationMs: input.durationMs,
    blob: input.blob,
    ownerEmail: session?.email,
  };
  const store = await tx('readwrite');
  await req(store.add(rec));
  return rec;
}

export async function listRecordings(): Promise<StoredRecording[]> {
  const session = currentSession();
  const email = session?.email;
  const store = await tx('readonly');
  const all = await req<StoredRecording[]>(store.getAll());
  return all
    .filter((r) => {
      // Legacy recordings without ownerEmail are visible to everyone (one-time grace).
      if (!r.ownerEmail) return true;
      return r.ownerEmail === email;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRecording(id: string): Promise<StoredRecording | null> {
  const store = await tx('readonly');
  return (await req<StoredRecording | undefined>(store.get(id))) ?? null;
}

export async function renameRecording(id: string, name: string): Promise<void> {
  const store = await tx('readwrite');
  const rec = await req<StoredRecording | undefined>(store.get(id));
  if (!rec) return;
  rec.name = name;
  await req(store.put(rec));
}

/**
 * Overwrites a recording's content in place ("Uložit změny" in the trim
 * editor). Clears uploadedUrl — the old CDN copy no longer matches.
 */
export async function replaceRecordingBlob(
  id: string,
  input: { blob: Blob; mimeType: string; durationMs: number }
): Promise<StoredRecording | null> {
  const store = await tx('readwrite');
  const rec = await req<StoredRecording | undefined>(store.get(id));
  if (!rec) return null;
  rec.blob = input.blob;
  rec.size = input.blob.size;
  rec.mimeType = input.mimeType;
  rec.durationMs = input.durationMs;
  // Keep the base name, fix the extension to match the new content.
  const ext = input.mimeType.includes('mp4') ? 'mp4' : 'webm';
  rec.name = rec.name.replace(/\.[^.]+$/, '') + '.' + ext;
  rec.uploadedUrl = undefined;
  rec.uploadedAt = undefined;
  await req(store.put(rec));
  return rec;
}

export async function setUploadedUrl(
  id: string,
  uploadedUrl: string,
  streamGuid?: string
): Promise<StoredRecording | null> {
  const store = await tx('readwrite');
  const rec = await req<StoredRecording | undefined>(store.get(id));
  if (!rec) return null;
  rec.uploadedUrl = uploadedUrl;
  rec.uploadedAt = Date.now();
  if (streamGuid) rec.streamGuid = streamGuid;
  rec.streamStatus = 'processing';
  await req(store.put(rec));
  return rec;
}

/** Update the Bunny encode status once polling learns the outcome. */
export async function setStreamStatus(
  id: string,
  status: 'processing' | 'ready' | 'error'
): Promise<StoredRecording | null> {
  const store = await tx('readwrite');
  const rec = await req<StoredRecording | undefined>(store.get(id));
  if (!rec) return null;
  rec.streamStatus = status;
  await req(store.put(rec));
  return rec;
}

export async function deleteRecording(id: string): Promise<void> {
  const store = await tx('readwrite');
  await req(store.delete(id));
}

function req<T = unknown>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

export async function estimateStorage(): Promise<{
  usage: number;
  quota: number;
  persisted: boolean;
} | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  let persisted = false;
  try {
    persisted = (await navigator.storage.persisted?.()) ?? false;
  } catch {}
  return { usage, quota, persisted };
}

/**
 * Asks the browser to make this origin's storage persistent, so recordings
 * are never silently evicted when the disk gets tight. Does NOT raise the
 * quota (that is disk-derived and browser-controlled) — it only protects
 * what is already stored. Safe to call repeatedly; returns the final state.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// ─────────────────── Crash-safe recording buffer ───────────────────
// While a recording is live, every MediaRecorder chunk is appended here.
// On a clean stop the session is assembled into one Blob and deleted.
// If the tab/browser dies, the chunks survive and can be recovered on
// next app start (see listBufferSessions / recoverBufferSession).

export interface BufferChunkRecord {
  id?: number; // autoincrement
  sessionId: string;
  seq: number;
  mimeType: string;
  createdAt: number;
  chunk: Blob;
}

export interface BufferSessionInfo {
  sessionId: string;
  chunkCount: number;
  totalBytes: number;
  mimeType: string;
  /** createdAt of the newest chunk — used to skip sessions that are still live. */
  lastChunkAt: number;
  firstChunkAt: number;
}

export async function appendBufferChunk(input: {
  sessionId: string;
  seq: number;
  mimeType: string;
  chunk: Blob;
}): Promise<void> {
  const store = await bufferTx('readwrite');
  await req(
    store.add({
      sessionId: input.sessionId,
      seq: input.seq,
      mimeType: input.mimeType,
      createdAt: Date.now(),
      chunk: input.chunk,
    } satisfies BufferChunkRecord)
  );
}

/** All chunk rows of a session, ordered by seq (exposed for the recorder's merge logic). */
export async function readBufferChunks(
  sessionId: string
): Promise<BufferChunkRecord[]> {
  const store = await bufferTx('readonly');
  const index = store.index('sessionId');
  const rows = await req<BufferChunkRecord[]>(index.getAll(sessionId));
  return rows.sort((a, b) => a.seq - b.seq);
}

/** Reads all chunks of a session, ordered by seq. */
export async function readBufferSession(
  sessionId: string
): Promise<{ chunks: Blob[]; mimeType: string } | null> {
  const rows = await readBufferChunks(sessionId);
  if (rows.length === 0) return null;
  return {
    chunks: rows.map((r) => r.chunk),
    mimeType: rows[0].mimeType || 'video/webm',
  };
}

export async function deleteBufferSession(sessionId: string): Promise<void> {
  const store = await bufferTx('readwrite');
  const index = store.index('sessionId');
  const keys = await req<IDBValidKey[]>(index.getAllKeys(sessionId));
  for (const key of keys) {
    await req(store.delete(key));
  }
}

/** Summarizes all sessions present in the buffer (for crash recovery). */
export async function listBufferSessions(): Promise<BufferSessionInfo[]> {
  const store = await bufferTx('readonly');
  const rows = await req<BufferChunkRecord[]>(store.getAll());
  const bySession = new Map<string, BufferSessionInfo>();
  for (const r of rows) {
    const info = bySession.get(r.sessionId);
    if (!info) {
      bySession.set(r.sessionId, {
        sessionId: r.sessionId,
        chunkCount: 1,
        totalBytes: r.chunk?.size ?? 0,
        mimeType: r.mimeType || 'video/webm',
        lastChunkAt: r.createdAt,
        firstChunkAt: r.createdAt,
      });
    } else {
      info.chunkCount += 1;
      info.totalBytes += r.chunk?.size ?? 0;
      info.lastChunkAt = Math.max(info.lastChunkAt, r.createdAt);
      info.firstChunkAt = Math.min(info.firstChunkAt, r.createdAt);
    }
  }
  return [...bySession.values()].sort((a, b) => a.firstChunkAt - b.firstChunkAt);
}

/**
 * Assembles an orphaned buffer session into a library recording,
 * then deletes the buffer. Returns null if the session vanished.
 */
export async function recoverBufferSession(
  sessionId: string
): Promise<StoredRecording | null> {
  const data = await readBufferSession(sessionId);
  if (!data || data.chunks.length === 0) return null;
  const blob = new Blob(data.chunks, { type: data.mimeType });
  const ext = data.mimeType.includes('mp4') ? 'mp4' : 'webm';
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `recovered-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )}_${pad(d.getHours())}-${pad(d.getMinutes())}.${ext}`;
  const rec = await saveRecording({
    blob,
    name,
    durationMs: 0, // unknown — the recorder died before reporting
    mimeType: data.mimeType,
  });
  await deleteBufferSession(sessionId);
  return rec;
}
