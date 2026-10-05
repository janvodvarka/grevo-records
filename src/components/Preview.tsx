import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Plus,
  Download,
  Trash2,
  Check,
  X,
  Scissors,
} from 'lucide-react';
import type { StoredRecording } from '../types';
import { formatBytes, formatDate, formatDuration } from '../lib/format';
import { TrimEditor } from './TrimEditor';
import { deleteRecording, renameRecording } from '../lib/storage';
import { downloadBlob } from '../lib/download';
import { UploadButton } from './UploadButton';
import { ConvertMp4Button } from './ConvertMp4Button';
import { confirmDialog } from '../lib/confirm';
import { toast } from '../lib/toast';

interface Props {
  recording: StoredRecording;
  onBack: () => void;
  onNew: () => void;
  onUpdated: (rec: StoredRecording) => void;
  onDeleted: () => void;
}

export function Preview({ recording, onBack, onNew, onUpdated, onDeleted }: Props) {
  const [url, setUrl] = useState<string>('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(recording.name);
  const [duration, setDuration] = useState(recording.durationMs / 1000 || 0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const u = URL.createObjectURL(recording.blob);
    setUrl(u);
    setDuration(recording.durationMs / 1000 || 0);
    setPlaybackError(null);
    setVideoReady(false);
    return () => URL.revokeObjectURL(u);
    // Keyed on the blob only: a pure rename must not reload video/editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.blob]);

  // Keep the name field in sync without touching the video.
  useEffect(() => {
    setName(recording.name);
  }, [recording.name]);

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === recording.name) {
      setRenaming(false);
      setName(recording.name);
      return;
    }
    // Preserve original extension if user dropped it
    const origExt = recording.name.match(/\.[^.]+$/)?.[0] || '';
    const finalName =
      origExt && !trimmed.toLowerCase().endsWith(origExt.toLowerCase())
        ? trimmed + origExt
        : trimmed;
    try {
      await renameRecording(recording.id, finalName);
      onUpdated({ ...recording, name: finalName });
      setRenaming(false);
      toast.success(`Přejmenováno na ${finalName}`);
    } catch (e) {
      toast.error('Přejmenování selhalo: ' + (e as Error).message);
    }
  };

  // Auto-commit rename when user clicks away (e.g. Upload button).
  // The cancel button uses onMouseDown to fire BEFORE blur and cancel cleanly.
  const handleRenameBlur = () => {
    // Small delay so explicit Cancel/Check click is registered first
    setTimeout(() => {
      if (renaming) handleRename();
    }, 100);
  };

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: 'Smazat nahrávku?',
      message: `${recording.name} bude trvale odstraněna z lokální knihovny. Pokud je na Bunny, soubor v cloudu zůstane.`,
      confirmLabel: 'Smazat',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteRecording(recording.id);
      onDeleted();
    } catch (e) {
      toast.error('Smazání selhalo: ' + (e as Error).message);
    }
  };

  const handleDownload = () => {
    downloadBlob(recording.blob, recording.name);
  };

  return (
    <div className="min-h-full p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto animate-fade-in">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-5 pt-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button onClick={onBack} className="btn-ghost p-2">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={handleRenameBlur}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleRename();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setName(recording.name);
                      setRenaming(false);
                    }
                  }}
                  className="input flex-1 text-lg"
                />
                <button
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus, avoid blur race
                    handleRename();
                  }}
                  className="btn-ghost p-2 text-success"
                  title="Uložit jméno (Enter)"
                >
                  <Check className="w-5 h-5" />
                </button>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setName(recording.name);
                    setRenaming(false);
                  }}
                  className="btn-ghost p-2"
                  title="Zrušit (Esc)"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <h1
                onClick={() => setRenaming(true)}
                className="text-xl font-semibold tracking-tight truncate cursor-text hover:text-accent transition-colors"
                title="Klikni pro přejmenování"
              >
                {recording.name}
              </h1>
            )}
            <div className="text-xs text-text-muted mt-1">
              {formatDate(recording.createdAt)} · {formatBytes(recording.size)}
              {duration > 0 && ` · ${formatDuration(duration)}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap sm:justify-end w-full sm:w-auto">
          <ConvertMp4Button recording={recording} onConverted={onUpdated} />
          <UploadButton recording={recording} variant="secondary" onUploaded={onUpdated} />
          <button onClick={handleDownload} className="btn-secondary">
            <Download className="w-4 h-4" /> Stáhnout
          </button>
          <button onClick={onNew} className="btn-ghost">
            <Plus className="w-4 h-4" /> Nové
          </button>
          <button onClick={handleDelete} className="btn-ghost text-danger">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Trim editor — always visible on top of the player */}
      {videoReady && duration > 0 && videoRef.current && (
        <div className="mb-4 animate-fade-in">
          <div className="flex items-center gap-2 mb-2 text-text-secondary text-sm">
            <Scissors className="w-4 h-4 text-accent" />
            <span className="font-medium text-text-primary">Střih</span>
            <span className="text-text-muted">
              · drag krajní úchyty pro ořez začátku/konce, „Vyříznout úsek" pro řez uprostřed
            </span>
          </div>
          <TrimEditor
            recording={recording}
            videoEl={videoRef.current}
            duration={duration}
            onDone={(rec) => onUpdated(rec)}
            onCancel={() => {
              /* no-op: trim editor is persistent */
            }}
            persistent
          />
        </div>
      )}

      <div className="card overflow-hidden bg-black relative">
        {url && (
          <video
            ref={videoRef}
            src={url}
            controls
            className="w-full aspect-video bg-black"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (isFinite(d) && d > 0) setDuration(d);
              setPlaybackError(null);
              setVideoReady(true);
            }}
            onError={(e) => {
              // Surface the actual MediaError — without it "cannot play" gives
              // no clue whether the file is corrupt (DECODE) or the codec is
              // unsupported (SRC_NOT_SUPPORTED).
              const err = e.currentTarget.error;
              const kind =
                err?.code === MediaError.MEDIA_ERR_DECODE
                  ? 'poškozená data videa'
                  : err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                  ? 'nepodporovaný formát'
                  : err?.code === MediaError.MEDIA_ERR_NETWORK
                  ? 'chyba načítání'
                  : 'neznámá chyba';
              console.error('[preview] playback failed', {
                code: err?.code,
                message: err?.message,
                mimeType: recording.mimeType,
                size: recording.size,
              });
              setPlaybackError(
                `Nahrávku se nepodařilo přehrát: ${kind}. ` +
                  `Zkus ji stáhnout a otevřít externě.`
              );
            }}
          />
        )}
        {playbackError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/85 backdrop-blur-sm p-6">
            <div className="text-center max-w-md">
              <div className="text-danger font-medium mb-2">Chyba přehrávání</div>
              <p className="text-sm text-text-secondary mb-4">{playbackError}</p>
              <button onClick={handleDownload} className="btn-primary">
                <Download className="w-4 h-4" /> Stáhnout soubor
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
