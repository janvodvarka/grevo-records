import { loadBunnySettings } from './settings';
import { PROXY_URL, UPLOAD_SECRET } from './proxy-config';

export interface UploadResult {
  /** Shareable player page (adaptive bitrate via Bunny Stream). */
  url: string;
  /** Embed URL for <iframe> use. */
  embedUrl?: string;
  /** Bunny Stream video GUID. */
  guid?: string;
}

export type UploadProgress = (loaded: number, total: number, pct: number) => void;

/**
 * WebM recordings at/above this size should not go through in-browser
 * ffmpeg.wasm conversion (slow, 2 GB hard limit). With Bunny Stream this
 * only gates the OFFLINE convert path — Stream transcodes uploads itself.
 */
export const SERVER_CONVERT_THRESHOLD_BYTES = 150 * 1024 * 1024;

export function isWebmMime(mimeType: string): boolean {
  return /webm/i.test(mimeType);
}

export interface UploadOptions {
  /** Max retries on transient failure (default 2 → up to 3 attempts total). */
  maxRetries?: number;
  /** Called once after each failed attempt before retry. */
  onRetry?: (attempt: number, reason: string) => void;
}

class UploadError extends Error {
  constructor(message: string, public transient: boolean) {
    super(message);
  }
}

/**
 * Uploads a recording to the user's Bunny Stream library via the team
 * proxy. Stream transcodes to adaptive-bitrate HLS itself, so WebM and
 * MP4 are both uploaded as-is (no conversion step anywhere).
 */
function singleUploadAttempt(
  blob: Blob,
  filename: string,
  onProgress?: UploadProgress
): Promise<UploadResult> {
  const s = loadBunnySettings();
  if (!s.enabled) {
    return Promise.reject(new UploadError('Bunny upload je vypnutý v Nastavení.', false));
  }
  if (!/^\d+$/.test(s.libraryId.trim())) {
    return Promise.reject(new UploadError('Chybí platné Library ID (číslo).', false));
  }
  if (!s.apiKey.trim()) {
    return Promise.reject(new UploadError('Chybí Stream API klíč.', false));
  }

  const base = PROXY_URL.replace(/\/+$/, '');
  const url =
    `${base}/upload-stream?name=${encodeURIComponent(filename)}` +
    (s.collectionId.trim()
      ? `&collection=${encodeURIComponent(s.collectionId.trim())}`
      : '');

  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('x-upload-secret', UPLOAD_SECRET);
    xhr.setRequestHeader('x-stream-library', s.libraryId.trim());
    xhr.setRequestHeader('x-stream-key', s.apiKey.trim());
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');

    // Explicit: the client must NOT be the one that gives up on a long
    // upload. 0 = no timeout (also the default, stated here so nobody
    // "helpfully" adds one — a 400 MB recording legitimately takes minutes).
    xhr.timeout = 0;

    // Remember how far the body got. `xhr.onerror` carries no diagnostics at
    // all, and "Síťová chyba" with no numbers is unactionable: 0 B means the
    // proxy/CORS never accepted us, while most-of-the-file means the
    // connection was cut mid-body (a timeout somewhere on the path).
    let sentBytes = 0;
    let totalBytes = blob.size;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        sentBytes = e.loaded;
        totalBytes = e.total;
        onProgress?.(e.loaded, e.total, (e.loaded / e.total) * 100);
      }
    };

    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
        resolve({ url: data.url, embedUrl: data.embedUrl, guid: data.guid });
      } else {
        const transient = xhr.status === 0 || xhr.status >= 500;
        // 408/413 are the two statuses that mean "the size/duration of this
        // upload was the problem", not "the network blipped". Say so.
        const sizeHint =
          xhr.status === 408
            ? ' Server ukončil příjem těla requestu (408) — upload trval déle, než dovolil timeout na proxy.'
            : xhr.status === 413
            ? ' Server odmítl velikost těla requestu (413) — platí limit na proxy nebo na edgi.'
            : '';
        reject(
          new UploadError(
            (data?.error ||
              `Upload selhal (${xhr.status}). ${data?.details?.slice(0, 200) ?? ''}`) +
              sizeHint,
            transient
          )
        );
      }
    };
    xhr.onerror = () =>
      reject(
        new UploadError(
          `Síťová chyba po ${mb(sentBytes)} z ${mb(totalBytes)} MB. ` +
            (sentBytes > 0
              ? 'Spojení bylo přerušeno až během nahrávání těla — typicky timeout na proxy nebo na CDN edgi, ne tvoje připojení.'
              : 'Nepodařilo se ani začít — zkontroluj připojení, Proxy URL a CORS.'),
          true
        )
      );
    xhr.ontimeout = () =>
      reject(
        new UploadError(
          `Upload timeout po ${mb(sentBytes)} z ${mb(totalBytes)} MB.`,
          true
        )
      );
    xhr.send(blob);
  });
}

export interface StreamStatus {
  state: 'processing' | 'ready' | 'error';
  encodeProgress: number;
}

/** One-shot check of a Stream video's transcode status via the proxy. */
export async function fetchStreamStatus(guid: string): Promise<StreamStatus> {
  const s = loadBunnySettings();
  const base = PROXY_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/stream-status?guid=${encodeURIComponent(guid)}`, {
    headers: {
      'x-upload-secret': UPLOAD_SECRET,
      'x-stream-library': s.libraryId.trim(),
      'x-stream-key': s.apiKey.trim(),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `Status ${res.status}`);
  }
  return { state: data.state, encodeProgress: data.encodeProgress ?? 0 };
}

/**
 * Polls a Stream video until it finishes transcoding (or errors / times out).
 * Calls onUpdate on every poll. Returns the terminal status. Stops early if
 * the AbortSignal fires (e.g. the component unmounts).
 */
export async function pollStreamStatus(
  guid: string,
  onUpdate: (s: StreamStatus) => void,
  opts: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {}
): Promise<StreamStatus> {
  const interval = opts.intervalMs ?? 5000;
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60 * 1000);
  // A few consecutive read failures shouldn't abort a long transcode.
  let misses = 0;
  while (!opts.signal?.aborted) {
    try {
      const s = await fetchStreamStatus(guid);
      misses = 0;
      onUpdate(s);
      if (s.state === 'ready' || s.state === 'error') return s;
    } catch {
      if (++misses >= 5) return { state: 'processing', encodeProgress: 0 };
    }
    if (Date.now() > deadline) return { state: 'processing', encodeProgress: 0 };
    await new Promise((r) => setTimeout(r, interval));
  }
  return { state: 'processing', encodeProgress: 0 };
}

/** Upload with automatic retry on transient failures (5xx, network errors). */
export async function uploadToBunny(
  blob: Blob,
  filename: string,
  onProgress?: UploadProgress,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const maxRetries = options.maxRetries ?? 2;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await singleUploadAttempt(blob, filename, onProgress);
    } catch (err) {
      const e = err as UploadError;
      const isTransient = e instanceof UploadError ? e.transient : false;
      if (!isTransient || attempt >= maxRetries) {
        throw new Error(e.message);
      }
      attempt += 1;
      const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
      options.onRetry?.(attempt, e.message);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}
