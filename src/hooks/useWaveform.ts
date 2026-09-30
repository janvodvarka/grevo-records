import { useEffect, useState } from 'react';

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

export function useWaveform(blob: Blob | null, samples: number = 240) {
  const [peaks, setPeaks] = useState<number[]>([]);

  useEffect(() => {
    if (!blob) {
      setPeaks([]);
      return;
    }
    if (blob.size > MAX_WAVEFORM_BYTES) {
      console.info(
        `[waveform] skipped: ${blob.size} B exceeds the ${MAX_WAVEFORM_BYTES} B decode budget`
      );
      setPeaks([]);
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
        const ch = audio.getChannelData(0);
        const out = downsamplePeaks(ch, samples);
        setPeaks(out);
      } catch {
        // Decoding may fail for some codecs; we just skip the waveform.
        if (!cancelled) setPeaks([]);
      } finally {
        ctx?.close().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      ctx?.close().catch(() => {});
    };
  }, [blob, samples]);

  return { peaks };
}

function downsamplePeaks(data: Float32Array, target: number): number[] {
  const out: number[] = new Array(target).fill(0);
  if (data.length === 0) return out;
  const step = data.length / target;
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
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
