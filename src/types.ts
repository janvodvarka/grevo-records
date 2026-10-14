export interface MediaDevice {
  deviceId: string;
  label: string;
}

/**
 * Non-destructive cut of a recording (the Loom model): the original blob is
 * never rewritten when the user saves. Playback skips the removed parts and
 * the real cut happens on the server during upload (or in the browser when
 * the user downloads the file).
 */
export interface RecordingEdits {
  trimStart: number;
  trimEnd: number;
  deletes: { start: number; end: number }[];
  /** Kept parts in source seconds: what plays, and what the server cuts to. */
  segments: { start: number; end: number }[];
  updatedAt: number;
}

export interface StoredRecording {
  id: string;
  name: string;
  createdAt: number;
  size: number;
  mimeType: string;
  durationMs: number;
  blob: Blob;
  /** Email of the user who created this recording. Used to scope library per user. */
  ownerEmail?: string;
  /** Player-page URL set after a successful Bunny Stream upload. */
  uploadedUrl?: string;
  uploadedAt?: number;
  /** Bunny Stream video GUID (for status polling + management). */
  streamGuid?: string;
  /**
   * Last known Bunny encode status: 'processing' right after upload,
   * 'ready' once transcoded (link is safe to send), 'error' on failure.
   */
  streamStatus?: 'processing' | 'ready' | 'error';
  /** Why the last upload attempt failed (kept so the library can say so). */
  uploadError?: string;
  /** Saved cut, if any. Absent = the whole recording. */
  edits?: RecordingEdits;
}
