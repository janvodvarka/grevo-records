import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { MobileNav } from './components/MobileNav';
import { Home } from './components/Home';
import { RecordingView } from './components/RecordingView';
import { Preview } from './components/Preview';
import { Library } from './components/Library';
import { Settings } from './components/Settings';
import { Login } from './components/Login';
import { RecoveryBanner } from './components/RecoveryBanner';
import { currentSession, logout as authLogout, type Session } from './lib/auth';
import { requestPersistentStorage } from './lib/storage';
import type { StoredRecording } from './types';

export type View = 'home' | 'recording' | 'preview' | 'library' | 'settings';

export default function App() {
  const [session, setSession] = useState<Session | null>(() => currentSession());
  const [view, setView] = useState<View>('home');
  const [activeRecording, setActiveRecording] = useState<StoredRecording | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);

  const goPreview = useCallback((rec: StoredRecording) => {
    setActiveRecording(rec);
    setView('preview');
  }, []);

  const refreshLibrary = useCallback(() => setLibraryVersion((v) => v + 1), []);

  const handleLogout = () => {
    authLogout();
    setSession(null);
    setView('home');
  };

  // Ask once for persistent storage so recordings are never auto-evicted
  // when the disk gets tight. Does not change the quota size.
  useEffect(() => {
    requestPersistentStorage();
  }, []);

  // Re-check session if tab regained focus (in case of logout in another tab)
  useEffect(() => {
    const onFocus = () => {
      const s = currentSession();
      setSession(s);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  const chrome = view !== 'recording';

  return (
    <div className="flex h-[100dvh] w-screen bg-bg text-text-primary font-sans antialiased">
      {/* Crash recovery: orphaned chunks from a recording that died with the tab */}
      {chrome && <RecoveryBanner onRecovered={refreshLibrary} />}
      {chrome && (
        <>
          <Sidebar
            view={view}
            session={session}
            onNavigate={(v) => setView(v)}
            onLogout={handleLogout}
          />
          <MobileNav
            view={view}
            session={session}
            onNavigate={(v) => setView(v)}
            onLogout={handleLogout}
          />
        </>
      )}
      <main className="flex-1 min-w-0 relative overflow-hidden">
        {/* On mobile, clear the fixed top/bottom bars (chrome only). */}
        <div
          className={`h-full overflow-auto ${
            chrome ? 'pt-14 pb-16 md:pt-0 md:pb-0' : ''
          }`}
        >
          {view === 'home' && (
            <Home
              onStartRecording={() => setView('recording')}
              onOpenLibrary={() => setView('library')}
              onOpenSettings={() => setView('settings')}
            />
          )}
          {view === 'recording' && (
            <RecordingView
              onFinish={(rec) => {
                refreshLibrary();
                goPreview(rec);
              }}
              onCancel={() => setView('home')}
            />
          )}
          {view === 'preview' && activeRecording && (
            <Preview
              recording={activeRecording}
              onBack={() => setView('library')}
              onNew={() => setView('home')}
              onUpdated={(rec) => {
                setActiveRecording(rec);
                refreshLibrary();
              }}
              onDeleted={() => {
                refreshLibrary();
                setView('library');
              }}
            />
          )}
          {view === 'library' && (
            <Library key={libraryVersion} onOpen={goPreview} />
          )}
          {view === 'settings' && <Settings />}
        </div>
      </main>
    </div>
  );
}
