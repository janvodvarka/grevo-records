// In-browser WebM → MP4 conversion, ported from the user's vidslim project.
//
// Two cores, picked at runtime:
// - /ffmpeg    → multithreaded (needs SharedArrayBuffer via COOP/COEP headers,
//                i.e. crossOriginIsolated). ~4x faster.
// - /ffmpeg-st → single-threaded fallback when isolation is unavailable.
//
// Critical encode flags (learned the hard way):
// - `-vf fps=30`     — MediaRecorder WebM reports a bogus 1000 fps nominal
//   rate; default CFR duplicated frames (20 s clip → 10+ min encode) and
//   plain VFR passthrough stuttered in QuickTime/Safari. The fps filter
//   resamples by real PTS to smooth CFR 30.
// - `-threads 4|1`   — x264 auto-threading exceeds the wasm pthread pool and
//   aborts the core; pin explicitly.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let loadedMt = false;

export type ConvertProgress = (
  pct: number,
  stage: 'loading' | 'converting'
) => void;

export type TrimPathInfo = {
  path: 'smart-cut' | 're-encode';
  reason?: string;
  ms: number;
};

let lastTrimPath: TrimPathInfo | null = null;

/** Which path the most recent trimToMp4 call took (null before the first). */
export function getLastTrimPath(): TrimPathInfo | null {
  return lastTrimPath;
}

/** MP4 by MIME type, or by 'ftyp' box at bytes 4..8 when the type is empty. */
async function isMp4(blob: Blob): Promise<boolean> {
  if (/mp4/i.test(blob.type)) return true;
  if (blob.type) return false;
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    return String.fromCharCode(...head.slice(4, 8)) === 'ftyp';
  } catch {
    return false;
  }
}

/** Multithreaded core needs SharedArrayBuffer (COOP/COEP → crossOriginIsolated). */
export function useMultithreaded(): boolean {
  const forced = new URLSearchParams(location.search).get('core');
  if (forced === 'st') return false;
  if (forced === 'mt') return true;
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

async function loadCore(
  ffmpeg: FFmpeg,
  mt: boolean,
  onProgress?: ConvertProgress
): Promise<void> {
  const base = new URL(mt ? '/ffmpeg' : '/ffmpeg-st', window.location.href).toString();
  onProgress?.(10, 'loading');
  // Blob URLs: the internal worker dynamic-imports the core — must be
  // importable from the worker context regardless of origin quirks.
  const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
  onProgress?.(40, 'loading');
  const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm');
  onProgress?.(85, 'loading');
  const workerURL = mt
    ? await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript')
    : undefined;
  // load() hangs forever if the worker is silently blocked (e.g. COEP
  // mismatch on the worker script) — cap it so the failure is visible
  // and the ST fallback can kick in.
  await Promise.race([
    ffmpeg.load({ coreURL, wasmURL, workerURL }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`ffmpeg ${mt ? 'MT' : 'ST'} load timeout (60 s)`)),
        60_000
      )
    ),
  ]);
  onProgress?.(100, 'loading');
}

function getFFmpeg(onProgress?: ConvertProgress): Promise<FFmpeg> {
  if (instance) return Promise.resolve(instance);
  if (loading) return loading;

  loading = (async () => {
    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', () => {});
    const wantMt = useMultithreaded();
    try {
      await loadCore(ffmpeg, wantMt, onProgress);
      loadedMt = wantMt;
    } catch (mtErr) {
      if (!wantMt) {
        loading = null;
        throw new Error(
          'ffmpeg.wasm se nepodařilo načíst: ' +
            (mtErr instanceof Error ? mtErr.message : String(mtErr))
        );
      }
      // MT core failed (isolation edge case) → retry single-threaded.
      console.warn('[ffmpeg] MT core failed, falling back to ST:', mtErr);
      try {
        await loadCore(ffmpeg, false, onProgress);
        loadedMt = false;
      } catch (stErr) {
        loading = null;
        throw new Error(
          'ffmpeg.wasm se nepodařilo načíst (MT i ST): ' +
            (stErr instanceof Error ? stErr.message : String(stErr))
        );
      }
    }
    instance = ffmpeg;
    return ffmpeg;
  })();
  return loading;
}

