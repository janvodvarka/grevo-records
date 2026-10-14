import { useEffect, useRef, useState } from 'react';
import {
  Cloud,
  UploadCloud,
  Loader2,
  Copy,
  ExternalLink,
  Check,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import type { StoredRecording } from '../types';
import { uploadToBunny, pollStreamStatus } from '../lib/upload';
import { setUploadedUrl, setStreamStatus, renameRecording } from '../lib/storage';
import { isBunnyConfigured } from '../lib/settings';
import { formatBytes } from '../lib/format';
import { toast } from '../lib/toast';
import { promptDialog } from '../lib/confirm';
import { keptSegments } from '../lib/edits';

interface Props {
  recording: StoredRecording;
  variant?: 'primary' | 'secondary' | 'icon';
  onUploaded?: (rec: StoredRecording) => void;
}

type State =
  | { kind: 'idle' }
  | { kind: 'uploading'; loaded: number; total: number; pct: number }
  | { kind: 'success'; url: string }
  | { kind: 'error'; message: string };

// Auto-generated names look like recording-2026-07-02_17-45-38 — worth
// prompting for something a client will actually see in the library.
const DEFAULT_NAME_RE = /^recording-\d{4}-\d{2}-\d{2}/i;

function normalizeUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url.replace(/^\/+/, '');
}

export function UploadButton({ recording, variant = 'secondary', onUploaded }: Props) {
  const [state, setState] = useState<State>(
    recording.uploadedUrl
      ? { kind: 'success', url: recording.uploadedUrl }
      : { kind: 'idle' }
  );
  const [copied, setCopied] = useState(false);
  const [streamState, setStreamState] = useState<
    'processing' | 'ready' | 'error' | null
  >(recording.uploadedUrl ? recording.streamStatus ?? 'ready' : null);
  const configured = isBunnyConfigured();
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (recording.uploadedUrl) {
      setState({ kind: 'success', url: recording.uploadedUrl });
      setStreamState(recording.streamStatus ?? 'ready');
    } else {
      setState({ kind: 'idle' });
      setStreamState(null);
    }
  }, [recording.id, recording.uploadedUrl, recording.streamStatus]);

  // Resume polling if we re-open a recording that was still processing.
  useEffect(() => {
    if (
      recording.uploadedUrl &&
      recording.streamGuid &&
      recording.streamStatus === 'processing'
    ) {
      startPolling(recording.id, recording.streamGuid);
    }
    return () => pollAbort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.id]);

  const startPolling = (id: string, guid: string) => {
    pollAbort.current?.abort();
    const ac = new AbortController();
    pollAbort.current = ac;
    setStreamState('processing');
    pollStreamStatus(guid, (s) => setStreamState(s.state), { signal: ac.signal })
      .then(async (final) => {
        if (ac.signal.aborted) return;
        await setStreamStatus(id, final.state).catch(() => {});
        setStreamState(final.state);
        if (final.state === 'ready') {
          toast.success('Video je zpracované, link je připravený poslat klientovi.', {
            title: 'Hotovo',
          });
        } else if (final.state === 'error') {
          toast.error('Bunny hlásí chybu při zpracování videa. Zkus ho nahrát znovu.', {
            title: 'Zpracování selhalo',
          });
        }
      })
      .catch(() => {});
  };

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
      } catch {
        /* non-fatal: upload can still proceed with the chosen name */
      }
    }

    setState({ kind: 'uploading', loaded: 0, total: recording.size, pct: 0 });
    try {
      const result = await uploadToBunny(
        recording.blob,
        uploadName,
        (loaded, total, pct) =>
          setState({ kind: 'uploading', loaded, total, pct }),
        {
          // Saved cut is applied on the server, natively, during this upload.
          segments: keptSegments(recording),
          onRetry: (attempt, reason) =>
            toast.warning(`Pokus ${attempt} selhal (${reason}). Zkouším znovu…`, {
              title: 'Upload retry',
              duration: 4000,
            }),
        }
      );
      const updated = await setUploadedUrl(recording.id, result.url, result.guid);
      setState({ kind: 'success', url: result.url });
      toast.success('Nahráno na Bunny Stream. Sleduju zpracování…', {
        title: 'Nahráno',
      });
      if (updated && onUploaded) onUploaded(updated);
      if (result.guid) startPolling(recording.id, result.guid);
      else setStreamState('ready');
    } catch (err) {
      const message = (err as Error).message;
      setState({ kind: 'error', message });
      toast.error(message, { title: 'Upload selhal' });
    }
  };

  const copyLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state.kind !== 'success') return;
    try {
      await navigator.clipboard.writeText(normalizeUrl(state.url));
      setCopied(true);
      toast.success('Link zkopírován do schránky.');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Nepodařilo se zkopírovat. Zkus znovu.');
    }
  };

  // ───── Compact (icon) variant for cards ─────
  if (variant === 'icon') {
    if (state.kind === 'success') {
      return (
        <span
          onClick={copyLink}
          title={
            streamState === 'processing'
              ? 'Bunny video zpracovává… link už jde kopírovat'
              : copied
              ? 'Zkopírováno'
              : `Kopírovat link (${normalizeUrl(state.url)})`
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
    if (state.kind === 'uploading') {
      return (
        <span
          title={`Nahrávám ${Math.round(state.pct)}%`}
          className="btn-ghost p-1.5 cursor-default text-accent"
        >
          <Loader2 className="w-4 h-4 animate-spin" />
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
  if (state.kind === 'success') {
    return (
      <div className="flex flex-wrap items-center gap-2 bg-accent-subtle border border-accent/30 rounded-xl px-3 py-2">
        {streamState === 'processing' ? (
          <>
            <Loader2 className="w-4 h-4 text-accent animate-spin" />
            <span className="text-sm text-accent">Bunny zpracovává…</span>
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
          {normalizeUrl(state.url)}
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
          href={normalizeUrl(state.url)}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost p-1.5 text-xs"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Otevřít
        </a>
      </div>
    );
  }

  if (state.kind === 'uploading') {
    return (
      <div className="flex flex-col gap-2 min-w-[240px]">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          <span>
            {state.pct >= 100 && keptSegments(recording)
              ? 'Server stříhá video…'
              : `Nahrávám… ${Math.round(state.pct)}% (${formatBytes(
                  state.loaded
                )} / ${formatBytes(state.total)})`}
          </span>
        </div>
        <div className="w-full h-1.5 bg-bg-elev rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${state.pct}%` }}
          />
        </div>
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
      {state.kind === 'error' && (
        <span className="text-xs text-danger max-w-[260px]">{state.message}</span>
      )}
    </div>
  );
}
