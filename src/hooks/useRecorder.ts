import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../lib/toast';
import {
  appendBufferChunk,
  deleteBufferSession,
  readBufferChunks,
} from '../lib/storage';

export type RecorderState =
  | 'idle'
  | 'preparing'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'autostopped';

interface StartOptions {
  micDeviceId: string | null;
  cameraDeviceId: string | null;
  /** Burn webcam PiP into final video via canvas compositing. */
  cameraOverlay: boolean;
  /** Linear gain applied to microphone (1 = unity, 0.5 = -6 dB, 2 = +6 dB). */
  micGain: number;
  /** Seconds to count down before MediaRecorder actually starts. */
  countdownSeconds: number;
}

interface StopResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

interface UseRecorderReturn {
  state: RecorderState;
  elapsedMs: number;
  /** Total bytes captured so far in the live recording (buffer size indicator). */
  recordedBytes: number;
  countdownRemaining: number;
  cameraStream: MediaStream | null;
  displayStream: MediaStream | null;
  start: (opts: StartOptions) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<StopResult | null>;
  cancel: () => void;
  /**
   * When recording ended outside our Stop button (e.g. "Stop sharing" in the
   * browser bar), state becomes 'autostopped' and the result waits here.
   * Calling this returns it once and clears it.
   */
  takeAutoResult: () => StopResult | null;
  error: string | null;
}

// Prefer MP4 (H.264 + AAC) when MediaRecorder supports it — Chrome 126+ does.
// MP4 is universally playable (Safari, QuickTime, iMovie, native iOS/macOS).
// Falls back to WebM (VP9/VP8 + Opus) on browsers without MP4 support.
//
// IMPORTANT: candidates must match the actual track layout. Declaring an
// audio codec (mp4a/opus) while the stream has no audio track makes Chrome's
// muxer error out immediately after start — recording "starts then dies".
function mimeCandidates(hasAudio: boolean): string[] {
  return hasAudio
    ? [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=h264,aac',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ]
    : [
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4;codecs=h264',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
}

export function detectRecordingFormat(): 'mp4' | 'webm' | 'unknown' {
  for (const m of mimeCandidates(true)) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return m.includes('mp4') ? 'mp4' : 'webm';
    }
  }
  return 'unknown';
}

/** Try candidates in order; return the first MediaRecorder that constructs. */
function createRecorder(
  stream: MediaStream,
  candidates: string[]
): { recorder: MediaRecorder; mimeType: string } {
  let lastErr: unknown = null;
  for (const mimeType of candidates) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;
    try {
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 5_000_000,
      });
      return { recorder, mimeType };
    } catch (e) {
      lastErr = e;
    }
  }
  // Last resort: let the browser pick
  try {
    return { recorder: new MediaRecorder(stream), mimeType: '' };
  } catch (e) {
    throw lastErr instanceof Error ? lastErr : (e as Error);
  }
}

