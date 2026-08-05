import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
  Video,
  Search,
  Download,
  Cloud,
  CheckSquare,
  Square,
  X,
  AlertTriangle,
  HardDrive,
  Play,
  Eraser,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import type { StoredRecording } from '../types';
import { formatBytes, formatDate, formatDuration } from '../lib/format';
import { listRecordings, deleteRecording, estimateStorage } from '../lib/storage';
import { downloadBlob } from '../lib/download';
import { UploadButton } from './UploadButton';
import { confirmDialog } from '../lib/confirm';
import { toast } from '../lib/toast';

type FilterMode = 'all' | 'uploaded' | 'local';
type SortMode = 'newest' | 'oldest' | 'size' | 'duration';

interface Props {
  onOpen: (rec: StoredRecording) => void;
}

export function Library({ onOpen }: Props) {
  const [recordings, setRecordings] = useState<StoredRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [sort, setSort] = useState<SortMode>('newest');
  const [usage, setUsage] = useState<{
    usage: number;
    quota: number;
    persisted: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      const [list, est] = await Promise.all([listRecordings(), estimateStorage()]);
      setRecordings(list);
      setUsage(est);
    } catch (e) {
      toast.error('Nepodařilo se načíst knihovnu: ' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    let list = recordings.filter((r) =>
      r.name.toLowerCase().includes(query.toLowerCase())
    );
    if (filter === 'uploaded') list = list.filter((r) => !!r.uploadedUrl);
    else if (filter === 'local') list = list.filter((r) => !r.uploadedUrl);

    list = [...list].sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return a.createdAt - b.createdAt;
        case 'size':
          return b.size - a.size;
        case 'duration':
          return b.durationMs - a.durationMs;
        case 'newest':
        default:
          return b.createdAt - a.createdAt;
      }
    });
    return list;
  }, [recordings, query, filter, sort]);

  const uploadedCount = recordings.filter((r) => !!r.uploadedUrl).length;
  // Safe to purge locally: on Bunny and not in an error state. Keep failed
  // uploads local so they aren't lost.
  const cleanupTargets = recordings.filter(
    (r) => r.uploadedUrl && r.streamStatus !== 'error'
  );
  const cleanupBytes = cleanupTargets.reduce((a, r) => a + r.size, 0);
  const selectionMode = selected.size > 0;

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(filtered.map((r) => r.id)));
  };

  const clearSelection = () => setSelected(new Set());

  const handleDelete = async (rec: StoredRecording, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Smazat nahrávku?',
      message: `${rec.name} bude trvale odstraněna z lokální knihovny. Pokud je na Bunny, soubor v cloudu zůstane.`,
      confirmLabel: 'Smazat',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteRecording(rec.id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(rec.id);
        return next;
      });
      load();
    } catch (e) {
      toast.error('Smazání selhalo: ' + (e as Error).message);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const ok = await confirmDialog({
      title: `Smazat ${ids.length} nahrávek?`,
      message: 'Všechny vybrané budou trvale odstraněny z lokální knihovny.',
      confirmLabel: `Smazat ${ids.length}`,
      danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteRecording(id);
      } catch {
        failed++;
      }
    }
    clearSelection();
    load();
    if (failed === 0) {
      toast.success(`Smazáno ${ids.length} nahrávek.`);
    } else {
      toast.warning(
        `Smazáno ${ids.length - failed} z ${ids.length} (${failed} selhalo).`
      );
    }
  };

  const handleCleanupUploaded = async () => {
    if (cleanupTargets.length === 0) return;
    const ok = await confirmDialog({
      title: `Uvolnit ${formatBytes(cleanupBytes)}?`,
      message: `${cleanupTargets.length} nahrávek je bezpečně na Bunny Stream. Smažu jejich lokální kopie z prohlížeče, odkazy na Bunny zůstanou funkční. Střih u nich pak už nepůjde.`,
      confirmLabel: 'Uvolnit místo',
      danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const rec of cleanupTargets) {
      try {
        await deleteRecording(rec.id);
      } catch {
        failed++;
      }
    }
    clearSelection();
    load();
    if (failed === 0) {
      toast.success(`Uvolněno ${formatBytes(cleanupBytes)} (${cleanupTargets.length} nahrávek).`);
    } else {
      toast.warning(`Uklizeno ${cleanupTargets.length - failed} z ${cleanupTargets.length}.`);
    }
  };

  const handleBulkDownload = async () => {
    const items = recordings.filter((r) => selected.has(r.id));
    for (const rec of items) {
      downloadBlob(rec.blob, rec.name);
      // Stagger to avoid browser blocking multiple downloads
      await new Promise((r) => setTimeout(r, 200));
    }
    toast.success(`Stahuje se ${items.length} souborů.`);
  };

  const handleDownload = (rec: StoredRecording, e: React.MouseEvent) => {
    e.stopPropagation();
    downloadBlob(rec.blob, rec.name);
  };

  const handleCardClick = (rec: StoredRecording, e: React.MouseEvent) => {
    if (selectionMode) {
      e.stopPropagation();
      toggleSelected(rec.id);
    } else {
      onOpen(rec);
    }
  };

  return (
    <div className="min-h-full p-6 sm:p-10 max-w-6xl mx-auto animate-fade-in">
      <header className="flex flex-wrap items-end justify-between gap-4 mb-6 pt-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Knihovna</h1>
          <p className="text-text-secondary mt-2 text-sm">
            Nahrávky uložené v prohlížeči, vidíš jen své.
          </p>
        </div>
        {usage && usage.quota > 0 && (() => {
          const pct = (usage.usage / usage.quota) * 100;
          const warn = pct > 80;
          return (
            <div
              className={`flex items-center gap-3 px-4 py-2 rounded-xl border min-w-[260px] ${
                warn
                  ? 'bg-accent-subtle border-accent/30'
                  : 'bg-bg-card border-bg-border'
              }`}
            >
              {warn ? (
                <AlertTriangle className="w-4 h-4 text-accent shrink-0" />
              ) : (
                <HardDrive className="w-4 h-4 text-text-secondary shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-secondary mb-1 flex justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    {formatBytes(usage.usage)} z {formatBytes(usage.quota)}
                    {usage.persisted && (
                      <ShieldCheck
                        className="w-3.5 h-3.5 text-success shrink-0"
                        aria-label="Trvalé úložiště: nahrávky prohlížeč sám nesmaže"
                      />
                    )}
                  </span>
                  <span className="tabular-nums">{pct.toFixed(0)}%</span>
                </div>
                <div className="w-full h-1.5 bg-bg-elev rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      warn ? 'bg-accent' : 'bg-accent'
                    }`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })()}
      </header>

      <div className="flex flex-wrap items-center gap-2 mb-6">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Hledat nahrávku…"
            className="input w-full pl-9"
          />
        </div>

        <div className="inline-flex bg-bg-elev rounded-lg p-1">
          {([
            ['all', `Vše · ${recordings.length}`],
            ['uploaded', `Na Bunny · ${uploadedCount}`],
            ['local', `Lokální · ${recordings.length - uploadedCount}`],
          ] as [FilterMode, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                filter === key
                  ? 'bg-bg-card text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          className="input"
          style={{ width: 'auto' }}
        >
          <option value="newest">Nejnovější</option>
          <option value="oldest">Nejstarší</option>
          <option value="size">Největší</option>
          <option value="duration">Nejdelší</option>
        </select>

        {cleanupTargets.length > 0 && (
          <button
            onClick={handleCleanupUploaded}
            className="btn-ghost text-xs whitespace-nowrap"
            title="Smazat lokální kopie videí, která už jsou na Bunny Stream"
          >
            <Eraser className="w-3.5 h-3.5" /> Uklidit nahrané ({cleanupTargets.length})
          </button>
        )}
      </div>

      {/* Bulk action bar — only when something is selected */}
      {selectionMode && (
        <div className="flex items-center justify-between gap-2 mb-4 bg-accent-subtle border border-accent/30 rounded-xl p-3 animate-fade-in">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium">{selected.size} vybráno</span>
            <button
              onClick={selectAll}
              className="text-xs text-accent hover:underline"
            >
              Vybrat všechny v zobrazení ({filtered.length})
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleBulkDownload} className="btn-secondary text-xs">
              <Download className="w-3.5 h-3.5" /> Stáhnout
            </button>
            <button onClick={handleBulkDelete} className="btn-danger text-xs">
              <Trash2 className="w-3.5 h-3.5" /> Smazat
            </button>
            <button onClick={clearSelection} className="btn-ghost p-1.5">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <LibrarySkeleton />
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center">
          <Video className="w-12 h-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">
            {recordings.length === 0
              ? 'Zatím tu nic není. Pojď něco nahrát!'
              : 'Žádné shody.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((rec) => (
            <RecordingCard
              key={rec.id}
              rec={rec}
              selected={selected.has(rec.id)}
              selectionMode={selectionMode}
              onClick={(e) => handleCardClick(rec, e)}
              onToggleSelect={(e) => {
                e.stopPropagation();
                toggleSelected(rec.id);
              }}
              onDelete={(e) => handleDelete(rec, e)}
              onDownload={(e) => handleDownload(rec, e)}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LibrarySkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card overflow-hidden animate-pulse">
          <div className="aspect-video bg-bg-elev" />
          <div className="p-4 space-y-2">
            <div className="h-4 bg-bg-elev rounded w-3/4" />
            <div className="h-3 bg-bg-elev rounded w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecordingCard({
  rec,
  selected,
  selectionMode,
  onClick,
  onToggleSelect,
  onDelete,
  onDownload,
  onChanged,
}: {
  rec: StoredRecording;
  selected: boolean;
  selectionMode: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggleSelect: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onDownload: (e: React.MouseEvent) => void;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState<string>('');
  const [hovering, setHovering] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const u = URL.createObjectURL(rec.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [rec.blob]);

  // Hover-to-play: when card is hovered, start playback muted from beginning;
  // when leaving, pause & reset.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hovering) {
      v.currentTime = 0;
      v.play().catch(() => {});
    } else {
      v.pause();
      try {
        v.currentTime = 0;
      } catch {}
    }
  }, [hovering]);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className={`card text-left overflow-hidden group cursor-pointer transition-all ${
        selected
          ? 'border-accent ring-2 ring-accent/40'
          : 'hover:border-accent'
      }`}
    >
      <div className="aspect-video bg-black relative">
        {url && (
          <video
            ref={videoRef}
            src={url}
            preload="metadata"
            className="w-full h-full object-cover"
            muted
            playsInline
            loop
          />
        )}

        {/* Selection checkbox (always visible if selection mode active, on hover otherwise) */}
        <button
          onClick={onToggleSelect}
          className={`absolute top-2 right-2 z-10 w-7 h-7 rounded-md bg-black/70 backdrop-blur flex items-center justify-center transition-opacity ${
            selectionMode || selected
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100'
          }`}
          title={selected ? 'Odznačit' : 'Vybrat'}
        >
          {selected ? (
            <CheckSquare className="w-4 h-4 text-accent" />
          ) : (
            <Square className="w-4 h-4 text-white/80" />
          )}
        </button>

        {rec.uploadedUrl && (
          rec.streamStatus === 'processing' ? (
            <span
              className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-bg-card/90 text-text-primary text-[10px] font-medium inline-flex items-center gap-1"
              title="Bunny Stream video zpracovává"
            >
              <Loader2 className="w-3 h-3 animate-spin text-accent" /> Zpracovává…
            </span>
          ) : rec.streamStatus === 'error' ? (
            <span
              className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-danger text-white text-[10px] font-semibold inline-flex items-center gap-1"
              title="Zpracování na Bunny selhalo"
            >
              <AlertTriangle className="w-3 h-3" /> Chyba
            </span>
          ) : (
            <span
              className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-accent text-[#1A1408] text-[10px] font-semibold inline-flex items-center gap-1"
              title="Na Bunny Stream, připraveno k odeslání"
            >
              <Cloud className="w-3 h-3" /> Bunny
            </span>
          )
        )}
        {rec.durationMs > 0 && (
          <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/70 text-xs font-mono">
            {formatDuration(rec.durationMs / 1000)}
          </span>
        )}
        {hovering && (
          <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md bg-accent text-[#1A1408] text-[10px] font-semibold inline-flex items-center gap-1 animate-fade-in">
            <Play className="w-2.5 h-2.5 fill-current" /> náhled
          </span>
        )}
      </div>
      <div className="p-4">
        <div className="font-medium text-sm truncate" title={rec.name}>
          {rec.name}
        </div>
        <div className="text-xs text-text-muted mt-1 flex items-center justify-between">
          <span>{formatDate(rec.createdAt)}</span>
          <span>{formatBytes(rec.size)}</span>
        </div>
        <div className="flex items-center justify-end gap-1 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
          <UploadButton recording={rec} variant="icon" onUploaded={onChanged} />
          <span
            onClick={onDownload}
            className="btn-ghost p-1.5 cursor-pointer"
            title="Stáhnout"
          >
            <Download className="w-4 h-4" />
          </span>
          <span
            onClick={onDelete}
            className="btn-ghost p-1.5 cursor-pointer hover:text-danger"
            title="Smazat"
          >
            <Trash2 className="w-4 h-4" />
          </span>
        </div>
      </div>
    </div>
  );
}
