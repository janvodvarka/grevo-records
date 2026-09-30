import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  X,
  Loader2,
  Scissors,
  Trash,
  Play,
  Pause,
  Keyboard,
  Gauge,
  Sparkles,
  Save,
} from 'lucide-react';
import type { StoredRecording } from '../types';
import { formatBytes, formatDuration } from '../lib/format';
import { saveRecording } from '../lib/storage';
import { computeKeptSegments, type Segment } from '../lib/compose';
import { cancelConversion, trimToMp4 } from '../lib/ffmpeg';
import { SERVER_CONVERT_THRESHOLD_BYTES } from '../lib/upload';
import { replaceRecordingBlob } from '../lib/storage';
import { confirmDialog } from '../lib/confirm';
import { useThumbnails } from '../hooks/useThumbnails';
import { useWaveform } from '../hooks/useWaveform';
import { detectSilentRanges } from '../lib/silence';
import { toast } from '../lib/toast';

interface Props {
  recording: StoredRecording;
  videoEl: HTMLVideoElement;
  duration: number;
  onDone: (rec: StoredRecording) => void;
  onCancel: () => void;
  /** When true, the editor is rendered as a persistent panel (no Cancel button). */
  persistent?: boolean;
}

type DragHandle =
  | { kind: 'trimStart' }
  | { kind: 'trimEnd' }
  | { kind: 'playhead' }
  | { kind: 'delStart'; id: string }
  | { kind: 'delEnd'; id: string }
  | { kind: 'delMove'; id: string; offset: number }
  | null;

interface DeleteRegion {
  id: string;
  start: number;
  end: number;
}

function genId(): string {
  return Math.random().toString(36).slice(2, 9);
}

const SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 2];