export function useRecorder(): UseRecorderReturn {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [countdownRemaining, setCountdownRemaining] = useState(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [displayStream, setDisplayStream] = useState<MediaStream | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  // RAM fallback ONLY for chunks whose IndexedDB write failed (quota/private
  // mode). Normally all chunks live in the 'recording-buffer' IDB store so a
  // crashed tab never loses the recording.
  const fallbackChunksRef = useRef<{ seq: number; chunk: Blob }[]>([]);
  const sessionIdRef = useRef<string>('');
  const pendingWritesRef = useRef<Set<Promise<void>>>(new Set());
  const idbWarnedRef = useRef(false);
  const bytesRef = useRef(0);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const canvasStreamRef = useRef<MediaStream | null>(null);
  const compositorRef = useRef<{ stop: () => void } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const startedAtRef = useRef(0);
  const pausedAccumRef = useRef(0);
  const pausedAtRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const countdownResolveRef = useRef<(() => void) | null>(null);
  const resolveStopRef = useRef<((v: StopResult | null) => void) | null>(null);
  const cancelledRef = useRef(false);
  // True from start() entry until the session terminally ends (idle/autostopped).
  const startBusyRef = useRef(false);
  const recorderErrorRef = useRef(false);
  const retriedWebmRef = useRef(false);
  const autoResultRef = useRef<StopResult | null>(null);

  const stopAllStreams = useCallback(() => {
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    canvasStreamRef.current?.getTracks().forEach((t) => t.stop());
    compositorRef.current?.stop();
    audioCtxRef.current?.close().catch(() => {});
    displayStreamRef.current = null;
    micStreamRef.current = null;
    cameraStreamRef.current = null;
    canvasStreamRef.current = null;
    compositorRef.current = null;
    audioCtxRef.current = null;
    setCameraStream(null);
    setDisplayStream(null);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopTimer();
      stopAllStreams();
    };
  }, [stopAllStreams, stopTimer]);

  const start = useCallback(
    async ({
      micDeviceId,
      cameraDeviceId,
      cameraOverlay,
      micGain,
      countdownSeconds,
    }: StartOptions) => {
      // Idempotency guard (synchronous ref): a second start() while one is
      // in flight would overwrite stream/recorder refs and orphan the first
      // recorder, which then keeps writing chunks forever.
      if (startBusyRef.current) {
        console.warn('[recorder] start() ignored — another start is in flight');
        return;
      }
      startBusyRef.current = true;
      setError(null);
      cancelledRef.current = false;
      recorderErrorRef.current = false;
      retriedWebmRef.current = false;
      autoResultRef.current = null;
      setState('preparing');
      try {
        // 1) Screen — native picker
        const displayMS = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 } as MediaTrackConstraints,
          audio: true,
        });
        displayStreamRef.current = displayMS;
        setDisplayStream(displayMS);

        if (cancelledRef.current) {
          stopAllStreams();
          startBusyRef.current = false;
          return;
        }

        // 2) Mic — a missing/stale device must NOT kill the recording.
        // Saved deviceIds can go stale (Chrome rotates them, device unplugged);
        // fall back to the default mic, then to no mic at all.
        if (micDeviceId) {
          try {
            micStreamRef.current = await navigator.mediaDevices.getUserMedia({
              audio: {
                deviceId: { exact: micDeviceId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
          } catch {
            try {
              micStreamRef.current = await navigator.mediaDevices.getUserMedia({
                audio: {
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                },
              });
              toast.warning('Vybraný mikrofon není dostupný, používám výchozí.', {
                title: 'Mikrofon',
              });
            } catch {
              toast.warning('Mikrofon se nepodařilo otevřít, nahrávám bez něj.', {
                title: 'Mikrofon',
              });
            }
          }
        }

        // 3) Camera — same policy: degrade gracefully, never abort.
        if (cameraDeviceId) {
          try {
            const camStream = await navigator.mediaDevices.getUserMedia({
              video: {
                deviceId: { exact: cameraDeviceId },
                width: { ideal: 640 },
                height: { ideal: 480 },
              },
            });
            cameraStreamRef.current = camStream;
            setCameraStream(camStream);
          } catch {
            try {
              const camStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 } },
              });
              cameraStreamRef.current = camStream;
              setCameraStream(camStream);
              toast.warning('Vybraná kamera není dostupná, používám výchozí.', {
                title: 'Kamera',
              });
            } catch {
              toast.warning('Kameru se nepodařilo otevřít, nahrávám bez ní.', {
                title: 'Kamera',
              });
            }
          }
        }

        // 4) Video track for recorder
        let videoTrack: MediaStreamTrack;
        if (cameraOverlay && cameraStreamRef.current) {
          const composite = startCompositor(displayMS, cameraStreamRef.current);
          canvasStreamRef.current = composite.stream;
          compositorRef.current = { stop: composite.stop };
          videoTrack = composite.stream.getVideoTracks()[0];
        } else {
          videoTrack = displayMS.getVideoTracks()[0];
        }

        // 5) Audio. Piping a mic into an AudioContext makes Chrome drop the
        //    capture-side noise suppression / echo cancellation, so the
        //    recording ends up full of room noise. Use the raw, already
        //    processed mic track directly whenever we can — i.e. no system
        //    audio to mix in AND the gain slider is at its default. Only fall
        //    back to Web Audio when we genuinely must mix or change the level.
        const displayAudio = displayMS.getAudioTracks();
        const micTrack = micStreamRef.current?.getAudioTracks()[0] ?? null;
        const needsGain = !!micTrack && Math.abs(micGain - 1) > 0.01;
        const needsMixing = displayAudio.length > 0 && !!micTrack;

        let audioTrack: MediaStreamTrack | null = null;
        if (micTrack && !needsMixing && !needsGain) {
          // Clean path: browser-processed mic, straight into the recording.
          audioTrack = micTrack;
        } else if (displayAudio.length > 0 || micTrack) {
          // Mixing / gain path: Web Audio is unavoidable here (its cost is the
          // mic processing, accepted only when the user opts into gain or when
          // system audio must be blended in).
          const audioCtx = new AudioContext();
          audioCtxRef.current = audioCtx;
          const audioDest = audioCtx.createMediaStreamDestination();
          if (displayAudio.length > 0) {
            audioCtx
              .createMediaStreamSource(new MediaStream([displayAudio[0]]))
              .connect(audioDest);
          }
          if (micTrack) {
            const gain = audioCtx.createGain();
            gain.gain.value = Math.max(0, micGain);
            audioCtx
              .createMediaStreamSource(micStreamRef.current!)
              .connect(gain)
              .connect(audioDest);
          }
          audioTrack = audioDest.stream.getAudioTracks()[0] ?? null;
        }

        const tracks: MediaStreamTrack[] = [videoTrack];
        if (audioTrack) tracks.push(audioTrack);
        const combined = new MediaStream(tracks);

        // 6) Countdown (streams already active, preview shows)
        if (countdownSeconds > 0) {
          setState('countdown');
          setCountdownRemaining(countdownSeconds);
          await new Promise<void>((resolve) => {
            countdownResolveRef.current = resolve;
            let remaining = countdownSeconds;
            countdownTimerRef.current = window.setInterval(() => {
              remaining -= 1;
              setCountdownRemaining(remaining);
              if (remaining <= 0 || cancelledRef.current) {
                if (countdownTimerRef.current !== null) {
                  clearInterval(countdownTimerRef.current);
                  countdownTimerRef.current = null;
                }
                countdownResolveRef.current = null;
                resolve();
              }
            }, 1000);
          });
          if (cancelledRef.current) {
            stopAllStreams();
            setState('idle');
            startBusyRef.current = false;
            return;
          }
        }

        // 7) Arm + start the MediaRecorder, with one automatic WebM retry
        // if the preferred (MP4) muxer errors out right after starting.
        const finishAll = (st: RecorderState) => {
          stopTimer();
          stopAllStreams();
          setState(st);
          startBusyRef.current = false;
        };

        const armAndStart = (candidates: string[]) => {
          const { recorder, mimeType } = createRecorder(combined, candidates);
          const effectiveMime = mimeType || 'video/webm';

          // Fresh crash-safe buffer session for this recorder instance.
          const sessionId =
            Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
          sessionIdRef.current = sessionId;
          fallbackChunksRef.current = [];
          pendingWritesRef.current = new Set();
          idbWarnedRef.current = false;
          bytesRef.current = 0;
          setRecordedBytes(0);
          let seq = 0;

          recorder.ondataavailable = (e) => {
            if (!e.data || e.data.size === 0) return;
            const mySeq = seq++;
            const chunk = e.data;
            bytesRef.current += chunk.size;
            setRecordedBytes(bytesRef.current);
            // Persist to IndexedDB immediately (fire-and-forget). A tab crash
            // then loses at most the last ~1 s. On IDB failure fall back to RAM
            // so the recording itself never dies because of storage.
            const p = appendBufferChunk({
              sessionId,
              seq: mySeq,
              mimeType: effectiveMime,
              chunk,
            }).catch((err) => {
              fallbackChunksRef.current.push({ seq: mySeq, chunk });
              if (!idbWarnedRef.current) {
                idbWarnedRef.current = true;
                console.error(
                  '[recorder] IndexedDB chunk write failed — falling back to RAM buffering:',
                  err
                );
              }
            });
            pendingWritesRef.current.add(p);
            p.finally(() => pendingWritesRef.current.delete(p));
          };

          recorder.onerror = (ev) => {
            console.error('[recorder] error event:', ev);
            recorderErrorRef.current = true;
            // Chrome typically fires onstop right after error; force it if not.
            if (recorder.state !== 'inactive') {
              try {
                recorder.stop();
              } catch {}
            }
          };

          // Reassemble the recording from the IDB buffer (+ any RAM-fallback
          // chunks), ordered by seq. Never throws — worst case returns only
          // the RAM chunks.
          const assembleBlob = async (): Promise<Blob> => {
            // Let in-flight chunk writes settle first.
            await Promise.allSettled([...pendingWritesRef.current]);
            let idbRows: { seq: number; chunk: Blob }[] = [];
            try {
              idbRows = await readBufferChunks(sessionId);
            } catch (err) {
              console.error('[recorder] reading chunk buffer failed:', err);
            }
            const all = [...idbRows, ...fallbackChunksRef.current].sort(
              (a, b) => a.seq - b.seq
            );
            fallbackChunksRef.current = [];
            return new Blob(
              all.map((r) => r.chunk),
              { type: effectiveMime }
            );
          };

          const clearBuffer = () => {
            deleteBufferSession(sessionId).catch((err) =>
              console.warn('[recorder] failed to clear chunk buffer:', err)
            );
          };

          recorder.onstop = () => {
            const durationMs = Math.max(
              0,
              Date.now() -
                startedAtRef.current -
                pausedAccumRef.current -
                (pausedAtRef.current ? Date.now() - pausedAtRef.current : 0)
            );

            void (async () => {
              // b) Cancelled — discard everything, no need to assemble.
              if (cancelledRef.current && !resolveStopRef.current) {
                clearBuffer();
                finishAll('idle');
                return;
              }

              const blob = await assembleBlob();

              // a) User pressed our Stop — resolve their await.
              const resolver = resolveStopRef.current;
              if (resolver) {
                clearBuffer();
                finishAll('idle');
                resolver({ blob, mimeType: effectiveMime, durationMs });
                resolveStopRef.current = null;
                return;
              }

              // c) Recorder errored right after start (typically MP4 muxer
              //    rejecting the track layout) — retry once with WebM on the
              //    SAME streams, no new screen picker needed.
              if (recorderErrorRef.current && !retriedWebmRef.current) {
                recorderErrorRef.current = false;
                retriedWebmRef.current = true;
                clearBuffer();
                const webmOnly = candidates.filter((c) => c.includes('webm'));
                try {
                  console.warn('[recorder] retrying with WebM after MP4 failure');
                  toast.warning(
                    'Nahrávání v MP4 selhalo, pokračuji ve WebM. Po uložení můžeš použít „Konvertovat na MP4".',
                    { title: 'Nahrávání', duration: 6000 }
                  );
                  armAndStart(webmOnly.length ? webmOnly : ['video/webm']);
                  return;
                } catch (e) {
                  console.error('[recorder] WebM retry failed too:', e);
                }
              }

              // d) Unexpected stop ("Stop sharing" in browser bar, or fatal
              //    error) — keep the result so the UI can save it.
              clearBuffer();
              autoResultRef.current = {
                blob,
                mimeType: effectiveMime,
                durationMs,
              };
              finishAll('autostopped');
            })();
          };

          recorderRef.current = recorder;
          recorder.start(1000);
        };

        armAndStart(mimeCandidates(!!audioTrack));

        displayMS.getVideoTracks()[0].onended = () => {
          if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            recorderRef.current.stop();
          }
        };

        startedAtRef.current = Date.now();
        pausedAccumRef.current = 0;
        pausedAtRef.current = null;
        setElapsedMs(0);
        timerRef.current = window.setInterval(() => {
          const paused = pausedAtRef.current ? Date.now() - pausedAtRef.current : 0;
          setElapsedMs(
            Date.now() - startedAtRef.current - pausedAccumRef.current - paused
          );
        }, 100);
        setState('recording');
      } catch (e: any) {
        stopAllStreams();
        setState('idle');
        startBusyRef.current = false;
        const msg =
          e?.name === 'NotAllowedError'
            ? 'Sdílení obrazovky bylo zrušeno.'
            : e?.message || String(e);
        setError(msg);
        throw e;
      }
    },
    [stopAllStreams, stopTimer]
  );

  const pause = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.pause();
      pausedAtRef.current = Date.now();
      setState('paused');
    }
  }, []);

  const resume = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'paused') {
      if (pausedAtRef.current) {
        pausedAccumRef.current += Date.now() - pausedAtRef.current;
        pausedAtRef.current = null;
      }
      recorderRef.current.resume();
      setState('recording');
    }
  }, []);

  const stop = useCallback(() => {
    return new Promise<StopResult | null>((resolve) => {
      const rec = recorderRef.current;
      if (!rec || rec.state === 'inactive') {
        // Recording may have already auto-stopped — hand over that result.
        if (autoResultRef.current) {
          const r = autoResultRef.current;
          autoResultRef.current = null;
          resolve(r);
          return;
        }
        resolve(null);
        return;
      }
      resolveStopRef.current = resolve;
      setState('stopping');
      rec.stop();
    });
  }, []);

  const takeAutoResult = useCallback((): StopResult | null => {
    const r = autoResultRef.current;
    autoResultRef.current = null;
    return r;
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    startBusyRef.current = false;
    // Release any pending countdown await so the start() async chain unwinds.
    if (countdownResolveRef.current) {
      countdownResolveRef.current();
      countdownResolveRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      rec.stop();
    }
    // Discard the crash-safe buffer of the cancelled session (after any
    // in-flight chunk writes settle, so nothing is re-added afterwards).
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      const pending = [...pendingWritesRef.current];
      Promise.allSettled(pending).then(() =>
        deleteBufferSession(sessionId).catch((err) =>
          console.warn('[recorder] failed to clear chunk buffer on cancel:', err)
        )
      );
    }
    fallbackChunksRef.current = [];
    stopTimer();
    stopAllStreams();
    setState('idle');
    resolveStopRef.current = null;
    autoResultRef.current = null;
  }, [stopAllStreams, stopTimer]);

  return {
    state,
    elapsedMs,
    recordedBytes,
    countdownRemaining,
    cameraStream,
    displayStream,
    start,
    pause,
    resume,
    stop,
    cancel,
    takeAutoResult,
    error,
  };
}