export function isFFmpegReady(): boolean {
  return instance !== null;
}

/** Warm up the engine (~31 MB wasm) ahead of time, e.g. on app load. */
export function preloadFFmpeg(): void {
  getFFmpeg().catch(() => {});
}

/**
 * Converts a WebM blob to MP4 (H.264 + AAC) entirely in the browser.
 * With the MT core and CFR fix this runs near-realtime for screen content.
 *
 * `durationSec` (the known clip length) is used to compute a real, advancing
 * progress %. MediaRecorder WebM has no duration in its header, so ffmpeg's
 * own `progress` ratio stays pinned at 0 until the very end — the bar looks
 * frozen. We derive % from the processed-output timestamp instead.
 */
export async function convertToMp4(
  source: Blob,
  onProgress?: ConvertProgress,
  durationSec?: number
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(onProgress);

  const handleProgress = ({ progress, time }: { progress: number; time: number }) => {
    if (!onProgress) return;
    // `time` is the processed output position in microseconds. With a known
    // duration this gives a smooth, honest bar; otherwise fall back to
    // ffmpeg's ratio (often 0 for header-less WebM).
    const pct =
      durationSec && durationSec > 0
        ? (time / 1_000_000 / durationSec) * 100
        : progress * 100;
    onProgress(Math.min(99, Math.max(0, pct)), 'converting');
  };
  ffmpeg.on('progress', handleProgress);

  const inputName = 'in.webm';
  const outputName = 'out.mp4';

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(source));
    const ret = await ffmpeg.exec([
      '-i', inputName,
      // MediaRecorder WebM reports a bogus 1000 fps nominal rate; the fps
      // filter ignores it and resamples by real PTS to smooth CFR 30 —
      // VFR passthrough made QuickTime/Safari playback stutter.
      '-vf', 'fps=30',
      // MediaRecorder audio can drift on long recordings; resample keeps sync.
      '-af', 'aresample=async=1',
      // x264 auto-threading exceeds the wasm pthread pool and aborts the core.
      '-threads', loadedMt ? '4' : '1',
      '-c:v', 'libx264',
      // superfast: the wasm speed/size balance. Measured on a 19 s 1440p
      // clip: veryfast 24 s/3.2 MB, superfast 9 s/6.4 MB, ultrafast
      // 4 s/8.8 MB. ultrafast inflated real recordings ~5x (100 MB →
      // 500 MB), so superfast it is: still ~2.5x faster than veryfast.
      '-preset', 'superfast',
      '-crf', '23',
      // 2 s keyframe interval: the smart-cut trim copies whole GOPs and
      // re-encodes only up to the next keyframe, so short GOPs make
      // edits near-instant. x264 default (250 frames ≈ 8 s) is too sparse.
      '-g', '60',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputName,
    ]);
    if (ret !== 0) throw new Error(`ffmpeg exited with code ${ret}`);

    const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    onProgress?.(100, 'converting');
    return new Blob([bytes], { type: 'video/mp4' });
  } catch (err) {
    throw new Error(
      'Konverze ffmpeg selhala: ' +
        (err instanceof Error ? err.message : String(err) || 'unknown')
    );
  } finally {
    ffmpeg.off('progress', handleProgress);
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {}
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {}
  }
}

export interface TrimSegment {
  start: number;
  end: number;
}

/**
 * Runs ffprobe and returns its captured stdout.
 *
 * The return code is IGNORED: core-mt 0.12.10 only wires the exit-code
 * callback into the ffmpeg entry, so ffprobe always reports -1 even on
 * success. Success is judged by whether it produced output; callers parse
 * that output and fail on garbage anyway.
 */
