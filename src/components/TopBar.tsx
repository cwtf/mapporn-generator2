import { useEffect, useRef, useState } from 'react';
import { exportPng, exportSvg } from '../map/exportMap';
import { PROJECTION_GROUPS, PROJECTION_IDS, PROJECTIONS } from '../map/projections';
import type { ProjectionId } from '../map/types';
import { useMapStore } from '../store/mapStore';
import { useTheme, type ThemePref } from '../store/theme';
import { Icon } from './Icon';

const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark'];
const THEME_ICON: Record<ThemePref, string> = { system: 'monitor', light: 'sun', dark: 'moon' };

export function TopBar({ onSettings, sidebarOpen, onToggleSidebar }: { onSettings: () => void; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const projection = useMapStore((s) => s.map.projection.id);
  const title = useMapStore((s) => s.map.title);
  const update = useMapStore((s) => s.update);
  const { pref, setPref } = useTheme();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [exportOpen]);

  const setProjection = (id: ProjectionId) =>
    update((m) => {
      m.projection = { id };
      m.view = { k: 1, x: 0, y: 0 };
    });

  const doExport = async (kind: 'png' | 'svg') => {
    setExportOpen(false);
    setExportError(undefined);
    try {
      if (kind === 'png') await exportPng(title);
      else exportSvg(title);
    } catch (e) {
      setExportError((e as Error).message);
    }
  };

  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length];

  return (
    <header className="topbar">
      <div className="brand">
        <Icon name="globe" size={22} />
        <span>
          MapPorn <b>Generator</b>
        </span>
      </div>
      <label className="projection-picker">
        <span className="sr-only">Map projection</span>
        <select value={projection} onChange={(e) => setProjection(e.target.value as ProjectionId)} title="Map projection">
          {PROJECTION_GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {PROJECTION_IDS.filter((id) => PROJECTIONS[id].group === g).map((id) => (
                <option key={id} value={id} title={PROJECTIONS[id].description}>
                  {PROJECTIONS[id].label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="spacer" />
      {exportError && <span className="error-text">{exportError}</span>}
      <div className="menu-anchor" ref={menuRef}>
        <button type="button" className="btn" onClick={() => setExportOpen((o) => !o)} aria-expanded={exportOpen}>
          <Icon name="download" /> <span className="hide-sm">Export</span>
        </button>
        {exportOpen && (
          <div className="menu" role="menu">
            <button type="button" role="menuitem" onClick={() => doExport('png')}>
              PNG image (3200×2000)
            </button>
            <button type="button" role="menuitem" onClick={() => doExport('svg')}>
              SVG vector
            </button>
          </div>
        )}
      </div>
      <button type="button" className="btn icon" onClick={() => setPref(nextTheme)} title={`Theme: ${pref} (click for ${nextTheme})`} aria-label={`Theme: ${pref}`}>
        <Icon name={THEME_ICON[pref]} />
      </button>
      <button type="button" className="btn icon" onClick={onSettings} title="Settings" aria-label="Settings">
        <Icon name="settings" />
      </button>
      <button type="button" className={`btn icon${sidebarOpen ? ' active' : ''}`} onClick={onToggleSidebar} title={sidebarOpen ? 'Hide assistant' : 'Show assistant'} aria-label="Toggle assistant">
        <Icon name="panel" />
      </button>
    </header>
  );
}