// ────── Canvas compositor: screen + circular webcam PiP → captureStream ──────
function startCompositor(displayStream: MediaStream, camStream: MediaStream) {
  const screenVideo = document.createElement('video');
  screenVideo.srcObject = displayStream;
  screenVideo.muted = true;
  screenVideo.playsInline = true;
  screenVideo.play().catch(() => {});

  const camVideo = document.createElement('video');
  camVideo.srcObject = camStream;
  camVideo.muted = true;
  camVideo.playsInline = true;
  camVideo.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d')!;

  let raf = 0;
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    const sw = screenVideo.videoWidth;
    const sh = screenVideo.videoHeight;
    if (sw && sh) {
      if (canvas.width !== sw || canvas.height !== sh) {
        canvas.width = sw;
        canvas.height = sh;
      }
      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const cw = camVideo.videoWidth;
    const ch = camVideo.videoHeight;
    if (cw && ch) {
      const size = Math.min(canvas.width, canvas.height) * 0.18;
      const margin = size * 0.15;
      const cx = canvas.width - size - margin;
      const cy = canvas.height - size - margin;
      const scale = Math.max(size / cw, size / ch);
      const drawW = cw * scale;
      const drawH = ch * scale;
      const dx = cx + (size - drawW) / 2;
      const dy = cy + (size - drawH) / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx + size / 2, cy + size / 2, size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.translate(cx + size / 2, cy + size / 2);
      ctx.scale(-1, 1);
      ctx.translate(-(cx + size / 2), -(cy + size / 2));
      ctx.drawImage(camVideo, dx, dy, drawW, drawH);
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(3, size * 0.02);
      ctx.beginPath();
      ctx.arc(cx + size / 2, cy + size / 2, size / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    raf = requestAnimationFrame(draw);
  };
  draw();

  const stream = canvas.captureStream(30);
  return {
    stream,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
      screenVideo.srcObject = null;
      camVideo.srcObject = null;
    },
  };
}
