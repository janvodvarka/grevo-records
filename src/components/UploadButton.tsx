import { useEffect, useState } from 'react';
import {
  Cloud,
  UploadCloud,
  Loader2,
  Copy,
  ExternalLink,
  Check,
  CheckCircle2,
  AlertTriangle,
  X,
  RotateCcw,
} from 'lucide-react';
import type { StoredRecording } from '../types';
import { renameRecording } from '../lib/storage';
import { isBunnyConfigured } from '../lib/settings';
import { formatBytes } from '../lib/format';
import { toast } from '../lib/toast';
import { confirmDialog, promptDialog } from '../lib/confirm';
import {
  cancelUpload,
  enqueueUpload,
  isActive,
  latestJobFor,
  reupload,
  streamProgressFor,
  useUploadJobs,
  watchStreamStatus,
} from '../lib/uploads';

interface Props {
  recording: StoredRecording;
  variant?: 'primary' | 'secondary' | 'icon';
  onUploaded?: (rec: StoredRecording) => void;
}

// Auto-generated names look like recording-2026-07-02_17-45-38 — worth
// prompting for something a client will actually see in the library.
const DEFAULT_NAME_RE = /^recording-\d{4}-\d{2}-\d{2}/i;

function normalizeUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url.replace(/^\/+/, '');
}

/**
 * Starts an upload and shows its state. The upload itself runs in the
 * background manager (lib/uploads), not here: leaving this screen does not
 * stop it, and coming back shows the live progress.
 */