async function ffprobeOut(ffmpeg: FFmpeg, args: string[]): Promise<string> {
  let out = '';
  const onLog = (e: { type: string; message: string }) => {
    if (e.type === 'stdout') out += e.message + '\n';
  };
  ffmpeg.on('log', onLog);
  try {
    await ffmpeg.ffprobe(args);
  } finally {
    ffmpeg.off('log', onLog);
  }
  if (!out.trim()) throw new Error('ffprobe produced no output');
  return out;
}

/** Piece of the output timeline: either stream-copied or re-encoded. */
interface CutPiece {
  start: number;
  dur: number;
  encode: boolean;
}

// Cut boundaries within this distance of a keyframe count as "on" it.
const KF_EPS = 0.08;

/**
 * Smart cut for H.264 MP4 sources at 1x speed: stream-copy everything and
 * re-encode ONLY the slice between each cut point and the next keyframe.
 * A 12-minute video with two cuts copies ~12 minutes of packets (seconds
 * of I/O) and encodes a few seconds of video — instead of re-encoding the
 * whole file (minutes of CPU and a 3-5x bitrate inflation).
 *
 * Pieces are written as MPEG-TS (in-band SPS/PPS, so copied and freshly
 * encoded pieces can differ in encoder params) and joined with the concat
 * demuxer into a faststart MP4.
 */
async function smartCutMp4(
  ffmpeg: FFmpeg,
  inputName: string,
  segments: TrimSegment[],
  onProgress?: ConvertProgress
): Promise<Blob> {
  onProgress?.(2, 'converting');

  // --- Probe: stream layout must be plain H.264 (+ optional AAC) ---------
  const infoRaw = await ffprobeOut(ffmpeg, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name',
    '-of', 'json', inputName,
  ]);
  const info = JSON.parse(infoRaw) as {
    format?: { duration?: string };
    streams?: { codec_type: string; codec_name: string }[];
  };
  const vStream = info.streams?.find((s) => s.codec_type === 'video');
  const hasAudio = !!info.streams?.some((s) => s.codec_type === 'audio');
  if (!vStream || vStream.codec_name !== 'h264') {
    throw new Error(`smart cut: unsupported video codec ${vStream?.codec_name}`);
  }

  // --- Probe: keyframe timestamps (decodes only keyframes, cheap) --------
  const kfRaw = await ffprobeOut(ffmpeg, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time',
    '-of', 'csv=p=0', inputName,
  ]);
  const keyframes = kfRaw
    .split('\n')
    .map((l) => parseFloat(l))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (keyframes.length === 0) throw new Error('smart cut: no keyframes found');
  onProgress?.(8, 'converting');

  // --- Plan pieces -------------------------------------------------------
  const pieces: CutPiece[] = [];
  for (const s of segments) {
    const a = Math.max(0, s.start);
    const b = s.end;
    if (b - a < KF_EPS) continue;
    const k = keyframes.find((kf) => kf >= a - KF_EPS);
    if (k === undefined || (k > a + KF_EPS && k >= b - KF_EPS)) {
      // No usable keyframe inside the segment: re-encode it whole.
      pieces.push({ start: a, dur: b - a, encode: true });
    } else if (k <= a + KF_EPS) {
      // Segment starts on a keyframe: pure copy.
      pieces.push({ start: k, dur: b - k, encode: false });
    } else {
      // Re-encode the head up to the keyframe, copy the rest.
      pieces.push({ start: a, dur: k - a, encode: true });
      pieces.push({ start: k, dur: b - k, encode: false });
    }
  }
  if (pieces.length === 0) throw new Error('Nezbyly žádné úseky k uložení.');

  // --- Extract pieces ----------------------------------------------------
  const names: string[] = [];
  const cleanup: string[] = [];
  try {
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const name = `piece_${i}.ts`;
      const ret = await ffmpeg.exec([
        '-ss', p.start.toFixed(3),
        '-i', inputName,
        '-t', p.dur.toFixed(3),
        '-map', '0:v:0',
        ...(hasAudio ? ['-map', '0:a:0'] : []),
        ...(p.encode
          ? [
              // Boundary slices are a few seconds: spend quality on them.
              '-c:v', 'libx264',
              '-preset', 'veryfast',
              '-crf', '21',
              '-pix_fmt', 'yuv420p',
              '-profile:v', 'high',
              '-threads', loadedMt ? '4' : '1',
              ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
            ]
          : ['-c', 'copy']),
        '-avoid_negative_ts', 'make_zero',
        '-muxdelay', '0',
        '-muxpreload', '0',
        '-f', 'mpegts', name,
      ]);
      if (ret !== 0) throw new Error(`smart cut: piece ${i} failed (${ret})`);
      names.push(name);
      cleanup.push(name);
      onProgress?.(8 + (82 * (i + 1)) / pieces.length, 'converting');
    }

    // --- Concat ----------------------------------------------------------
    await ffmpeg.writeFile(
      'concat.txt',
      new TextEncoder().encode(names.map((n) => `file '${n}'`).join('\n'))
    );
    cleanup.push('concat.txt');
    const ret = await ffmpeg.exec([
      '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
      '-c', 'copy',
      ...(hasAudio ? ['-bsf:a', 'aac_adtstoasc'] : []),
      '-movflags', '+faststart',
      'cut-out.mp4',
    ]);
    if (ret !== 0) throw new Error(`smart cut: concat failed (${ret})`);
    cleanup.push('cut-out.mp4');

    // --- Sanity: output length must match the kept segments --------------
    const expected = pieces.reduce((acc, p) => acc + p.dur, 0);
    const outInfoRaw = await ffprobeOut(ffmpeg, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0', 'cut-out.mp4',
    ]);
    const outDur = parseFloat(outInfoRaw);
    if (!Number.isFinite(outDur) || Math.abs(outDur - expected) > 1.5) {
      throw new Error(
        `smart cut: bad output duration ${outDur} (expected ~${expected.toFixed(1)})`
      );
    }

    const data = (await ffmpeg.readFile('cut-out.mp4')) as Uint8Array;
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    onProgress?.(100, 'converting');
    return new Blob([bytes], { type: 'video/mp4' });
  } finally {
    for (const f of cleanup) {
      try {
        await ffmpeg.deleteFile(f);
      } catch {}
    }
  }
}

