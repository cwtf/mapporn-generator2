import { useRef, useState } from 'react';
import { useMapStore } from '../store/mapStore';
import type { ChoroplethLegend, ResolvedStyle } from './colors';
import { MAP_HEIGHT as H, MAP_WIDTH as W, type MapState } from './types';

type Row =
  | { kind: 'title'; text: string }
  | { kind: 'item'; color: string; text: string }
  | { kind: 'gradient'; stops: string[]; min: string; max: string }
  | { kind: 'gap' };

const PAD = 14;
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
const textWidth = (s: string, size: number) => s.length * size * 0.56;
const rowHeight = (r: Row) => (r.kind === 'gradient' ? 42 : r.kind === 'gap' ? 8 : 24);

interface Box {
  x: number;
  y: number;
  scale: number;
}

interface DragState {
  mode: 'move' | 'resize';
  start: DOMPoint;
  from: Box;
}

function toSvgPoint(el: SVGElement, clientX: number, clientY: number): DOMPoint {
  const svg = el.ownerSVGElement ?? (el as SVGSVGElement);
  return new DOMPoint(clientX, clientY).matrixTransform(svg.getScreenCTM()!.inverse());
}

/**
 * The map legend: choropleth classes plus manual entries. Drag it to move, drag the corner
 * grip to resize, double-click to snap back to its corner. Position is stored in map units
 * so it is saved with the chat and appears the same in exports.
 */
export function Legend({ map, style, choro, top, bottom }: { map: MapState; style: ResolvedStyle; choro?: ChoroplethLegend; top: number; bottom: number }) {
  const [live, setLive] = useState<Box | null>(null);
  const drag = useRef<DragState | null>(null);

  const rows: Row[] = [];
  if (choro && (choro.items || choro.gradient)) {
    if (choro.title) rows.push({ kind: 'title', text: choro.title });
    if (choro.gradient) rows.push({ kind: 'gradient', ...choro.gradient });
    for (const it of choro.items ?? []) rows.push({ kind: 'item', color: it.color, text: it.label });
    if (choro.noData) rows.push({ kind: 'item', color: choro.noData, text: 'No data' });
  }
  if (map.legend && (map.legend.items.length || map.legend.title)) {
    if (rows.length) rows.push({ kind: 'gap' });
    if (map.legend.title) rows.push({ kind: 'title', text: map.legend.title });
    for (const it of map.legend.items) rows.push({ kind: 'item', color: it.color, text: it.label });
  }
  if (!rows.length) return null;

  const width =
    Math.max(
      170,
      ...rows.map((r) => (r.kind === 'title' ? textWidth(r.text, 16) + 6 : r.kind === 'item' ? 34 + textWidth(r.text, 14) : r.kind === 'gradient' ? 220 : 0)),
    ) +
    PAD * 2;
  const height = rows.reduce((s, r) => s + rowHeight(r), 0) + PAD * 2 - 4;

  const clamp = (b: Box): Box => {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, b.scale));
    return {
      scale,
      x: Math.min(W - width * scale, Math.max(0, b.x)),
      y: Math.min(H - height * scale, Math.max(0, b.y)),
    };
  };

  const saved = map.legendLayout;
  const scale = saved?.scale ?? 1;
  const pos = map.legendPosition ?? 'bottom-left';
  const corner = {
    x: pos.endsWith('left') ? 28 : W - 28 - width * scale,
    y: pos.startsWith('top') ? top + 8 : bottom - height * scale - 8,
  };
  const box = live ?? clamp({ x: saved?.x ?? corner.x, y: saved?.y ?? corner.y, scale });

  const begin = (mode: DragState['mode']) => (e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, start: toSvgPoint(e.currentTarget, e.clientX, e.clientY), from: box };
  };

  const move = (e: React.PointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const p = toSvgPoint(e.currentTarget, e.clientX, e.clientY);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (d.mode === 'move') {
      setLive(clamp({ ...d.from, x: d.from.x + dx, y: d.from.y + dy }));
    } else {
      // Grow from the top-left corner, following whichever axis moved further.
      const w0 = width * d.from.scale;
      const h0 = height * d.from.scale;
      const factor = Math.max((w0 + dx) / w0, (h0 + dy) / h0);
      setLive(clamp({ ...d.from, scale: d.from.scale * factor }));
    }
  };

  const end = (e: React.PointerEvent<SVGElement>) => {
    if (!drag.current) return;
    e.stopPropagation();
    drag.current = null;
    if (live) {
      const next = { x: Math.round(live.x), y: Math.round(live.y), scale: Math.round(live.scale * 100) / 100 };
      useMapStore.getState().update((m) => {
        m.legendLayout = next;
      });
    }
    setLive(null);
  };

  const reset = (e: React.MouseEvent) => {
    e.stopPropagation();
    useMapStore.getState().update((m) => {
      delete m.legendLayout;
    });
  };

  let cy = PAD;
  return (
    <g
      className={`legend${live ? ' dragging' : ''}`}
      data-legend=""
      transform={`translate(${box.x},${box.y}) scale(${box.scale})`}
      stroke="none"
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={reset}
    >
      <title data-export="exclude">Drag to move · drag the corner to resize · double-click to reset</title>
      <rect x={0} y={0} width={width} height={height} rx={8} fill={style.panel} fillOpacity={0.9} stroke={style.border} strokeOpacity={0.4} vectorEffect="non-scaling-stroke" />
      {rows.map((r, i) => {
        const y = cy;
        cy += rowHeight(r);
        if (r.kind === 'title')
          return (
            <text key={i} x={PAD} y={y + 15} fontSize={16} fontWeight={700} fill={style.textColor}>
              {r.text}
            </text>
          );
        if (r.kind === 'item')
          return (
            <g key={i}>
              <rect x={PAD} y={y + 3} width={24} height={16} rx={2} fill={r.color} stroke={style.border} strokeOpacity={0.5} />
              <text x={PAD + 34} y={y + 16} fontSize={14} fill={style.textColor}>
                {r.text}
              </text>
            </g>
          );
        if (r.kind === 'gradient') {
          const gid = `legend-gradient-${i}`;
          return (
            <g key={i}>
              <defs>
                <linearGradient id={gid}>
                  {r.stops.map((c, j) => (
                    <stop key={j} offset={`${(j / (r.stops.length - 1)) * 100}%`} stopColor={c} />
                  ))}
                </linearGradient>
              </defs>
              <rect x={PAD} y={y + 4} width={220} height={14} fill={`url(#${gid})`} />
              <text x={PAD} y={y + 34} fontSize={13} fill={style.textColor}>
                {r.min}
              </text>
              <text x={PAD + 220} y={y + 34} fontSize={13} textAnchor="end" fill={style.textColor}>
                {r.max}
              </text>
            </g>
          );
        }
        return null;
      })}
      <g className="legend-handle" data-export="exclude" onPointerDown={begin('resize')} transform={`translate(${width},${height}) scale(${1 / box.scale})`}>
        {/* generous invisible hit area, visible grip */}
        <rect x={-22} y={-22} width={26} height={26} fill="transparent" />
        <path d="M-14,-3 L-3,-14 M-9,-3 L-3,-9" stroke={style.textColor} strokeWidth={1.6} strokeLinecap="round" />
      </g>
    </g>
  );
}
