// Helpers around the non-destructive cut stored on a recording.

import type { StoredRecording } from '../types';
import { trimToMp4, type ConvertProgress } from './ffmpeg';

export interface Segment {
  start: number;
  end: number;
}

/** Kept segments of a recording, or null when it is uncut. */
export function keptSegments(rec: StoredRecording): Segment[] | null {
  const segs = rec.edits?.segments;
  return segs && segs.length > 0 ? segs : null;
}

/** Length the viewer will actually see, in ms. */
export function editedDurationMs(rec: StoredRecording): number {
  const segs = keptSegments(rec);
  if (!segs) return rec.durationMs;
  return Math.round(segs.reduce((acc, s) => acc + (s.end - s.start), 0) * 1000);
}

/** "a-b,c-d" in seconds, the format the upload proxy parses. */
export function segmentsParam(segs: Segment[]): string {
  return segs.map((s) => `${s.start.toFixed(3)}-${s.end.toFixed(3)}`).join(',');
}

/**
 * The file a user downloads: the original when uncut, otherwise the cut
 * rendered in the browser. This is the one path that still processes video
 * locally (uploads are cut on the server), so it is the slow one.
 */
export async function materialize(
  rec: StoredRecording,
  onProgress?: ConvertProgress
): Promise<{ blob: Blob; name: string }> {
  const segs = keptSegments(rec);
  if (!segs) return { blob: rec.blob, name: rec.name };
  const blob = await trimToMp4(rec.blob, segs, 1, onProgress);
  const base = rec.name.replace(/\.[^.]+$/, '');
  return { blob, name: `${base}-sestrihano.mp4` };
}