/**
 * Cuts a recording to the given kept segments (joined seamlessly) and
 * optionally changes playback speed — output is always MP4.
 *
 * MP4 sources at 1x speed take the smart-cut path (stream copy, seconds,
 * no generation loss); anything else falls back to a full re-encode via
 * the select-filter graph, which also works on cue-less MediaRecorder WebM.
 */
export async function trimToMp4(
  source: Blob,
  segments: TrimSegment[],
  playbackRate: number,
  onProgress?: ConvertProgress
): Promise<Blob> {
  if (segments.length === 0) throw new Error('Nezbyly žádné úseky k uložení.');
  const rate = Math.max(0.5, Math.min(2, playbackRate || 1));

  // Known output length = sum of kept segments, scaled by speed. Drives a
  // real progress bar (header-less WebM leaves ffmpeg's own ratio at 0).
  const outDurSec =
    segments.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0) / rate;

  const ffmpeg = await getFFmpeg(onProgress);

  const inputName = 'trim-in';
  const outputName = 'trim-out.mp4';

  const t0 = performance.now();
  let reason: string | undefined;
  const finish = (path: 'smart-cut' | 're-encode') => {
    lastTrimPath = { path, reason, ms: Math.round(performance.now() - t0) };
    console.info(
      `[trim] path=${path} ms=${lastTrimPath.ms} reason=${reason ?? '-'}`
    );
  };

  // Fast path: no speed change + MP4 container → smart cut. Falls back to
  // the re-encode below on any failure (odd codec, probe error, ...).
  if (rate !== 1) {
    reason = 'rate-not-1';
  } else if (!(await isMp4(source))) {
    reason = 'not-mp4';
  } else {
    try {
      await ffmpeg.writeFile(inputName, await fetchFile(source));
      try {
        const out = await smartCutMp4(ffmpeg, inputName, segments, onProgress);
        finish('smart-cut');
        return out;
      } finally {
        try {
          await ffmpeg.deleteFile(inputName);
        } catch {}
      }
    } catch (err) {
      reason = 'smart-cut-failed: ' + (err instanceof Error ? err.message : String(err));
      console.warn('[trim] smart cut failed, falling back to re-encode:', err);
      onProgress?.(0, 'converting');
    }
  }

  const handleProgress = ({ progress, time }: { progress: number; time: number }) => {
    const pct =
      outDurSec > 0 ? (time / 1_000_000 / outDurSec) * 100 : progress * 100;
    onProgress?.(Math.min(99, Math.max(0, pct)), 'converting');
  };
  ffmpeg.on('progress', handleProgress);

  // Per-segment trim + concat preserves the real frame timestamps inside
  // each kept segment. The old select+setpts=N/FRAME_RATE/TB re-stamped
  // frames at the bogus nominal 1000 fps — the whole video track collapsed
  // to milliseconds while audio kept its length (frozen, stuttering output).
  // Final fps=30 resamples to CFR for reliable playback everywhere.
  const seg = (i: number, s: TrimSegment, kind: 'v' | 'a') =>
    kind === 'v'
      ? `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`
      : `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`;
  const vPost = `${rate === 1 ? '' : `setpts=PTS/${rate},`}fps=30`;

  const graphAV = [
    ...segments.map((s, i) => seg(i, s, 'v')),
    ...segments.map((s, i) => seg(i, s, 'a')),
    `${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[vc][ac]`,
    `[vc]${vPost}[v]`,
    `[ac]${rate === 1 ? 'anull' : `atempo=${rate}`}[a]`,
  ].join(';');

  const graphV = [
    ...segments.map((s, i) => seg(i, s, 'v')),
    `${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[vc]`,
    `[vc]${vPost}[v]`,
  ].join(';');

  const commonOut = [
    '-threads', loadedMt ? '4' : '1',
    '-c:v', 'libx264',
    // ultrafast + crf 26: this path only runs for WebM sources or speed
    // changes (MP4 at 1x goes through smartCutMp4 above). The output is
    // uploaded to Bunny Stream, which re-encodes anyway, so wasm encode
    // speed dominates over file size here (convertToMp4 keeps superfast).
    '-preset', 'ultrafast',
    '-crf', '26',
    '-g', '60',
    '-pix_fmt', 'yuv420p',
  ];

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(source));

    // First try with audio; recordings without an audio track make the
    // audio filter fail — retry video-only.
    let ret = await ffmpeg.exec([
      '-i', inputName,
      '-filter_complex', graphAV,
      '-map', '[v]', '-map', '[a]',
      ...commonOut,
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputName,
    ]);
    if (ret !== 0) {
      console.warn('[trim] audio path failed, retrying video-only');
      ret = await ffmpeg.exec([
        '-i', inputName,
        '-filter_complex', graphV,
        '-map', '[v]', '-an',
        ...commonOut,
        '-movflags', '+faststart',
        outputName,
      ]);
    }
    if (ret !== 0) throw new Error(`ffmpeg exited with code ${ret}`);

    const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    onProgress?.(100, 'converting');
    finish('re-encode');
    return new Blob([bytes], { type: 'video/mp4' });
  } catch (err) {
    throw new Error(
      'Střih selhal: ' +
        (err instanceof Error ? err.message : String(err) || 'unknown')
    );
  } finally {
    ffmpeg.off('progress', handleProgress);
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {}
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {}
  }
}

/** Abort a running conversion. The engine reloads on next use. */
export function cancelConversion(): void {
  instance?.terminate();
  instance = null;
  loading = null;
}
