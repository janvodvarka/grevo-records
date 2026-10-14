import { useState } from 'react';
import { RefreshCw, Sparkles, X } from 'lucide-react';
import { useUpdateChecker } from '../hooks/useUpdateChecker';
import { BUILD_SHA } from '../lib/version';

export function UpdateBanner() {
  const { hasUpdate, latestSha } = useUpdateChecker(60_000);
  const [dismissed, setDismissed] = useState(false);

  if (!hasUpdate || dismissed) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[90] animate-fade-in">
      <div className="flex items-center gap-3 bg-accent text-[#141416] rounded-full pl-4 pr-2 py-2 shadow-glow">
        <Sparkles className="w-4 h-4" />
        <div className="text-sm font-medium">
          Nová verze připravena{' '}
          <span className="meter text-xs opacity-60">
            ({BUILD_SHA} → {latestSha})
          </span>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="bg-[#141416]/12 hover:bg-[#141416]/22 text-[#141416] text-xs font-semibold px-3 py-1 rounded-full inline-flex items-center gap-1.5 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Aktualizovat
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="text-[#141416]/60 hover:text-[#141416] p-1"
          title="Skrýt"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
