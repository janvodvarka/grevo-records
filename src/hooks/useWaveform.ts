import { useEffect, useMemo, useState } from 'react';

/**
 * Decodes the audio track of a media blob (mp4/webm) and returns a downsampled
 * peak array suitable for rendering as a waveform on the timeline.
 *
 * Falls back to an empty array if decoding fails (e.g. exotic codec).
 */
/**
 * Above this size the waveform is skipped. `decodeAudioData` needs the whole
 * file in an ArrayBuffer *and* the fully decoded PCM at the same time — for a
 * 400 MB / 10 min recording that is the file (400 MB) plus ~230 MB of
 * float samples, allocated the moment the preview opens and before the user
 * asks for anything. The timeline renders fine without peaks; an
 * out-of-memory tab does not.
 */
const MAX_WAVEFORM_BYTES = 150 * 1024 * 1024;

/**
 * Resolution of the cached envelope. The audio is decoded once, reduced to this
 * many max-abs bins (a few hundred KB instead of hundreds of MB of PCM) and
 * every peak array requested later is derived from it, so zooming the
 * timeline never triggers a second decode.
 */
const ENVELOPE_BINS = 32768;

export function useWaveform(blob: Blob | null, samples: number = 240) {
  const [envelope, setEnvelope] = useState<Float32Array | null>(null);

  useEffect(() => {
    setEnvelope(null);
    if (!blob) return;
    if (blob.size > MAX_WAVEFORM_BYTES) {
      console.info(
        `[waveform] skipped: ${blob.size} B exceeds the ${MAX_WAVEFORM_BYTES} B decode budget`
      );
      return;
    }
    let cancelled = false;
    let ctx: AudioContext | null = null;

    (async () => {
      try {
        const buf = await blob.arrayBuffer();
        if (cancelled) return;
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        // No defensive slice(): decodeAudioData detaches the buffer, and we
        // never touch it again. The copy just doubled peak memory.
        const audio = await ctx.decodeAudioData(buf);
        if (cancelled) return;
        setEnvelope(buildEnvelope(audio.getChannelData(0), ENVELOPE_BINS));
      } catch {
        // Decoding may fail for some codecs; we just skip the waveform.
        if (!cancelled) setEnvelope(null);
      } finally {
        ctx?.close().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      ctx?.close().catch(() => {});
    };
  }, [blob]);

  const peaks = useMemo(
    () => (envelope ? downsamplePeaks(envelope, samples) : []),
    [envelope, samples]
  );
  // Fixed coarse resolution, used for silence detection so its behaviour does
  // not change with the zoom level.
  const basePeaks = useMemo(
    () => (envelope ? downsamplePeaks(envelope, 240) : []),
    [envelope]
  );

  return { peaks, basePeaks };
}

function buildEnvelope(data: Float32Array, bins: number): Float32Array {
  const n = Math.max(1, Math.min(bins, data.length));
  const out = new Float32Array(n);
  const step = data.length / n;
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let max = 0;
    for (let j = start; j < end && j < data.length; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

function downsamplePeaks(data: Float32Array, target: number): number[] {
  const out: number[] = new Array(target).fill(0);
  if (data.length === 0) return out;
  const step = data.length / target;
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let max = 0;
    for (let j = start; j < end && j < data.length; j++) {
      const v = data[j];
      if (v > max) max = v;
    }
    out[i] = max;
  }
  // Normalize so the loudest peak = 1
  let maxAll = 0;
  for (const v of out) if (v > maxAll) maxAll = v;
  if (maxAll > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= maxAll;
  }
  return out;
}
