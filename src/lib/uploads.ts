// Background upload manager.
//
// Uploads used to live inside the UploadButton on the preview screen, and the
// auto-upload after recording held the user on a full-screen "Nahrávám na
// Bunny…" until it finished. Now an upload is a job in this module-level
// queue: it keeps running whatever screen is open, the user can record or
// edit meanwhile, watch progress in the tray, and cancel it.
//
// One job runs at a time: parallel uploads would only split the same uplink
// and make every one of them slower. The page must stay open — uploads run
// in the browser — so closing it with an upload in flight asks first.

import { useEffect, useState } from 'react';
import type { StoredRecording } from '../types';
import { getRecording, setStreamStatus, setUploadedUrl } from './storage';
import { pollStreamStatus, uploadToBunny, UPLOAD_CANCELLED } from './upload';
import { keptSegments } from './edits';
import { toast } from './toast';

export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'cutting' // body sent, the server is cutting it
  | 'done'
  | 'error'
  | 'cancelled';

export interface UploadJob {
  id: string;
  recordingId: string;
  /** Title in the Bunny library (the recording's name at upload time). */
  name: string;
  status: UploadStatus;
  loaded: number;
  total: number;
  pct: number;
  hasCut: boolean;
  url?: string;
  error?: string;
  /** Bunny finished processing the uploaded video (link is safe to send). */
  streamReady?: boolean;
  createdAt: number;
}

let jobs: UploadJob[] = [];
const controllers = new Map<string, AbortController>();
const jobListeners = new Set<(jobs: UploadJob[]) => void>();
const recordingListeners = new Set<(rec: StoredRecording) => void>();
let running = false;

function emit() {
  const snapshot = [...jobs];
  for (const l of jobListeners) l(snapshot);
}

function patch(id: string, p: Partial<UploadJob>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...p } : j));
  emit();
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function isActive(j: UploadJob): boolean {
  return j.status === 'queued' || j.status === 'uploading' || j.status === 'cutting';
}

export function hasActiveUploads(): boolean {
  return jobs.some(isActive);
}

/** Most recent job for a recording, active or finished. */
export function latestJobFor(recordingId: string, list: UploadJob[] = jobs): UploadJob | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].recordingId === recordingId) return list[i];
  }
  return undefined;
}

export function useUploadJobs(): UploadJob[] {
  const [state, setState] = useState<UploadJob[]>(jobs);
  useEffect(() => {
    jobListeners.add(setState);
    setState([...jobs]);
    return () => {
      jobListeners.delete(setState);
    };
  }, []);
  return state;
}

/**
 * Fires when a job changes a stored recording (upload finished, Bunny
 * finished processing), so screens holding a copy of it can refresh.
 */
export function onRecordingUpdated(fn: (rec: StoredRecording) => void): () => void {
  recordingListeners.add(fn);
  return () => {
    recordingListeners.delete(fn);
  };
}

function announce(rec: StoredRecording) {
  for (const l of recordingListeners) l(rec);
}

/** Queues an upload; returns the job id (the existing one if already queued). */
export function enqueueUpload(rec: StoredRecording, name: string): string {
  const existing = jobs.find((j) => j.recordingId === rec.id && isActive(j));
  if (existing) return existing.id;
  const job: UploadJob = {
    id: genId(),
    recordingId: rec.id,
    name,
    status: 'queued',
    loaded: 0,
    total: rec.size,
    pct: 0,
    hasCut: !!keptSegments(rec),
    createdAt: Date.now(),
  };
  jobs = [...jobs, job];
  emit();
  void pump();
  return job.id;
}

export function cancelUpload(id: string) {
  const job = jobs.find((j) => j.id === id);
  if (!job || !isActive(job)) return;
  if (job.status === 'queued') {
    patch(id, { status: 'cancelled' });
    return;
  }
  controllers.get(id)?.abort();
}

/** Removes a finished job from the tray. Active jobs cannot be dismissed. */
export function dismissJob(id: string) {
  jobs = jobs.filter((j) => j.id !== id || isActive(j));
  emit();
}

export function dismissFinished() {
  jobs = jobs.filter(isActive);
  emit();
}

async function pump() {
  if (running) return;
  const next = jobs.find((j) => j.status === 'queued');
  if (!next) return;
  running = true;
  try {
    await runJob(next.id);
  } finally {
    running = false;
    void pump();
  }
}

async function runJob(id: string) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  // Read the recording fresh: the user may have changed the cut since queuing.
  const rec = await getRecording(job.recordingId);
  if (!rec) {
    patch(id, { status: 'error', error: 'Nahrávka už neexistuje.' });
    return;
  }
  const segments = keptSegments(rec);
  const ac = new AbortController();
  controllers.set(id, ac);
  patch(id, { status: 'uploading', total: rec.size, hasCut: !!segments });

  try {
    const result = await uploadToBunny(
      rec.blob,
      job.name,
      (loaded, total, pct) =>
        patch(id, {
          loaded,
          total,
          pct,
          status: pct >= 100 && segments ? 'cutting' : 'uploading',
        }),
      {
        segments,
        signal: ac.signal,
        onRetry: (attempt, reason) =>
          toast.warning(`${job.name}: pokus ${attempt} selhal (${reason}). Zkouším znovu…`, {
            title: 'Upload',
            duration: 4000,
          }),
      }
    );
    const updated = await setUploadedUrl(rec.id, result.url, result.guid);
    patch(id, { status: 'done', pct: 100, url: result.url });
    if (updated) announce(updated);
    toast.success(`${job.name} je na Bunny. Hlídám zpracování…`, { title: 'Nahráno' });
    if (result.guid) watchStreamStatus(rec.id, result.guid, job.name);
  } catch (e) {
    const err = e as Error;
    if (err.name === UPLOAD_CANCELLED) {
      patch(id, { status: 'cancelled' });
      toast.info(`Upload zrušen: ${job.name}`);
    } else {
      patch(id, { status: 'error', error: err.message });
      toast.error(err.message, { title: `Upload selhal: ${job.name}` });
    }
  } finally {
    controllers.delete(id);
  }
}

// Bunny encode-status polling lives here too, so the "link je připravený"
// notice arrives even when the user is on another screen.
const polling = new Set<string>();

export function watchStreamStatus(recordingId: string, guid: string, name?: string) {
  if (polling.has(recordingId)) return;
  polling.add(recordingId);
  pollStreamStatus(guid, () => {})
    .then(async (final) => {
      if (final.state === 'processing') return; // timed out, leave as is
      const updated = await setStreamStatus(recordingId, final.state).catch(() => null);
      if (updated) announce(updated);
      if (final.state === 'ready') {
        jobs = jobs.map((j) =>
          j.recordingId === recordingId && j.status === 'done' ? { ...j, streamReady: true } : j
        );
        emit();
      }
      if (final.state === 'ready') {
        toast.success(`${name ?? 'Video'} je zpracované, link je připravený poslat klientovi.`, {
          title: 'Hotovo',
        });
      } else {
        toast.error(`${name ?? 'Video'}: Bunny hlásí chybu při zpracování. Zkus ho nahrát znovu.`, {
          title: 'Zpracování selhalo',
        });
      }
    })
    .catch(() => {})
    .finally(() => polling.delete(recordingId));
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!hasActiveUploads()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
