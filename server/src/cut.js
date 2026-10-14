// Native cut for the upload path.
//
// Edits are non-destructive in the browser: the app keeps the original and a
// list of kept segments, the preview skips the removed parts, and nothing is
// re-encoded when the user saves. The real cut happens here, during upload,
// where native ffmpeg has no wasm memory ceiling and copies at disk speed.
//
// MP4 / H.264 (everything recorded since the 4K capture cap):
//   precise "smart cut": stream-copy every kept GOP and re-encode only the
//   slice from each cut point to the next keyframe, so cuts land on the exact
//   frame the user picked while a 10 minute video still takes seconds.
// WebM / VP8 / VP9 (older recordings):
//   keyframe-snapped stream copy. A cut may land up to one GOP (~1 s) early,
//   always toward the removed side, so nothing the user kept is clipped.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

const STEP_TIMEOUT_MS = 20 * 60 * 1000;
// Cut boundaries within this distance of a keyframe count as "on" it.
const KF_EPS = 0.08;

function run(bin, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'],
    });
    let out = '';
    let err = '';
    if (capture) proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => {
      err += c;
      if (err.length > 8192) err = err.slice(-8192);
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), STEP_TIMEOUT_MS);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited with ${code}: ${err.slice(-400)}`));
    });
  });
}

/**
 * Parses "a-b,c-d" (seconds) into sorted, merged, sane segments.
 * Returns null when the value is malformed, so the caller can answer 400.
 */
export function parseSegments(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',');
  if (parts.length === 0 || parts.length > 500) return null;
  const segs = [];
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(p.trim());
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.05) continue;
    segs.push({ start, end });
  }
  segs.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.001) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged.length > 0 ? merged : null;
}

async function probe(inPath) {
  const raw = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name',
      '-of', 'json',
      inPath,
    ],
    { capture: true }
  );
  const info = JSON.parse(raw);
  const v = info.streams?.find((s) => s.codec_type === 'video');
  return {
    videoCodec: v?.codec_name ?? null,
    hasAudio: !!info.streams?.some((s) => s.codec_type === 'audio'),
    duration: Number(info.format?.duration) || 0,
  };
}

/** Keyframe times from packet flags — demux only, nothing is decoded. */
async function keyframes(inPath) {
  const raw = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0',
      inPath,
    ],
    { capture: true }
  );
  const out = [];
  for (const line of raw.split('\n')) {
    const [t, flags] = line.split(',');
    if (!flags || !flags.includes('K')) continue;
    const n = parseFloat(t);
    if (Number.isFinite(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function planPrecise(segments, kfs) {
  const pieces = [];
  for (const { start: a, end: b } of segments) {
    const k = kfs.find((kf) => kf >= a - KF_EPS);
    if (k === undefined || (k > a + KF_EPS && k >= b - KF_EPS)) {
      pieces.push({ start: a, dur: b - a, encode: true }); // no keyframe inside
    } else if (k <= a + KF_EPS) {
      pieces.push({ start: k, dur: b - k, encode: false }); // starts on a keyframe
    } else {
      pieces.push({ start: a, dur: k - a, encode: true }); // head up to the keyframe
      pieces.push({ start: k, dur: b - k, encode: false }); // rest copied
    }
  }
  return pieces;
}

function planSnapped(segments, kfs) {
  const pieces = [];
  let prevEnd = 0;
  for (const { start: a, end: b } of segments) {
    // Snap back so nothing the user kept is clipped; snap forward only when
    // stepping back would re-include content the previous segment already has.
    let k = [...kfs].reverse().find((kf) => kf <= a + KF_EPS);
    if (k === undefined || k < prevEnd - KF_EPS) {
      const fwd = kfs.find((kf) => kf >= a - KF_EPS);
      if (fwd !== undefined && fwd < b - KF_EPS) k = fwd;
    }
    if (k === undefined) k = a;
    pieces.push({ start: k, dur: b - k, encode: false });
    prevEnd = b;
  }
  return pieces;
}

/**
 * Cuts `inPath` down to `segments` and writes the result into `workDir`.
 * Returns { outPath, contentType, ms, mode }.
 */
export async function cutToFile(inPath, segments, workDir) {
  const t0 = Date.now();
  const info = await probe(inPath);
  const kfs = await keyframes(inPath);
  if (kfs.length === 0) throw new Error('cut: no keyframes found');

  const isH264 = info.videoCodec === 'h264';
  const isWebm = info.videoCodec === 'vp8' || info.videoCodec === 'vp9';
  if (!isH264 && !isWebm) throw new Error(`cut: unsupported video codec ${info.videoCodec}`);

  const pieces = isH264 ? planPrecise(segments, kfs) : planSnapped(segments, kfs);
  const pieceExt = isH264 ? 'ts' : 'webm';
  const audioMap = info.hasAudio ? ['-map', '0:a:0'] : [];

  const names = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const name = path.join(workDir, `piece_${i}.${pieceExt}`);
    // Seeking: a fast input-side jump to a little before the target, then
    // a precise output-side trim on absolute timestamps (-copyts). Plain
    // input-side -ss with stream copy is NOT precise on browser recordings:
    // MediaRecorder writes fragmented MP4 without an index (and WebM without
    // cues), so the demuxer lands on the fragment boundary before the target
    // and every copied piece started up to ~1 s early — measured +1.1 s per
    // segment. Re-encoded heads are precise either way (decoded frames before
    // the target are discarded), but use the same form for consistency.
    const pre = Math.max(0, p.start - 3);
    const codec = p.encode
      ? [
          // Boundary slices are short: spend quality on them.
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-pix_fmt', 'yuv420p', '-g', '30',
          ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
        ]
      : ['-c', 'copy'];
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-ss', pre.toFixed(3),
      '-i', inPath,
      '-copyts',
      '-ss', p.start.toFixed(3),
      '-t', p.dur.toFixed(3),
      '-map', '0:v:0', ...audioMap,
      ...codec,
      '-avoid_negative_ts', 'make_zero',
      ...(isH264 ? ['-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts'] : ['-f', 'webm']),
      name,
    ]);
    names.push(name);
  }

  // The source is no longer needed: free its disk space before the concat
  // writes the output, so peak usage stays near 2x instead of 3x.
  await fsp.rm(inPath, { force: true }).catch(() => {});

  const listPath = path.join(workDir, 'concat.txt');
  await fsp.writeFile(
    listPath,
    names.map((n) => `file '${n.replace(/'/g, "'\\''")}'`).join('\n')
  );
  const outPath = path.join(workDir, isH264 ? 'cut.mp4' : 'cut.webm');
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    ...(isH264 && info.hasAudio ? ['-bsf:a', 'aac_adtstoasc'] : []),
    ...(isH264 ? ['-movflags', '+faststart'] : []),
    outPath,
  ]);
  for (const n of names) await fsp.rm(n, { force: true }).catch(() => {});

  // Sanity: the output must be as long as the pieces we planned.
  const expected = pieces.reduce((acc, p) => acc + p.dur, 0);
  const got = (await probe(outPath)).duration;
  if (!Number.isFinite(got) || Math.abs(got - expected) > 1.5) {
    throw new Error(`cut: bad output duration ${got} (expected ~${expected.toFixed(1)})`);
  }

  return {
    outPath,
    contentType: isH264 ? 'video/mp4' : 'video/webm',
    ms: Date.now() - t0,
    mode: isH264 ? 'precise' : 'snapped',
  };
}
