import { useEffect, useState } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Cloud,
  AlertCircle,
} from 'lucide-react';
import { useDevices } from '../hooks/useDevices';
import { isBunnyConfigured } from '../lib/settings';

interface HomeProps {
  onStartRecording: () => void;
  onOpenLibrary: () => void;
  onOpenSettings?: () => void;
}

const SETTINGS_KEY = 'vr-settings-v3';

interface Persisted {
  cameraDeviceId: string | null;
  micDeviceId: string | null;
  cameraEnabled: boolean;
  micEnabled: boolean;
  micGain: number;
  countdownSeconds: number;
}

function loadSettings(): Persisted {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {} as Persisted;
  }
}

function saveSettings(s: Persisted) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function Home({ onStartRecording, onOpenSettings }: HomeProps) {
  const bunnyOk = isBunnyConfigured();
  const { microphones, cameras } = useDevices();
  const persisted = loadSettings();
  const [micEnabled, setMicEnabled] = useState(persisted.micEnabled ?? true);
  const [cameraEnabled, setCameraEnabled] = useState(persisted.cameraEnabled ?? false);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(persisted.micDeviceId ?? null);
  const [cameraDeviceId, setCameraDeviceId] = useState<string | null>(
    persisted.cameraDeviceId ?? null
  );
  const [micGain, setMicGain] = useState<number>(persisted.micGain ?? 1);
  const [countdownSeconds, setCountdownSeconds] = useState<number>(
    persisted.countdownSeconds ?? 3
  );

  useEffect(() => {
    if (microphones.length && !micDeviceId) setMicDeviceId(microphones[0].deviceId);
  }, [microphones, micDeviceId]);

  useEffect(() => {
    if (cameras.length && !cameraDeviceId) setCameraDeviceId(cameras[0].deviceId);
  }, [cameras, cameraDeviceId]);

  const handleStart = () => {
    saveSettings({
      cameraDeviceId,
      micDeviceId,
      cameraEnabled,
      micEnabled,
      micGain,
      countdownSeconds,
    });
    sessionStorage.setItem(
      'vr-start',
      JSON.stringify({
        micDeviceId: micEnabled ? micDeviceId : null,
        cameraDeviceId: cameraEnabled ? cameraDeviceId : null,
        cameraOverlay: cameraEnabled,
        micGain: micEnabled ? micGain : 1,
        countdownSeconds,
      })
    );
    onStartRecording();
  };

  return (
    <div className="min-h-full p-6 sm:p-10 flex flex-col gap-6 max-w-2xl mx-auto animate-fade-in">
      <header className="pt-2">
        <h1 className="display text-[32px] font-bold tracking-tight leading-tight">
          Nové nahrávání
        </h1>
        <p className="text-text-secondary text-sm mt-2 max-w-[52ch]">
          Po spuštění vybereš obrazovku, okno nebo záložku. Zvuk aplikací
          nahraješ zaškrtnutím „Share audio" v dialogu prohlížeče.
        </p>
      </header>

      {!bunnyOk && (
        <div className="card border-accent/30 bg-accent-subtle p-4 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">Bunny upload není nastavený</div>
            <p className="text-xs text-text-secondary mt-1">
              Bez něj fungují jen lokální nahrávky a stažení do Downloads.
              Sdílení linků klientům vyžaduje Bunny Stream.
            </p>
          </div>
          {onOpenSettings && (
            <button onClick={onOpenSettings} className="btn-secondary shrink-0 text-xs">
              <Cloud className="w-3.5 h-3.5" /> Nastavit
            </button>
          )}
        </div>
      )}

      {/* Vstupy: mikrofon + kamera */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className={`card p-5 transition-opacity ${micEnabled ? '' : 'opacity-55'}`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              {micEnabled ? (
                <Mic className="w-4 h-4 text-accent" />
              ) : (
                <MicOff className="w-4 h-4 text-text-muted" />
              )}
              <span className="font-medium text-sm">Mikrofon</span>
            </div>
            <Toggle on={micEnabled} onChange={setMicEnabled} />
          </div>
          <select
            className="input w-full"
            disabled={!micEnabled}
            value={micDeviceId ?? ''}
            onChange={(e) => setMicDeviceId(e.target.value || null)}
          >
            {microphones.length === 0 && <option value="">Žádný mikrofon</option>}
            {microphones.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-text-secondary">Hlasitost</span>
              <span className="meter text-xs text-text-primary">
                {Math.round(micGain * 100)} %
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={micGain}
              disabled={!micEnabled}
              onChange={(e) => setMicGain(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>
        </div>

        <div className={`card p-5 transition-opacity ${cameraEnabled ? '' : 'opacity-55'}`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              {cameraEnabled ? (
                <Video className="w-4 h-4 text-accent" />
              ) : (
                <VideoOff className="w-4 h-4 text-text-muted" />
              )}
              <span className="font-medium text-sm">Kamera</span>
            </div>
            <Toggle on={cameraEnabled} onChange={setCameraEnabled} />
          </div>
          <select
            className="input w-full"
            disabled={!cameraEnabled}
            value={cameraDeviceId ?? ''}
            onChange={(e) => setCameraDeviceId(e.target.value || null)}
          >
            {cameras.length === 0 && <option value="">Žádná kamera</option>}
            {cameras.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-5 leading-relaxed">
            {cameraEnabled
              ? 'Kruh kamery se vypálí do videa v pravém dolním rohu.'
              : 'Bez kamery se nahraje jen obrazovka a zvuk.'}
          </p>
        </div>
      </section>

      {/* Odpočet */}
      <section className="card px-5 py-4 flex items-center justify-between gap-4">
        <div>
          <div className="font-medium text-sm">Odpočet před startem</div>
          <div className="text-xs text-text-muted mt-0.5">
            Čas na přepnutí do sdíleného okna.
          </div>
        </div>
        <div className="inline-flex bg-bg rounded-lg p-1 border border-bg-border">
          {[0, 3, 5].map((s) => (
            <button
              key={s}
              onClick={() => setCountdownSeconds(s)}
              className={`meter px-3.5 py-1.5 rounded-md text-xs transition-colors ${
                countdownSeconds === s
                  ? 'bg-bg-card text-text-primary border border-bg-border'
                  : 'text-text-secondary hover:text-text-primary border border-transparent'
              }`}
            >
              {s === 0 ? 'Vyp' : `${s} s`}
            </button>
          ))}
        </div>
      </section>

      {/* REC */}
      <div className="flex justify-center pt-4 pb-2">
        <button
          onClick={handleStart}
          className="btn-primary text-base pl-5 pr-7 py-3.5 rounded-xl"
        >
          <span className="w-3 h-3 rounded-full bg-danger shrink-0" aria-hidden />
          Spustit nahrávání
        </button>
      </div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        on ? 'bg-accent' : 'bg-bg-border'
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-[#111013] transition-all ${
          on ? 'left-[18px]' : 'left-0.5'
        }`}
        style={{ background: on ? '#141416' : '#6C6772' }}
      />
    </button>
  );
}
