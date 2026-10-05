import { useEffect, useRef, useState } from 'react';

/** Finest grid: the video is divided into this many cells at most. */
const GRID = 128;

/**
 * Generates thumbnail data URLs from a video blob, in the browser, using a
 * private offscreen <video> (never the player's own element).
 *
 * Thumbnails live in a cache keyed by cell index on a fixed power-of-two grid,
 * so a finer level (more thumbnails after zooming in) reuses every frame of the
 * coarser ones and only the missing cells are generated. While new cells are
 * still loading, each gap shows the nearest cached frame, so the strip never
 * goes blank. `count` is snapped to a power of two between 1 and 128.
 */
export function useThumbnails(blob: Blob | null, count: number = 16, height: number = 56) {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const cacheRef = useRef<Map<number, string>>(new Map());
  const wantedRef = useRef(16);
  const kickRef = useRef<() => void>(() => {});
  const [version, setVersion] = useState(0);

  const level = snapCount(count);
  wantedRef.current = level;

  // Worker: lives as long as the blob does.
  useEffect(() => {
    cacheRef.current = new Map();
    setThumbnails([]);
    setVersion((v) => v + 1);
    if (!blob) return;

    let cancelled = false;
    let running = false;
    let video: HTMLVideoElement | null = null;
    let url: string | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let w = 0;
    let dur = 0;
    let ready: Promise<boolean> | null = null;

    const cleanup = () => {
      if (video) video.src = '';
      if (url) URL.revokeObjectURL(url);
      video = null;
      url = null;
    };

    const init = (): Promise<boolean> =>
      new Promise((resolve) => {
        url = URL.createObjectURL(blob);
        video = document.createElement('video');
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        video.onloadedmetadata = () => {
          const v = video!;
          dur = v.duration;
          if (!isFinite(dur) || dur <= 0) return resolve(false);
          const ratio = v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 16 / 9;
          w = Math.round(height * ratio);
          canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = height;
          ctx = canvas.getContext('2d');
          resolve(!!ctx);
        };
        video.onerror = () => resolve(false);
      });

    const pump = async () => {
      if (running || cancelled) return;
      running = true;
      setLoading(true);
      try {
        if (!ready) ready = init();
        if (!(await ready) || cancelled) return;
        // Re-read the wanted level every iteration, so a zoom change while
        // generating simply redirects the queue.
        for (;;) {
          if (cancelled) return;
          const lvl = wantedRef.current;
          const stride = GRID / lvl;
          let next = -1;
          for (let i = 0; i < lvl; i++) {
            if (!cacheRef.current.has(i * stride)) {
              next = i * stride;
              break;
            }
          }
          if (next < 0) break;
          const t = (next / GRID) * Math.max(0, dur - 0.05);
          await seek(video!, t);
          if (cancelled) return;
          ctx!.drawImage(video!, 0, 0, w, height);
          cacheRef.current.set(next, canvas!.toDataURL('image/jpeg', 0.6));
          setVersion((v) => v + 1);
        }
      } catch {
        // best-effort
      } finally {
        running = false;
        if (!cancelled) setLoading(false);
      }
    };

    kickRef.current = () => {
      void pump();
    };
    void pump();

    return () => {
      cancelled = true;
      kickRef.current = () => {};
      cleanup();
    };
  }, [blob, height]);

  // Level changed: wake the worker (no-op if it is already running).
  useEffect(() => {
    kickRef.current();
  }, [level]);

  // Build the displayed array: nearest cached frame fills the gaps.
  useEffect(() => {
    const cache = cacheRef.current;
    if (cache.size === 0) {
      setThumbnails((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const keys = Array.from(cache.keys()).sort((a, b) => a - b);
    const stride = GRID / level;
    const out: string[] = [];
    for (let i = 0; i < level; i++) {
      const want = i * stride;
      let best = keys[0];
      let bestD = Math.abs(best - want);
      for (const k of keys) {
        const d = Math.abs(k - want);
        if (d < bestD) {
          best = k;
          bestD = d;
        }
        if (k > want) break;
      }
      out.push(cache.get(best)!);
    }
    setThumbnails(out);
  }, [version, level]);

  return { thumbnails, loading };
}

function snapCount(count: number): number {
  let n = 1;
  while (n < count && n < GRID) n *= 2;
  return Math.max(1, n);
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', handle);
      resolve();
    };
    // Safety net: some browsers skip `seeked` for a no-op seek.
    const timer = setTimeout(handle, 4000);
    video.addEventListener('seeked', handle);
    video.currentTime = t;
  });
}