export function UploadButton({ recording, variant = 'secondary', onUploaded }: Props) {
  const jobs = useUploadJobs();
  const [copied, setCopied] = useState(false);
  const configured = isBunnyConfigured();

  // A job only describes this recording if the cut did not change after it
  // started — re-cutting clears the upload, an older finished job is stale.
  const rawJob = latestJobFor(recording.id, jobs);
  const job =
    rawJob && !(recording.edits && recording.edits.updatedAt > rawJob.createdAt)
      ? rawJob
      : undefined;
  const active = job && isActive(job) ? job : undefined;
  const url = recording.uploadedUrl ?? (job?.status === 'done' ? job.url : undefined);
  const streamState: 'processing' | 'ready' | 'error' =
    recording.streamStatus ?? (job?.status === 'done' ? 'processing' : 'ready');

  // Re-opened a recording Bunny was still processing: keep watching it.
  useEffect(() => {
    if (recording.uploadedUrl && recording.streamGuid && recording.streamStatus === 'processing') {
      watchStreamStatus(recording.id, recording.streamGuid, recording.name);
    }
  }, [recording.id, recording.uploadedUrl, recording.streamGuid, recording.streamStatus, recording.name]);

  const handleUpload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!configured) {
      toast.warning('Nastav nejdřív Bunny Stream v Nastavení.', {
        title: 'Není nastaveno',
      });
      return;
    }

    // Give the video a client-facing name before it lands in the Stream
    // library (only nudge when the name is still the auto timestamp).
    let uploadName = recording.name;
    if (DEFAULT_NAME_RE.test(recording.name)) {
      const title = await promptDialog({
        title: 'Pojmenuj video',
        message: 'Tenhle název uvidíš v Bunny knihovně i v odkazu pro klienta.',
        label: 'Název videa',
        placeholder: 'Např. Homepage brief pro klienta',
        confirmLabel: 'Nahrát',
      });
      if (title === null) return; // cancelled
      const origExt = recording.name.match(/\.[^.]+$/)?.[0] || '';
      uploadName =
        origExt && !title.toLowerCase().endsWith(origExt.toLowerCase())
          ? title + origExt
          : title;
      try {
        await renameRecording(recording.id, uploadName);
        onUploaded?.({ ...recording, name: uploadName });
      } catch {
        /* non-fatal: upload can still proceed with the chosen name */
      }
    }

    enqueueUpload({ ...recording, name: uploadName }, uploadName);
    toast.info('Upload běží na pozadí. Můžeš mezitím dál pracovat.', { duration: 4000 });
  };

  const handleReupload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!configured) return;
    if (streamState === 'ready') {
      const ok = await confirmDialog({
        title: 'Nahrát znovu?',
        message:
          'Vznikne nové video s novým odkazem. To současné v Bunny zůstane, ' +
          'odkazy, které už jsi poslal, budou dál fungovat.',
        confirmLabel: 'Nahrát znovu',
      });
      if (!ok) return;
    }
    await reupload(recording);
    toast.info('Nahrávám znovu na pozadí. Prázdné nebo rozbité video v Bunny klidně smaž.', {
      duration: 5000,
    });
  };

  const copyLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(normalizeUrl(url));
      setCopied(true);
      toast.success('Link zkopírován do schránky.');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Nepodařilo se zkopírovat. Zkus znovu.');
    }
  };

  const progressLabel = active
    ? active.status === 'queued'
      ? 'Čeká ve frontě…'
      : active.status === 'cutting'
      ? 'Server stříhá video…'
      : `Nahrávám… ${Math.round(active.pct)} % (${formatBytes(active.loaded)} / ${formatBytes(active.total)})`
    : '';

  // ───── Compact (icon) variant for cards ─────
  if (variant === 'icon') {
    if (active) {
      return (
        <span
          title={`${progressLabel} Klikni pro zrušení.`}
          onClick={(e) => {
            e.stopPropagation();
            cancelUpload(active.id);
          }}
          className="btn-ghost p-1.5 cursor-pointer text-accent"
        >
          <Loader2 className="w-4 h-4 animate-spin" />
        </span>
      );
    }
    if (url) {
      return (
        <span
          onClick={copyLink}
          title={
            streamState === 'processing'
              ? 'Bunny video zpracovává… link už jde kopírovat'
              : copied
              ? 'Zkopírováno'
              : `Kopírovat link (${normalizeUrl(url)})`
          }
          className="btn-ghost p-1.5 cursor-pointer text-accent"
        >
          {copied ? (
            <Check className="w-4 h-4" />
          ) : streamState === 'processing' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Cloud className="w-4 h-4" />
          )}
        </span>
      );
    }
    return (
      <span
        onClick={handleUpload}
        title={configured ? 'Nahrát na Bunny' : 'Nejdřív nastav v Nastavení'}
        className={`btn-ghost p-1.5 cursor-pointer ${configured ? '' : 'opacity-40'}`}
      >
        <UploadCloud className="w-4 h-4" />
      </span>
    );
  }

  // ───── Full button variant for Preview ─────
  if (active) {
    return (
      <div className="flex flex-col gap-2 min-w-[260px]">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-accent shrink-0" />
          <span className="flex-1">{progressLabel}</span>
          <button
            onClick={() => cancelUpload(active.id)}
            className="btn-ghost p-1 text-xs"
            title="Přerušit upload"
          >
            <X className="w-3.5 h-3.5" /> Přerušit
          </button>
        </div>
        <div className="w-full h-1.5 bg-bg-elev rounded-full overflow-hidden">
          <div
            className={`h-full bg-accent transition-all ${active.status !== 'uploading' ? 'animate-pulse' : ''}`}
            style={{ width: `${active.status === 'queued' ? 0 : active.pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (url) {
    return (
      <div className="flex flex-wrap items-center gap-2 bg-accent-subtle border border-accent/30 rounded-xl px-3 py-2">
        {streamState === 'processing' ? (
          <>
            <Loader2 className="w-4 h-4 text-accent animate-spin" />
            <span className="text-sm text-accent">
              Bunny zpracovává…
              {streamProgressFor(recording.id) ? ` ${Math.round(streamProgressFor(recording.id)!)} %` : ''}
            </span>
          </>
        ) : streamState === 'error' ? (
          <>
            <AlertTriangle className="w-4 h-4 text-danger" />
            <span className="text-sm text-danger">Zpracování selhalo</span>
          </>
        ) : (
          <>
            <CheckCircle2 className="w-4 h-4 text-success" />
            <span className="text-sm text-success">Připraveno k odeslání</span>
          </>
        )}
        <code className="text-xs text-text-primary bg-bg-elev rounded px-2 py-0.5 max-w-[260px] truncate">
          {normalizeUrl(url)}
        </code>
        <button onClick={copyLink} className="btn-ghost p-1.5 text-xs">
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-success" /> Zkopírováno
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" /> Kopírovat
            </>
          )}
        </button>
        <a
          href={normalizeUrl(url)}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost p-1.5 text-xs"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Otevřít
        </a>
        <button
          onClick={handleReupload}
          className={streamState === 'error' ? 'btn-primary px-2.5 py-1 text-xs' : 'btn-ghost p-1.5 text-xs'}
          title="Nahrát video na Bunny znovu (nový odkaz)"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Nahrát znovu
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleUpload}
        disabled={!configured}
        className={variant === 'primary' ? 'btn-primary' : 'btn-secondary'}
        title={configured ? undefined : 'Nejdřív nastav v Nastavení'}
      >
        <UploadCloud className="w-4 h-4" /> Nahrát na Bunny
      </button>
      {job?.status === 'error' && (
        <span className="text-xs text-danger max-w-[260px]">{job.error}</span>
      )}
    </div>
  );
}