export function TrimEditor({
  recording,
  videoEl,
  duration,
  onDone,
  onCancel,
  persistent = false,
}: Props) {
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(duration);
  const [deletes, setDeletes] = useState<DeleteRegion[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [shortcutHelp, setShortcutHelp] = useState(false);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragHandle>(null);
  const justDraggedRef = useRef(false);

  // Alt-drag on track creates a new delete region as user drags.
  const altDragRef = useRef<{ id: string; startSec: number } | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);

  // Mirror high-frequency state (playhead) into a ref so the keyboard listener
  // doesn't have to be re-attached every timeupdate.
  const playheadRef = useRef(0);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const { thumbnails } = useThumbnails(recording.blob, 16, 56);
  const { peaks } = useWaveform(recording.blob, 240);

  const kept = useMemo(
    () => computeKeptSegments(duration, trimStart, trimEnd, deletes),
    [duration, trimStart, trimEnd, deletes]
  );
  const keptDuration = useMemo(
    () => kept.reduce((acc, s) => acc + (s.end - s.start), 0),
    [kept]
  );

  // Track playhead & playing state
  useEffect(() => {
    const onTime = () => setPlayhead(videoEl.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    videoEl.addEventListener('timeupdate', onTime);
    videoEl.addEventListener('play', onPlay);
    videoEl.addEventListener('pause', onPause);
    return () => {
      videoEl.removeEventListener('timeupdate', onTime);
      videoEl.removeEventListener('play', onPlay);
      videoEl.removeEventListener('pause', onPause);
    };
  }, [videoEl]);

  // Apply playback rate
  useEffect(() => {
    videoEl.playbackRate = playbackRate;
  }, [videoEl, playbackRate]);

  // During edit playback, skip delete regions and loop within trim range
  useEffect(() => {
    const onTime = () => {
      const t = videoEl.currentTime;
      if (t < trimStart - 0.05) {
        videoEl.currentTime = trimStart;
        return;
      }
      if (t > trimEnd) {
        videoEl.currentTime = trimStart;
        return;
      }
      for (const d of deletes) {
        if (t >= d.start - 0.02 && t < d.end) {
          videoEl.currentTime = Math.min(d.end + 0.01, trimEnd);
          return;
        }
      }
    };
    videoEl.addEventListener('timeupdate', onTime);
    return () => videoEl.removeEventListener('timeupdate', onTime);
  }, [videoEl, trimStart, trimEnd, deletes]);

  const pctFromX = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const onTrackDown = (e: React.MouseEvent, h: DragHandle) => {
    e.stopPropagation();
    dragRef.current = h;
    justDraggedRef.current = false;
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const handle = dragRef.current;
      if (!handle || !trackRef.current) return;
      justDraggedRef.current = true;
      const t = pctFromX(e.clientX) * duration;

      if (handle.kind === 'trimStart') {
        const next = Math.max(0, Math.min(trimEnd - 0.2, t));
        setTrimStart(next);
        videoEl.currentTime = next;
      } else if (handle.kind === 'trimEnd') {
        const next = Math.max(trimStart + 0.2, Math.min(duration, t));
        setTrimEnd(next);
        videoEl.currentTime = Math.max(trimStart, next - 0.1);
      } else if (handle.kind === 'playhead') {
        let next = Math.max(trimStart, Math.min(trimEnd, t));
        for (const d of deletes) {
          if (next >= d.start && next < d.end) {
            next = d.end;
            break;
          }
        }
        videoEl.currentTime = next;
      } else if (handle.kind === 'delStart') {
        setDeletes((prev) =>
          prev.map((d) => {
            if (d.id !== handle.id) return d;
            return { ...d, start: Math.max(trimStart, Math.min(d.end - 0.1, t)) };
          })
        );
      } else if (handle.kind === 'delEnd') {
        setDeletes((prev) =>
          prev.map((d) => {
            if (d.id !== handle.id) return d;
            return { ...d, end: Math.max(d.start + 0.1, Math.min(trimEnd, t)) };
          })
        );
      } else if (handle.kind === 'delMove') {
        setDeletes((prev) =>
          prev.map((d) => {
            if (d.id !== handle.id) return d;
            const width = d.end - d.start;
            let newStart = t - handle.offset;
            newStart = Math.max(trimStart, Math.min(trimEnd - width, newStart));
            return { ...d, start: newStart, end: newStart + width };
          })
        );
      }
    };
    const onUp = () => {
      dragRef.current = null;
      // Keep justDraggedRef true briefly so click events ignore the drag-end
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [duration, trimStart, trimEnd, deletes, videoEl]);

  const addCutAtPlayhead = (anchorTime?: number) => {
    const anchor = anchorTime ?? playheadRef.current;
    const span = Math.min(2, Math.max(0.4, (trimEnd - trimStart) / 10));
    let start = Math.max(trimStart, anchor - span / 2);
    let end = Math.min(trimEnd, anchor + span / 2);
    if (end - start < 0.2) {
      start = Math.max(trimStart, anchor - 0.5);
      end = Math.min(trimEnd, start + 1);
      start = Math.max(trimStart, end - 1);
    }
    setDeletes((prev) => [...prev, { id: genId(), start, end }]);
  };

  const removeDelete = (id: string) => {
    setDeletes((prev) => prev.filter((d) => d.id !== id));
  };

  const detectAndAddSilentCuts = () => {
    if (peaks.length === 0 || duration <= 0) {
      toast.info('Audio se ještě nenačetl. Zkus to za vteřinu.');
      return;
    }
    const ranges = detectSilentRanges(peaks, duration, {
      threshold: 0.07,
      minDurationSec: 0.6,
      padStart: 0.15,
      padEnd: 0.15,
    });
    if (ranges.length === 0) {
      toast.info('V nahrávce nejsou žádné delší pauzy k odstranění.');
      return;
    }
    const newDeletes: DeleteRegion[] = ranges
      .map((r) => ({
        id: genId(),
        start: Math.max(trimStart, r.start),
        end: Math.min(trimEnd, r.end),
      }))
      .filter((d) => d.end - d.start > 0.2);
    setDeletes((prev) => [...prev, ...newDeletes]);
    const total = newDeletes.reduce((acc, d) => acc + (d.end - d.start), 0);
    toast.success(
      `Navrženo ${newDeletes.length} výřezů, uspoříš ${total.toFixed(1)}s.`
    );
  };

  const removeLastDeleteOrCutOnPlayhead = () => {
    // If playhead is inside a delete region, remove it; otherwise remove last.
    const ph = playheadRef.current;
    const inside = deletes.find((d) => ph >= d.start && ph <= d.end);
    if (inside) {
      removeDelete(inside.id);
    } else if (deletes.length > 0) {
      removeDelete(deletes[deletes.length - 1].id);
    }
  };

  const togglePlay = () => {
    if (videoEl.paused) videoEl.play().catch(() => {});
    else videoEl.pause();
  };

  const stepFrame = (direction: 1 | -1) => {
    // ~30 fps assumed; ~33ms per frame
    videoEl.pause();
    const next = Math.max(
      trimStart,
      Math.min(trimEnd, videoEl.currentTime + direction * (1 / 30))
    );
    videoEl.currentTime = next;
  };

  const seekBy = (deltaSec: number) => {
    const next = Math.max(trimStart, Math.min(trimEnd, videoEl.currentTime + deltaSec));
    videoEl.currentTime = next;
  };

  // Track shift key state so user knows drag-to-cut is active
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(false);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', () => setShiftHeld(false));
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  // ────── Keyboard shortcuts ──────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Skip when typing in inputs/textareas
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (exporting) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'KeyJ':
          e.preventDefault();
          seekBy(-5);
          break;
        case 'KeyL':
          e.preventDefault();
          seekBy(5);
          break;
        case 'KeyK':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) seekBy(-1);
          else stepFrame(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) seekBy(1);
          else stepFrame(1);
          break;
        case 'KeyI':
          e.preventDefault();
          // Mark IN — set trim start at playhead
          if (videoEl.currentTime < trimEnd - 0.2) setTrimStart(videoEl.currentTime);
          break;
        case 'KeyO':
          e.preventDefault();
          // Mark OUT — set trim end at playhead
          if (videoEl.currentTime > trimStart + 0.2) setTrimEnd(videoEl.currentTime);
          break;
        case 'KeyC':
          e.preventDefault();
          addCutAtPlayhead();
          break;
        case 'Backspace':
        case 'Delete':
          e.preventDefault();
          removeLastDeleteOrCutOnPlayhead();
          break;
        case 'Slash':
          if (e.shiftKey) {
            // "?" — toggle shortcut help
            e.preventDefault();
            setShortcutHelp((s) => !s);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exporting, trimStart, trimEnd, deletes, videoEl]);

  const handleTrackClick = (e: React.MouseEvent) => {
    if (justDraggedRef.current) return; // ignore click that completed a drag
    if (dragRef.current) return;
    const t = pctFromX(e.clientX) * duration;
    if (t >= trimStart && t <= trimEnd) {
      // Snap out of delete region
      let target = t;
      for (const d of deletes) {
        if (target >= d.start && target < d.end) {
          target = d.end;
          break;
        }
      }
      videoEl.currentTime = target;
    }
  };

  // Export přes ffmpeg (select filter) — funguje i na WebM bez seek cues,
  // kde starý canvas-replay export visel navěky. Výstup je vždy MP4.
  const exportTrimmed = async (): Promise<{ blob: Blob; durationMs: number } | null> => {
    if (kept.length === 0) {
      toast.error('Nezbyl žádný úsek k uložení.');
      return null;
    }
    // Both convert entry points refuse ffmpeg.wasm above this size; the trim
    // export never did, so a 400 MB source went straight into the wasm heap
    // (the file, a second copy inside MEMFS, plus the encoder's own
    // allocations against a ~2 GB cap) and the core aborted — leaving the
    // promise unsettled and the progress bar stuck forever. Warn instead of
    // blocking: on an MP4 source the smart cut copies packets and can still
    // make it, so the call is the user's.
    if (recording.blob.size >= SERVER_CONVERT_THRESHOLD_BYTES) {
      const ok = await confirmDialog({
        title: 'Velké video — střih může selhat',
        message:
          `Zdroj má ${formatBytes(recording.blob.size)}. Střih běží v prohlížeči přes ` +
          'ffmpeg.wasm, který má limit paměti ~2 GB — u takhle velkého souboru může ' +
          'export trvat velmi dlouho nebo spadnout. Zavřený tab export ukončí. ' +
          'Chceš to přesto zkusit?',
        confirmLabel: 'Zkusit export',
      });
      if (!ok) return null;
    }
    setExporting(true);
    setProgressPct(0);
    try {
      videoEl.pause();
      const blob = await trimToMp4(
        recording.blob,
        kept as Segment[],
        playbackRate,
        (pct) => setProgressPct(pct)
      );
      return { blob, durationMs: (keptDuration / playbackRate) * 1000 };
    } catch (e) {
      toast.error((e as Error).message, { title: 'Střih' });
      setExporting(false);
      return null;
    }
  };

  const handleSaveAsNew = async () => {
    const result = await exportTrimmed();
    if (!result) return;
    try {
      const base = recording.name.replace(/\.[^.]+$/, '');
      const rec = await saveRecording({
        blob: result.blob,
        name: `${base}-trimmed.mp4`,
        durationMs: result.durationMs,
        mimeType: 'video/mp4',
      });
      toast.success('Střih uložen jako nová nahrávka (MP4).');
      onDone(rec);
    } catch (e) {
      toast.error('Uložení selhalo: ' + (e as Error).message, { title: 'Chyba' });
    } finally {
      setExporting(false);
    }
  };

  const handleOverwrite = async () => {
    const ok = await confirmDialog({
      title: 'Přepsat původní nahrávku?',
      message:
        'Původní verze bude nahrazena střihem a nepůjde vrátit. Pokud byla na Bunny, starý link přestane odpovídat obsahu. Nahraj ji znovu.',
      confirmLabel: 'Přepsat',
      danger: true,
    });
    if (!ok) return;
    const result = await exportTrimmed();
    if (!result) return;
    try {
      const updated = await replaceRecordingBlob(recording.id, {
        blob: result.blob,
        mimeType: 'video/mp4',
        durationMs: result.durationMs,
      });
      if (!updated) throw new Error('Nahrávka nenalezena.');
      toast.success('Změny uloženy do původní nahrávky (MP4).');
      onDone(updated);
    } catch (e) {
      toast.error('Uložení selhalo: ' + (e as Error).message, { title: 'Chyba' });
    } finally {
      setExporting(false);
    }
  };

  // Helpers for rendering
  const trimStartPct = (trimStart / duration) * 100;
  const trimEndPct = (trimEnd / duration) * 100;
  const phPct = (playhead / duration) * 100;
  const totalRemoved = duration - keptDuration;
  const hasChanges =
    trimStart > 0.01 ||
    trimEnd < duration - 0.01 ||
    deletes.length > 0 ||
    playbackRate !== 1;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="btn-secondary p-2"
            title={isPlaying ? 'Pauza (Space)' : 'Play (Space)'}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4 fill-current" />
            )}
          </button>
          <div className="font-mono text-sm tabular-nums">
            {formatDuration(playhead)} / {formatDuration(duration)}
          </div>

          <div className="ml-2 inline-flex items-center gap-1 bg-bg-elev rounded-lg p-0.5">
            <Gauge className="w-3.5 h-3.5 text-text-muted ml-1.5" />
            {SPEED_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setPlaybackRate(s)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors tabular-nums ${
                  playbackRate === s
                    ? 'bg-bg-card text-text-primary'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShortcutHelp((s) => !s)}
            className="btn-ghost p-2"
            title="Klávesové zkratky (?)"
          >
            <Keyboard className="w-4 h-4" />
          </button>
          <div className="text-sm text-text-secondary tabular-nums">
            Finální:{' '}
            <span className="text-text-primary font-medium">
              {formatDuration(keptDuration)}
            </span>{' '}
            <span className="text-text-muted">
              (−{formatDuration(totalRemoved)})
            </span>
          </div>
        </div>
      </div>

      {shortcutHelp && (
        <div className="bg-bg-elev rounded-xl p-4 mb-4 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-xs animate-fade-in">
          <Shortcut keys="Space / K" desc="Play / Pauza" />
          <Shortcut keys="J / L" desc="−5s / +5s" />
          <Shortcut keys="← / →" desc="Frame -1 / +1" />
          <Shortcut keys="Shift + ← / →" desc="−1s / +1s" />
          <Shortcut keys="I" desc="Mark in (ořez začátek)" />
          <Shortcut keys="O" desc="Mark out (ořez konec)" />
          <Shortcut keys="C" desc="Vyříznout úsek tady" />
          <Shortcut keys="Shift + drag" desc="Nakreslit výřez na timeline" />
          <Shortcut keys="⌫ / Delete" desc="Odebrat výřez" />
        </div>
      )}

      <div
        ref={trackRef}
        className={`relative h-28 bg-bg-elev rounded-xl select-none overflow-hidden ${
          shiftHeld ? 'cursor-crosshair' : 'cursor-pointer'
        }`}
        onMouseDown={(e) => {
          const t = pctFromX(e.clientX) * duration;
          if (t < trimStart || t > trimEnd) return;

          // Shift-drag: start a new delete region that grows as user drags
          if (e.shiftKey) {
            e.stopPropagation();
            const id = genId();
            altDragRef.current = { id, startSec: t };
            setDeletes((prev) => [
              ...prev,
              { id, start: t, end: Math.min(trimEnd, t + 0.05) },
            ]);
            dragRef.current = { kind: 'delEnd', id };
            return;
          }

          handleTrackClick(e);
          dragRef.current = { kind: 'playhead' };
        }}
      >
        {/* Thumbnail strip */}
        {thumbnails.length > 0 && (
          <div className="absolute inset-0 flex">
            {thumbnails.map((src, i) => (
              <div
                key={i}
                className="flex-1 h-full bg-cover bg-center opacity-60"
                style={{ backgroundImage: `url(${src})` }}
              />
            ))}
          </div>
        )}

        {/* Audio waveform — overlay over thumbnails */}
        {peaks.length > 0 && (
          <svg
            className="absolute inset-x-0 bottom-0 w-full h-12 pointer-events-none"
            preserveAspectRatio="none"
            viewBox={`0 0 ${peaks.length} 100`}
          >
            <g fill="rgba(232,163,61,0.7)">
              {peaks.map((p, i) => {
                const h = Math.max(2, p * 100);
                return (
                  <rect
                    key={i}
                    x={i}
                    y={(100 - h) / 2 + 50 - h / 2}
                    width={0.8}
                    height={h}
                  />
                );
              })}
            </g>
          </svg>
        )}

        {/* Outside-trim overlay */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-black/65 backdrop-blur-[2px]"
          style={{ width: `${trimStartPct}%` }}
        />
        <div
          className="absolute top-0 bottom-0 right-0 bg-black/65 backdrop-blur-[2px]"
          style={{ width: `${100 - trimEndPct}%` }}
        />

        {/* Kept-range outline */}
        <div
          className="absolute top-0 bottom-0 border-y-2 border-accent/80 pointer-events-none"
          style={{ left: `${trimStartPct}%`, width: `${trimEndPct - trimStartPct}%` }}
        />

        {/* Delete regions */}
        {deletes.map((d) => {
          const left = (d.start / duration) * 100;
          const width = ((d.end - d.start) / duration) * 100;
          return (
            <div
              key={d.id}
              className="absolute top-0 bottom-0 bg-danger/35 border-y-2 border-danger group"
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <div
                onMouseDown={(e) => {
                  const t = pctFromX(e.clientX) * duration;
                  onTrackDown(e, { kind: 'delMove', id: d.id, offset: t - d.start });
                }}
                className="absolute inset-0 cursor-grab active:cursor-grabbing"
              />
              <div
                onMouseDown={(e) => onTrackDown(e, { kind: 'delStart', id: d.id })}
                className="absolute top-0 bottom-0 left-0 w-2 -ml-1 bg-danger rounded-md cursor-ew-resize"
              />
              <div
                onMouseDown={(e) => onTrackDown(e, { kind: 'delEnd', id: d.id })}
                className="absolute top-0 bottom-0 right-0 w-2 -mr-1 bg-danger rounded-md cursor-ew-resize"
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeDelete(d.id);
                }}
                className="absolute -top-2 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-danger text-white flex items-center justify-center shadow opacity-0 group-hover:opacity-100 transition-opacity"
                title="Odstranit výřez"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}

        {/* Trim start handle */}
        <div
          onMouseDown={(e) => onTrackDown(e, { kind: 'trimStart' })}
          className="absolute top-0 bottom-0 w-4 -ml-2 bg-accent rounded-md cursor-ew-resize hover:bg-accent-hover flex items-center justify-center z-10 shadow-glow"
          style={{ left: `${trimStartPct}%` }}
          title="Drag pro ořez začátku"
        >
          <div className="w-0.5 h-12 bg-white/90 rounded" />
        </div>
        {/* Trim end handle */}
        <div
          onMouseDown={(e) => onTrackDown(e, { kind: 'trimEnd' })}
          className="absolute top-0 bottom-0 w-4 -ml-2 bg-accent rounded-md cursor-ew-resize hover:bg-accent-hover flex items-center justify-center z-10 shadow-glow"
          style={{ left: `${trimEndPct}%` }}
          title="Drag pro ořez konce"
        >
          <div className="w-0.5 h-12 bg-white/90 rounded" />
        </div>

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none z-20 shadow-[0_0_8px_rgba(255,255,255,0.6)]"
          style={{ left: `${phPct}%` }}
        >
          <div className="absolute -top-1 -left-[5px] w-3 h-3 bg-white rotate-45" />
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-text-muted tabular-nums">
        <span>0:00</span>
        <span className="font-mono text-text-secondary">
          {formatDuration(playhead)} ({Math.round(phPct)}%)
        </span>
        <span>{formatDuration(duration)}</span>
      </div>

      <div className="flex items-center justify-between gap-2 mt-5 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => addCutAtPlayhead()}
            disabled={exporting}
            className="btn-secondary"
            title="Vyříznout úsek na pozici (klávesa C)"
          >
            <Scissors className="w-4 h-4" /> Vyříznout úsek
            {deletes.length > 0 && (
              <span className="ml-1 text-text-muted">({deletes.length})</span>
            )}
          </button>
          <button
            onClick={detectAndAddSilentCuts}
            disabled={exporting || peaks.length === 0}
            className="btn-secondary"
            title="Najít delší pauzy a navrhnout je k odstranění"
          >
            <Sparkles className="w-4 h-4 text-accent" /> Najít ticho
          </button>
          {deletes.length > 0 && (
            <button
              onClick={() => setDeletes([])}
              disabled={exporting}
              className="btn-ghost text-xs"
            >
              <Trash className="w-3.5 h-3.5" /> Reset
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {exporting && (
            <div className="flex items-center gap-2 text-sm text-text-secondary mr-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Exportuji… {Math.round(progressPct)}%</span>
              {/* A wedged ffmpeg.wasm core used to leave no way out but a tab
                  reload — which also loses the recording if it is not saved
                  yet. cancelConversion() terminates the worker and rejects
                  the pending export. */}
              <button
                onClick={() => {
                  cancelConversion();
                  toast.info('Export přerušen.');
                }}
                className="btn-ghost text-xs"
                title="Ukončit běžící export (nahrávka zůstane nezměněná)"
              >
                <X className="w-3.5 h-3.5" /> Přerušit
              </button>
            </div>
          )}
          {!persistent && (
            <button onClick={onCancel} disabled={exporting} className="btn-secondary">
              <X className="w-4 h-4" /> Zrušit
            </button>
          )}
          <button
            onClick={handleOverwrite}
            disabled={exporting || !hasChanges || keptDuration < 0.2}
            className="btn-secondary"
            title={
              !hasChanges
                ? 'Není co stříhat. Pohni úchyty nebo přidej výřez'
                : 'Přepsat původní nahrávku střihem (nevratné)'
            }
          >
            <Save className="w-4 h-4" /> Uložit změny
          </button>
          <button
            onClick={handleSaveAsNew}
            disabled={exporting || !hasChanges || keptDuration < 0.2}
            className="btn-primary"
            title={
              !hasChanges
                ? 'Není co stříhat. Pohni úchyty nebo přidej výřez'
                : 'Uložit jako novou nahrávku, originál zůstane'
            }
          >
            <Check className="w-4 h-4" /> Uložit jako novou
          </button>
        </div>
      </div>
    </div>
  );
}

function Shortcut({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center gap-2">
      <kbd className="px-1.5 py-0.5 bg-bg-card border border-bg-border rounded text-[10px] font-mono text-text-primary min-w-[44px] text-center">
        {keys}
      </kbd>
      <span className="text-text-secondary">{desc}</span>
    </div>
  );
}
