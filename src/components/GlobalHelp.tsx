import { useEffect, useState } from 'react';
import { Keyboard, X } from 'lucide-react';

interface Section {
  title: string;
  rows: [string, string][];
}

const SECTIONS: Section[] = [
  {
    title: 'Obecné',
    rows: [
      ['?', 'Zobrazit / skrýt nápovědu'],
      ['Esc', 'Zavřít dialog / nápovědu'],
    ],
  },
  {
    title: 'Trim editor',
    rows: [
      ['Space / K', 'Play / pauza'],
      ['J / L', 'Posun -5s / +5s'],
      ['← / →', 'Krok 1 frame zpět / vpřed'],
      ['Shift + ← / →', 'Krok 1 s zpět / vpřed'],
      ['I', 'Mark IN (ořez začátek)'],
      ['O', 'Mark OUT (ořez konec)'],
      ['C', 'Vyříznout úsek na pozici'],
      ['Shift + drag', 'Nakreslit výřez na timeline'],
      ['Delete / Backspace', 'Odebrat výřez'],
      ['⌘Z / ⇧⌘Z', 'Krok zpět / vpřed ve střihu'],
    ],
  },
];

export function GlobalHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't intercept when user is typing in inputs
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      // Toggle on "?"
      if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="card p-6 max-w-2xl w-full animate-fade-in max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent-subtle text-accent flex items-center justify-center">
              <Keyboard className="w-5 h-5" />
            </div>
            <h2 className="font-semibold">Klávesové zkratky</h2>
          </div>
          <button onClick={() => setOpen(false)} className="btn-ghost p-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-6">
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <h3 className="text-xs uppercase tracking-widest text-text-muted mb-3 font-semibold">
                {sec.title}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {sec.rows.map(([keys, desc]) => (
                  <div
                    key={keys}
                    className="flex items-center justify-between gap-3 py-1.5 border-b border-bg-border/40 last:border-0"
                  >
                    <span className="text-text-secondary">{desc}</span>
                    <kbd className="px-2 py-0.5 bg-bg-elev border border-bg-border rounded text-[11px] font-mono text-text-primary whitespace-nowrap">
                      {keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="text-xs text-text-muted text-center mt-6">
          Stiskni <kbd className="px-1.5 py-0.5 bg-bg-elev border border-bg-border rounded text-[10px] font-mono">?</kbd> kdykoli pro tuto nápovědu.
        </p>
      </div>
    </div>
  );
}
