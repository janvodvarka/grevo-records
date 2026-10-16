import { useEffect, useState } from 'react';
import {
  Save,
  Check,
  Play,
  Eye,
  EyeOff,
  Server,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import {
  loadBunnySettings,
  saveBunnySettings,
  type BunnySettings,
  normalizeCollectionId,
} from '../lib/settings';
import { PROXY_URL } from '../lib/proxy-config';
import { toast } from '../lib/toast';

export function Settings() {
  const [bunny, setBunny] = useState<BunnySettings>(loadBunnySettings());
  const [savedFlash, setSavedFlash] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [pingState, setPingState] = useState<
    | { kind: 'idle' }
    | { kind: 'pinging' }
    | { kind: 'ok'; data: any }
    | { kind: 'fail'; message: string }
  >({ kind: 'idle' });

  const update = <K extends keyof BunnySettings>(key: K, val: BunnySettings[K]) => {
    setBunny((s) => ({ ...s, [key]: val }));
  };

  useEffect(() => {
    setPingState({ kind: 'idle' });
  }, []);

  const handleSave = () => {
    // Validate when enabled — surface missing fields up front
    if (bunny.enabled) {
      const missing: string[] = [];
      if (!/^\d+$/.test(bunny.libraryId.trim())) missing.push('Library ID (číslo)');
      if (!bunny.apiKey.trim()) missing.push('API klíč');
      if (missing.length > 0) {
        toast.warning(`Bunny upload je zapnutý, ale chybí: ${missing.join(', ')}`, {
          title: 'Doplň pole',
        });
        return;
      }
    }
    try {
      saveBunnySettings(bunny);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      toast.error(
        'Nepodařilo se uložit (možná plný localStorage): ' + (e as Error).message
      );
    }
  };

  const testConnection = async () => {
    setPingState({ kind: 'pinging' });
    try {
      const res = await fetch(`${PROXY_URL}/`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPingState({ kind: 'ok', data });
    } catch (e) {
      setPingState({ kind: 'fail', message: (e as Error).message });
    }
  };

  return (
    <div className="min-h-full p-6 sm:p-10 max-w-3xl mx-auto animate-fade-in">
      <header className="pt-4 mb-8">
        <h1 className="display text-[28px] font-bold tracking-tight">Nastavení</h1>
        <p className="text-text-secondary mt-2">
          Nahrávky se posílají do <strong>tvojí vlastní</strong> Bunny Stream
          knihovny. Přehrávají se adaptivně jako na YouTube, klient nic
          nestahuje.
        </p>
      </header>

      <section className="card p-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent-subtle text-accent flex items-center justify-center shrink-0">
              <Play className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-semibold">Bunny Stream upload</h2>
              <p className="text-sm text-text-secondary mt-1">
                API klíč se ukládá jen u tebe v prohlížeči. Posílá se přes
                HTTPS do sdílené proxy, která ho předá Bunny. Proxy nic
                neukládá.
              </p>
            </div>
          </div>
          <Toggle on={bunny.enabled} onChange={(v) => update('enabled', v)} />
        </div>

        <div
          className={`space-y-4 transition-opacity ${
            bunny.enabled ? '' : 'opacity-50 pointer-events-none'
          }`}
        >
          <Field
            label="Video Library ID"
            hint="Bunny dashboard → Stream → tvoje knihovna → API. Je to číslo, např. 493169."
          >
            <input
              type="text"
              inputMode="numeric"
              className="input w-full font-mono"
              placeholder="493169"
              value={bunny.libraryId}
              onChange={(e) => update('libraryId', e.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field
            label="API klíč knihovny"
            hint="Stream → tvoje knihovna → API → API Key (ten s právem zápisu, ne read-only). Ukládá se jen v tvém prohlížeči."
          >
            <div className="relative">
              <input
                type={revealKey ? 'text' : 'password'}
                className="input w-full pr-10 font-mono"
                placeholder="••••••••-••••-••••-••••••••••••"
                value={bunny.apiKey}
                onChange={(e) => update('apiKey', e.target.value.trim())}
              />
              <button
                type="button"
                onClick={() => setRevealKey((r) => !r)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-text-muted hover:text-text-primary"
              >
                {revealKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>

          <Field
            label="Collection ID (volitelné)"
            hint="GUID kolekce, do které se mají videa řadit (Stream → Collections → otevři kolekci, GUID je v URL). Prázdné = kořen knihovny."
          >
            <input
              type="text"
              className="input w-full font-mono"
              placeholder="např. 8f1c2d3e-…"
              value={bunny.collectionId}
              onChange={(e) => update('collectionId', normalizeCollectionId(e.target.value))}
            />
          </Field>

          <div className="flex items-center justify-between bg-bg-elev rounded-xl p-4">
            <div>
              <div className="font-medium text-sm">Auto-upload po nahrávání</div>
              <div className="text-xs text-text-secondary mt-0.5">
                Hned po stopnutí se video automaticky pošle na Bunny Stream.
              </div>
            </div>
            <Toggle on={bunny.autoUpload} onChange={(v) => update('autoUpload', v)} />
          </div>

          <div className="bg-bg-elev rounded-xl p-4 mt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-text-secondary" />
                <span className="text-sm font-medium">Test spojení s proxy</span>
              </div>
              <button
                onClick={testConnection}
                disabled={pingState.kind === 'pinging'}
                className="btn-ghost text-xs"
              >
                {pingState.kind === 'pinging' ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Testuji…
                  </>
                ) : (
                  'Otestovat'
                )}
              </button>
            </div>
            {pingState.kind === 'ok' && (
              <div className="mt-3 text-xs flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-success" />
                <div className="text-success">
                  Proxy běží
                  {pingState.data?.stream ? (
                    <> · Stream podporován</>
                  ) : (
                    <span className="text-danger">
                      {' '}
                      · POZOR: proxy ještě neumí Stream, aktualizuj kontejner proxy
                    </span>
                  )}
                </div>
              </div>
            )}
            {pingState.kind === 'fail' && (
              <div className="mt-3 text-xs text-danger flex items-start gap-2">
                <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>Spojení selhalo: {pingState.message}</div>
              </div>
            )}
            <div className="mt-2 text-[10px] text-text-muted meter">
              Proxy: {PROXY_URL}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end mt-6 pt-5 border-t border-bg-border">
          <button onClick={handleSave} className="btn-primary">
            {savedFlash ? (
              <>
                <Check className="w-4 h-4" /> Uloženo
              </>
            ) : (
              <>
                <Save className="w-4 h-4" /> Uložit
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1.5">{hint}</p>}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
        on ? 'bg-accent' : 'bg-bg-border'
      }`}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${
          on ? 'left-[18px]' : 'left-0.5'
        }`}
        style={{ background: on ? '#141416' : '#6C6772' }}
      />
    </button>
  );
}
