import { useEffect, useRef, useState } from 'react';
import { MapErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { SettingsDialog } from './components/SettingsDialog';
import { TopBar } from './components/TopBar';
import { MapView } from './map/MapView';
import { useChats } from './store/chatStore';
import { useMapStore } from './store/mapStore';

const WIDTH_KEY = 'mapgen.sidebarWidth';

function readWidth() {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (n >= 300 && n <= 900) return n;
  } catch {
    /* storage unavailable */
  }
  return 420;
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [width, setWidth] = useState(readWidth);
  const dragging = useRef(false);
  const refresh = useChats((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      setWidth(Math.max(300, Math.min(900, window.innerWidth - e.clientX)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove('resizing');
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          /* storage unavailable */
        }
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  return (
    <div className="app" style={{ '--sidebar-w': `${width}px` } as React.CSSProperties}>
      <TopBar onSettings={() => setSettingsOpen(true)} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((o) => !o)} />
      <main className={`main${sidebarOpen ? '' : ' no-sidebar'}`}>
        <section className="map-pane" aria-label="Map">
          <MapErrorBoundary onReset={() => useMapStore.getState().reset()}>
            <MapView />
          </MapErrorBoundary>
        </section>
        {sidebarOpen && (
          <>
            <div
              className="resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize assistant panel"
              onPointerDown={(e) => {
                e.preventDefault();
                dragging.current = true;
                document.body.classList.add('resizing');
              }}
            />
            <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
          </>
        )}
      </main>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
