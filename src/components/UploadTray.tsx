import { useState } from 'react';
import {
  UploadCloud,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  X,
  ChevronDown,
  ChevronUp,
  Ban,
} from 'lucide-react';
import {
  cancelUpload,
  dismissFinished,
  dismissJob,
  isActive,
  useUploadJobs,
  type UploadJob,
} from '../lib/uploads';
import { formatBytes } from '../lib/format';

interface Props {
  onOpenRecording: (recordingId: string) => void;
}

/**
 * Background uploads, visible on every screen: progress, cancel, and a way
 * back to the recording. Collapses to a single line so it never covers the
 * work underneath.
 */
export function UploadTray({ onOpenRecording }: Props) {
  const jobs = useUploadJobs();
  const [collapsed, setCollapsed] = useState(false);
  if (jobs.length === 0) return null;

  const active = jobs.filter(isActive);
  const finished = jobs.filter((j) => !isActive(j));
  const current = active.find((j) => j.status !== 'queued');
  const queued = active.filter((j) => j.status === 'queued').length;

  const summary =
    active.length > 0
      ? current
        ? `${statusLabel(current)}${queued ? ` · ${queued} ve frontě` : ''}`
        : `${queued} ve frontě`
      : finished.every((j) => j.status === 'done')
      ? 'Uploady dokončené'
      : 'Uploady skončily';

  return (
    <div className="fixed z-50 right-4 bottom-20 md:bottom-4 w-[min(360px,calc(100vw-2rem))] card shadow-soft animate-fade-in">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left"
      >
        {active.length > 0 ? (
          <Loader2 className="w-4 h-4 animate-spin text-accent shrink-0" />
        ) : (
          <UploadCloud className="w-4 h-4 text-text-secondary shrink-0" />
        )}
        <span className="flex-1 truncate">{summary}</span>
        {collapsed ? (
          <ChevronUp className="w-4 h-4 text-text-muted" />
        ) : (
          <ChevronDown className="w-4 h-4 text-text-muted" />
        )}
      </button>

      {!collapsed && (
        <div className="border-t border-bg-border max-h-72 overflow-y-auto">
          {[...jobs].reverse().map((job) => (
            <JobRow
              key={job.id}
              job={job}
              onOpen={() => onOpenRecording(job.recordingId)}
            />
          ))}
          {finished.length > 0 && (
            <div className="px-3 py-2 border-t border-bg-border flex justify-end">
              <button onClick={dismissFinished} className="btn-ghost text-xs px-2 py-1">
                Vyčistit hotové
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function statusLabel(job: UploadJob): string {
  switch (job.status) {
    case 'queued':
      return 'Čeká ve frontě';
    case 'uploading':
      return `Nahrávám ${Math.round(job.pct)} %`;
    case 'cutting':
      return 'Server stříhá video';
    case 'done':
      return job.streamReady ? 'Hotovo, link je připravený' : 'Nahráno, Bunny zpracovává';
    case 'error':
      return 'Selhalo';
    case 'cancelled':
      return 'Zrušeno';
  }
}

function JobRow({ job, onOpen }: { job: UploadJob; onOpen: () => void }) {
  const running = isActive(job);
  return (
    <div className="px-3 py-2.5 flex items-start gap-2.5 border-b border-bg-border last:border-b-0">
      <div className="mt-0.5 shrink-0">
        {running ? (
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
        ) : job.status === 'done' ? (
          <CheckCircle2 className="w-4 h-4 text-success" />
        ) : job.status === 'error' ? (
          <AlertTriangle className="w-4 h-4 text-danger" />
        ) : (
          <Ban className="w-4 h-4 text-text-muted" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={onOpen}
          className="block w-full text-left text-sm truncate hover:underline"
          title="Otevřít nahrávku"
        >
          {job.name}
        </button>
        <div className={`text-xs mt-0.5 ${job.status === 'error' ? 'text-danger' : 'text-text-muted'}`}>
          {job.status === 'error' && job.error ? job.error : statusLabel(job)}
          {job.status === 'uploading' && ` · ${formatBytes(job.loaded)} z ${formatBytes(job.total)}`}
        </div>
        {running && (
          <div className="mt-1.5 w-full h-1 bg-bg-elev rounded-full overflow-hidden">
            <div
              className={`h-full bg-accent transition-all ${job.status !== 'uploading' ? 'animate-pulse' : ''}`}
              style={{ width: `${job.status === 'queued' ? 0 : job.status === 'cutting' ? 100 : job.pct}%` }}
            />
          </div>
        )}
      </div>
      {running ? (
        <button
          onClick={() => cancelUpload(job.id)}
          className="btn-ghost p-1 text-xs shrink-0"
          title="Přerušit upload"
        >
          <X className="w-3.5 h-3.5" /> Přerušit
        </button>
      ) : (
        <button
          onClick={() => dismissJob(job.id)}
          className="btn-ghost p-1 shrink-0"
          title="Skrýt"
          aria-label="Skrýt"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
