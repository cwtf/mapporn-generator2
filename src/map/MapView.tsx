import { geoContains, geoDistance, geoGraticule10, geoInterpolate, geoPath, type GeoPermissibleObjects, type GeoProjection, type GeoStream } from 'd3-geo';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useMapStore } from '../store/mapStore';
import { useTheme } from '../store/theme';
import { Icon } from '../components/Icon';
import { computeChoropleth, makeFormatter, resolveStyle, type ChoroplethLegend, type ResolvedStyle } from './colors';
import { fieldValueAt, renderField, type FieldRender } from './field';
import { geo } from './geodata';
import { outline } from './shapes';
import { Legend } from './Legend';
import { buildProjection, canTurn, isRotatable, normalizeAngle, projectionDef, type Frame } from './projections';
import { MAP_HEIGHT as H, MAP_WIDTH as W, type ClipMode, type MapArea, type MapLine, type MapState, type MapView as View, type MarkerShape } from './types';

export const mapSvgRef: { current: SVGSVGElement | null } = { current: null };

const MAX_ZOOM = 60;
const TURN_STEP = 15;

interface PathItem {
  id: string;
  d: string;
  country?: string;
}

/** Field bands and free-form areas, projected. */
interface Surface {
  bands: { d: string; color: string }[];
  fieldClip: ClipMode;
  fieldOpacity?: number;
  /** `edge` strokes polygons without their seam/pole edges */
  areas: { area: MapArea; d: string; edge?: string }[];
}

interface Hover {
  x: number;
  y: number;
  id?: string;
  value?: string;
  areas?: string[];
}

const clipUrl = (c: ClipMode | undefined) => (c === 'land' || c === 'ocean' ? `url(#clip-${c})` : undefined);

function useGeoVersion() {
  return useSyncExternalStore(
    (fn) => geo.subscribe(fn),
    () => geo.version,
  );
}

function frameFor(map: MapState): Frame {
  const top = map.title ? (map.subtitle ? 128 : 92) : 20;
  const bottom = map.source ? 46 : 20;
  return { x0: 20, y0: top, x1: W - 20, y1: H - bottom };
}

export function MapView() {
  const map = useMapStore((s) => s.map);
  const setView = useMapStore((s) => s.setView);
  const theme = useTheme((s) => s.resolved);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [t, setT] = useState<View>(map.view);
  const [hover, setHover] = useState<Hover>();
  const geoVersion = useGeoVersion();

  useEffect(() => {
    geo.load().then(() => setReady(true), (e) => setError(String(e)));
  }, []);

  const style = useMemo(() => resolveStyle(map.style, theme), [map.style, theme]);
  const frame = useMemo(() => frameFor(map), [map.title, map.subtitle, map.source]); // eslint-disable-line react-hooks/exhaustive-deps
  // Globe-like projections rotate on drag instead of panning.
  const rotatable = isRotatable(map.projection.id);

  const projection = useMemo(
    () => buildProjection(map.projection, frame, map.focus, ready ? geo.get('USA')?.feature : undefined),
    [map.projection, frame, map.focus, ready],
  );
  const path = useMemo(() => geoPath(projection), [projection]);

  // Albers USA clips foreign land to its inset boxes, so it only ever shows the US.
  const visible = useMemo(
    () => (map.projection.id === 'albersUsa' ? ['USA'] : map.visibleCountries),
    [map.projection.id, map.visibleCountries],
  );
  const countryPaths = useMemo<PathItem[]>(() => {
    if (!ready) return [];
    const set = visible ? new Set(visible) : undefined;
    return geo.countries.filter((f) => !set || set.has(f.id)).map((f) => ({ id: f.id, d: path(f) ?? '' }));
  }, [path, ready, visible]);

  const subPaths = useMemo<PathItem[]>(
    () =>
      map.subdivisions.flatMap((c) =>
        (geo.getSubdivisions(c) ?? []).map((f) => ({ id: f.id, country: c, d: path(f) ?? '' })),
      ),
    [path, map.subdivisions, geoVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const sphere = useMemo(() => (projectionDef(map.projection.id).kind === 'composite' ? '' : (path({ type: 'Sphere' }) ?? '')), [path, map.projection.id]);
  const graticule = useMemo(() => (style.graticule ? (path(geoGraticule10()) ?? '') : ''), [path, style.graticule]);

  const choro = useMemo(() => (map.choropleth ? computeChoropleth(map.choropleth, style.land) : undefined), [map.choropleth, style.land]);

  const fills = useMemo(() => {
    const noData = map.choropleth?.noDataColor ?? style.land;
    const out: Record<string, string> = {};
    const fillOf = (id: string) => map.regions[id]?.fill ?? choro?.colorOf(id);
    for (const c of countryPaths) out[c.id] = fillOf(c.id) ?? (choro ? noData : style.land);
    for (const s of subPaths) out[s.id] = fillOf(s.id) ?? map.regions[s.country!]?.fill ?? (choro ? noData : style.land);
    return out;
  }, [countryPaths, subPaths, map.regions, choro, map.choropleth?.noDataColor, style.land]);

  // ---- borderless layers: field + areas ---------------------------------------
  const field = useMemo<FieldRender | undefined>(() => (map.field ? renderField(map.field) : undefined), [map.field]);
  // Bands come from a coarse grid, so a tenth of a map unit is plenty and keeps the SVG light.
  const bandPath = useMemo(() => geoPath(projection).digits(1), [projection]);
  const bandPaths = useMemo(() => field?.bands.map((b) => ({ d: bandPath(b.geometry) ?? '', color: b.color })) ?? [], [field, bandPath]);
  const areaPaths = useMemo(
    () =>
      map.areas.map((area) => {
        const g = area.geometry;
        const polygon = g.type === 'Polygon' || g.type === 'MultiPolygon';
        return { area, d: path(g) ?? '', edge: area.stroke && polygon ? (path(outline(g)) ?? '') : undefined };
      }),
    [map.areas, path],
  );
  const surface = useMemo<Surface | undefined>(
    () =>
      bandPaths.length || areaPaths.length
        ? { bands: bandPaths, fieldClip: map.field?.clip ?? 'none', fieldOpacity: map.field?.opacity, areas: areaPaths }
        : undefined,
    [bandPaths, areaPaths, map.field?.clip, map.field?.opacity],
  );
  const needsLand = !!surface && [surface.bands.length ? surface.fieldClip : 'none', ...surface.areas.map((a) => a.area.clip)].some((c) => c === 'land' || c === 'ocean');
  const landPath = useMemo(() => (needsLand ? countryPaths.map((c) => c.d).join('') : ''), [needsLand, countryPaths]);

  // ---- zoom & pan -----------------------------------------------------------
  const viewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const svg = svgRef.current!;
    mapSvgRef.current = svg;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, MAX_ZOOM])
      .extent([
        [0, 0],
        [W, H],
      ])
      .translateExtent([
        [-W * 0.5, -H * 0.5],
        [W * 1.5, H * 1.5],
      ])
      .on('zoom', (e: D3ZoomEvent<SVGSVGElement, unknown>) => {
        const v = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        setT(v);
        if (e.sourceEvent) {
          clearTimeout(viewTimer.current);
          viewTimer.current = setTimeout(() => setView(v), 250);
        }
      });
    zoomRef.current = z;
    select(svg).call(z).on('dblclick.zoom', null);
    return () => {
      select(svg).on('.zoom', null);
      mapSvgRef.current = null;
    };
  }, [setView]);

  useEffect(() => {
    zoomRef.current?.filter((event: Event) => {
      const press = event.type === 'mousedown' || event.type === 'touchstart';
      // The legend handles its own dragging; rotatable projections rotate instead of panning.
      if (press && (event.target as Element | null)?.closest?.('[data-legend]')) return false;
      if (press && rotatable) return false;
      return (!(event as MouseEvent).ctrlKey || event.type === 'wheel') && !(event as MouseEvent).button;
    });
  }, [rotatable]);

  // Programmatic view changes (agent zoom_to, loading a chat) -> d3-zoom state
  useEffect(() => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    const cur = t;
    const v = map.view;
    if (Math.abs(cur.k - v.k) > 1e-3 || Math.abs(cur.x - v.x) > 0.5 || Math.abs(cur.y - v.y) > 0.5) {
      select(svg).transition().duration(400).call(z.transform, zoomIdentity.translate(v.x, v.y).scale(v.k));
    }
  }, [map.view]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomBy = (factor: number) => {
    const svg = svgRef.current;
    if (svg && zoomRef.current) select(svg).transition().duration(250).call(zoomRef.current.scaleBy, factor);
  };
  const resetZoom = () => {
    const svg = svgRef.current;
    if (svg && zoomRef.current) select(svg).transition().duration(350).call(zoomRef.current.transform, zoomIdentity);
    setView({ k: 1, x: 0, y: 0 });
  };

  // ---- in-plane rotation ------------------------------------------------------
  const angle = map.projection.angle ?? 0;
  const turnable = canTurn(map.projection.id);
  const turnTo = (deg: number) => {
    const next = { ...useMapStore.getState().map.projection, angle: normalizeAngle(deg) || undefined };
    let view: View = { k: 1, x: 0, y: 0 };
    if (t.k !== 1 || t.x || t.y) {
      // Keep whatever is at the centre of the screen there, so a zoomed-in view turns in place.
      view = t;
      const ll = projection.invert?.([(W / 2 - t.x) / t.k, (H / 2 - t.y) / t.k]);
      const q = ll && buildProjection(next, frame, map.focus, geo.get('USA')?.feature)(ll);
      if (q && Number.isFinite(q[0]) && Number.isFinite(q[1])) view = { k: t.k, x: W / 2 - q[0] * t.k, y: H / 2 - q[1] * t.k };
      const svg = svgRef.current;
      if (svg && zoomRef.current) select(svg).call(zoomRef.current.transform, zoomIdentity.translate(view.x, view.y).scale(view.k));
    }
    useMapStore.getState().update((m) => {
      m.projection = next;
      m.view = view;
    });
  };
  // Read the angle from the store so rapid clicks don't act on a stale render.
  const turnBy = (deg: number) => turnTo((useMapStore.getState().map.projection.angle ?? 0) + deg);

  // Globe drag-to-rotate
  const drag = useRef<{ x: number; y: number; rot: [number, number, number]; scale: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!rotatable || e.button !== 0) return;
    const r = projection.rotate();
    drag.current = { x: e.clientX, y: e.clientY, rot: [r[0], r[1], r[2]], scale: W / e.currentTarget.getBoundingClientRect().width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const rafRef = useRef(0);
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d) {
      const degPerPx = (180 / Math.PI / (projection.scale() * t.k)) * d.scale;
      // Undo the map's in-plane angle so dragging follows the pointer on a turned globe.
      const a = (angle * Math.PI) / 180;
      const sx = e.clientX - d.x;
      const sy = e.clientY - d.y;
      const dx = sx * Math.cos(a) + sy * Math.sin(a);
      const dy = sy * Math.cos(a) - sx * Math.sin(a);
      const rot: [number, number, number] = [
        d.rot[0] + dx * degPerPx,
        Math.max(-90, Math.min(90, d.rot[1] - dy * degPerPx)),
        d.rot[2],
      ];
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() =>
        useMapStore.getState().update((m) => {
          m.projection = { ...m.projection, rotate: rot };
        }),
      );
      return;
    }
    const target = e.target as SVGElement;
    const id = target.dataset?.id;
    const next: Hover = { x: 0, y: 0, id };
    const labelled = map.areas.filter((a) => a.label && a.fill !== 'none');
    if ((field || labelled.length) && projection.invert) {
      // Field value and areas under the pointer; clipped layers only count where they are drawn.
      const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(e.currentTarget.getScreenCTM()!.inverse());
      const px: [number, number] = [(q.x - t.x) / t.k, (q.y - t.y) / t.k];
      const ll = projection.invert(px);
      // Off the globe or in the gap of an interrupted projection, invert() still answers; reject it.
      const back = ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1]) ? projection(ll) : null;
      const shown = (clip?: ClipMode) => !clip || clip === 'none' || (clip === 'land') === !!id;
      if (ll && back && Math.hypot(back[0] - px[0], back[1] - px[1]) < 1) {
        const v = field && shown(map.field!.clip) ? fieldValueAt(field, ll[0], ll[1]) : undefined;
        if (v !== undefined) {
          const f = map.field!;
          const text = makeFormatter([field!.min, field!.max], f.format, f.unit)(v);
          next.value = f.title ? `${f.title}: ${text}` : text;
        }
        const inside = labelled.filter((a) => shown(a.clip) && /Polygon/.test(a.geometry.type) && geoContains(a.geometry, ll)).map((a) => a.label!);
        if (inside.length) next.areas = [...new Set(inside)];
      }
    }
    if (next.id || next.value || next.areas) {
      const box = e.currentTarget.parentElement!.getBoundingClientRect();
      setHover({ ...next, x: e.clientX - box.left, y: e.clientY - box.top });
    } else if (hover) setHover(undefined);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  // ---- overlay projection (screen space, includes zoom) ----------------------
  const overlay = useMemo(() => screenSpace(projection, t), [projection, t]);

  const tooltip = hover?.id ? tooltipFor(hover.id, map) : undefined;
  const autoLegends = [choro?.legend, field?.scale.legend].filter((l): l is ChoroplethLegend => !!l);

  return (
    <div className="map-wrap" style={{ background: style.background }}>
      {error && <div className="map-error">Failed to load map data: {error}</div>}
      <svg
        ref={svgRef}
        className={`map-svg${rotatable ? ' rotatable' : ''}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        xmlns="http://www.w3.org/2000/svg"
        fontFamily={style.font}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(undefined)}
      >
        <rect x={0} y={0} width={W} height={H} fill={style.background} />
        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          <BaseLayer
            sphere={sphere}
            graticule={graticule}
            countries={countryPaths}
            subdivisions={subPaths}
            fills={fills}
            style={style}
            subdividedCountries={map.subdivisions}
            surface={surface}
            landPath={landPath}
          />
        </g>
        <Overlay map={map} screen={overlay} style={style} />
        <Chrome map={map} style={style} legends={autoLegends} frame={frame} />
      </svg>
      {hover && (tooltip || hover.value || hover.areas) && (
        <div className="map-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          {tooltip && (
            <>
              <strong>{tooltip.name}</strong> <span className="muted">{hover.id}</span>
              {tooltip.parent && <div className="muted">{tooltip.parent}</div>}
              {tooltip.value && <div>{tooltip.value}</div>}
            </>
          )}
          {hover.areas?.map((a) => (
            <div key={a}>{a}</div>
          ))}
          {hover.value && <div>{hover.value}</div>}
        </div>
      )}
      <div className="map-controls" data-export="exclude">
        {turnable && (
          <div className="zoom-controls">
            <button type="button" title="Rotate counterclockwise" aria-label="Rotate counterclockwise" onClick={() => turnBy(-TURN_STEP)}>
              <Icon name="rotateCcw" />
            </button>
            {angle !== 0 && (
              <button type="button" className="angle" title="Reset rotation" aria-label={`Rotated ${angle}°, reset rotation`} onClick={() => turnTo(0)}>
                {Math.round(angle)}°
              </button>
            )}
            <button type="button" title="Rotate clockwise" aria-label="Rotate clockwise" onClick={() => turnBy(TURN_STEP)}>
              <Icon name="rotateCw" />
            </button>
          </div>
        )}
        <div className="zoom-controls">
          <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.6)}>
            +
          </button>
          <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.6)}>
            −
          </button>
          <button type="button" title="Reset zoom" aria-label="Reset zoom" onClick={resetZoom}>
            <Icon name="fit" />
          </button>
        </div>
      </div>
    </div>
  );
}

function tooltipFor(id: string, map: MapState) {
  const info = geo.get(id);
  if (!info) return undefined;
  const cp = map.choropleth;
  let value: string | undefined;
  if (cp && id in cp.values) value = makeFormatter(Object.values(cp.values), cp.format, cp.unit)(cp.values[id]);
  return { name: info.name, parent: info.country ? geo.get(info.country)?.name : undefined, value };
}

// ---- layers -------------------------------------------------------------------------

interface BaseProps {
  sphere: string;
  graticule: string;
  countries: PathItem[];
  subdivisions: PathItem[];
  fills: Record<string, string>;
  style: ResolvedStyle;
  subdividedCountries: string[];
  surface?: Surface;
  /** All visible land as one path, for clipping fields and areas */
  landPath: string;
}

const BaseLayer = memo(function BaseLayer({ sphere, graticule, countries, subdivisions, fills, style, subdividedCountries, surface, landPath }: BaseProps) {
  const sub = new Set(subdividedCountries);
  return (
    <>
      {sphere && <path d={sphere} fill={style.ocean} />}
      {graticule && <path d={graticule} fill="none" stroke={style.graticuleColor} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />}
      <g stroke={style.border} strokeWidth={style.borderWidth} strokeLinejoin="round">
        {countries.map((c) => (
          <path key={c.id} d={c.d} data-id={sub.has(c.id) ? undefined : c.id} fill={fills[c.id]} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      {subdivisions.length > 0 && (
        <g stroke={style.subdivisionBorder} strokeWidth={style.borderWidth * 0.6} strokeLinejoin="round">
          {subdivisions.map((s) => (
            <path key={s.id} d={s.d} data-id={s.id} fill={fills[s.id]} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      )}
      {surface && <SurfaceLayer surface={surface} landPath={landPath} />}
      {surface ? (
        // Borders go back on top of fields and areas so the map stays readable.
        <g fill="none" pointerEvents="none" strokeLinejoin="round">
          {subdivisions.length > 0 && (
            <g stroke={style.subdivisionBorder} strokeWidth={style.borderWidth * 0.6}>
              {subdivisions.map((s) => (
                <path key={s.id} d={s.d} vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}
          <g stroke={style.border} strokeWidth={style.borderWidth}>
            {countries.map((c) => (
              <path key={c.id} d={c.d} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        </g>
      ) : subdivisions.length > 0 && (
        // Redraw national borders of subdivided countries on top so they stay crisp.
        <g fill="none" stroke={style.border} strokeWidth={style.borderWidth} pointerEvents="none">
          {countries
            .filter((c) => sub.has(c.id))
            .map((c) => (
              <path key={c.id} d={c.d} vectorEffect="non-scaling-stroke" />
            ))}
        </g>
      )}
    </>
  );
});

function SurfaceLayer({ surface, landPath }: { surface: Surface; landPath: string }) {
  const hatchColors = [...new Set(surface.areas.filter((a) => a.area.hatch && a.area.fill && a.area.fill !== 'none').map((a) => a.area.fill!))];
  return (
    <g pointerEvents="none">
      <defs>
        {landPath && (
          <>
            <clipPath id="clip-land">
              <path d={landPath} />
            </clipPath>
            <clipPath id="clip-ocean">
              <path d={`M-1e5,-1e5H1e5V1e5H-1e5Z${landPath}`} clipRule="evenodd" />
            </clipPath>
          </>
        )}
        {hatchColors.map((c, i) => (
          <pattern key={c} id={`hatch-${i}`} patternUnits="userSpaceOnUse" width={7} height={7} patternTransform="rotate(45)">
            <rect width={2.6} height={7} fill={c} />
          </pattern>
        ))}
      </defs>
      {surface.bands.length > 0 && (
        <g clipPath={clipUrl(surface.fieldClip)} opacity={surface.fieldOpacity}>
          {surface.bands.map((b, i) => (
            // A hairline in the band colour hides anti-aliasing seams between stacked bands.
            <path key={i} d={b.d} fill={b.color} stroke={b.color} strokeWidth={0.4} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      )}
      {surface.areas.map(({ area: a, d, edge }) => {
        const fill = !a.fill || a.fill === 'none' ? 'none' : a.hatch ? `url(#hatch-${hatchColors.indexOf(a.fill)})` : a.fill;
        const width = a.strokeWidth ?? 1.5;
        return (
          <g key={a.id} clipPath={clipUrl(a.clip)}>
            {fill !== 'none' && <path d={d} fill={fill} fillOpacity={a.opacity} />}
            {a.stroke && (
              <path
                d={edge ?? d}
                fill="none"
                stroke={a.stroke}
                strokeWidth={width}
                strokeDasharray={a.dashed ? `${width * 4} ${width * 2.5}` : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        );
      })}
    </g>
  );
}

interface ScreenSpace {
  /** project lon/lat to screen (viewBox) coordinates, or null when not visible */
  point: (lon: number, lat: number) => [number, number] | null;
  /** path generator in screen coordinates */
  path: (g: GeoPermissibleObjects) => string | null;
}

/**
 * Wrap the base projection with the current zoom transform. Streaming through the base
 * projection (rather than building a zoomed copy) keeps zooming cheap for heavy
 * polyhedral projections.
 */
function screenSpace(p: GeoProjection, t: View): ScreenSpace {
  const clip = (typeof p.clipAngle === 'function' ? p.clipAngle() : 0) ?? 0;
  const r = typeof p.rotate === 'function' ? p.rotate() : [0, 0, 0]; // Albers USA has no rotate()
  const center: [number, number] = [-r[0], -r[1]];
  const clipRad = clip > 0 ? (clip * Math.PI) / 180 - 0.01 : Infinity;
  const point = (lon: number, lat: number): [number, number] | null => {
    if (geoDistance([lon, lat], center) > clipRad) return null;
    const q = p([lon, lat]);
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
    return [q[0] * t.k + t.x, q[1] * t.k + t.y];
  };
  const path = geoPath({
    stream: (s: GeoStream) =>
      p.stream({
        point: (x, y) => s.point(x * t.k + t.x, y * t.k + t.y),
        lineStart: () => s.lineStart(),
        lineEnd: () => s.lineEnd(),
        polygonStart: () => s.polygonStart(),
        polygonEnd: () => s.polygonEnd(),
        sphere: () => s.sphere?.(),
      }),
  });
  return { point, path: (g) => path(g) };
}

function Overlay({ map, screen, style }: { map: MapState; screen: ScreenSpace; style: ResolvedStyle }) {
  const pt = screen.point;
  const lineColors = [...new Set(map.lines.filter((l) => l.arrow).map((l) => l.color ?? style.textColor))];
  const haloColor = style.panel;

  return (
    <g pointerEvents="none">
      <defs>
        {lineColors.map((c, i) => (
          <marker key={c} id={`arrow-${i}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={c} />
          </marker>
        ))}
      </defs>
      {map.lines.map((l) => (
        <Line key={l.id} line={l} path={screen.path} pt={pt} color={l.color ?? style.textColor} markerIdx={lineColors.indexOf(l.color ?? style.textColor)} halo={haloColor} />
      ))}
      {map.markers.map((m) => {
        const p = pt(m.lon, m.lat);
        if (!p) return null;
        const size = m.size ?? 5;
        return (
          <g key={m.id} transform={`translate(${p[0]},${p[1]})`}>
            <path d={markerPath(m.shape ?? 'circle', size)} fill={m.color ?? '#d62728'} stroke={haloColor} strokeWidth={1.5} />
            {m.label && (
              <text x={size + 5} y={0} dy="0.35em" fontSize={14} fill={style.textColor} stroke={haloColor} strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
                {m.label}
              </text>
            )}
          </g>
        );
      })}
      {map.labels.map((l) => {
        const p = pt(l.lon, l.lat);
        if (!p) return null;
        const lines = l.text.split('\n');
        const size = l.size ?? 14;
        return (
          <text
            key={l.id}
            x={p[0] + (l.dx ?? 0)}
            y={p[1] + (l.dy ?? 0) - ((lines.length - 1) * size * 1.15) / 2}
            fontSize={size}
            fontWeight={l.bold ? 700 : 500}
            fontStyle={l.italic ? 'italic' : undefined}
            textAnchor="middle"
            dominantBaseline="central"
            fill={l.color ?? style.textColor}
            stroke={l.halo === false ? undefined : haloColor}
            strokeWidth={l.halo === false ? undefined : Math.max(2, size / 5)}
            strokeOpacity={0.85}
            paintOrder="stroke"
            strokeLinejoin="round"
          >
            {lines.map((line, i) => (
              <tspan key={i} x={p[0] + (l.dx ?? 0)} dy={i === 0 ? 0 : size * 1.15}>
                {line}
              </tspan>
            ))}
          </text>
        );
      })}
    </g>
  );
}

function Line({
  line,
  path,
  pt,
  color,
  markerIdx,
  halo,
}: {
  line: MapLine;
  path: ScreenSpace['path'];
  pt: (lon: number, lat: number) => [number, number] | null;
  color: string;
  markerIdx: number;
  halo: string;
}) {
  let d = '';
  let mid: [number, number] | null = null;
  const style = line.style ?? 'geodesic';
  if (style === 'geodesic') {
    d = path({ type: 'LineString', coordinates: line.points }) ?? '';
    const a = line.points[Math.floor((line.points.length - 1) / 2)];
    const b = line.points[Math.floor((line.points.length - 1) / 2) + 1];
    mid = pt(...geoInterpolate(a, b)(0.5));
  } else {
    const pts = line.points.map(([lon, lat]) => pt(lon, lat));
    if (pts.some((p) => !p)) return null;
    const ps = pts as [number, number][];
    d = `M${ps[0][0]},${ps[0][1]}`;
    for (let i = 1; i < ps.length; i++) {
      const [x0, y0] = ps[i - 1];
      const [x1, y1] = ps[i];
      if (style === 'arc') {
        const dx = x1 - x0;
        const dy = y1 - y0;
        let nx = -dy * 0.25;
        let ny = dx * 0.25;
        if (ny > 0) (nx = -nx), (ny = -ny); // bow upwards
        const cx = (x0 + x1) / 2 + nx;
        const cy = (y0 + y1) / 2 + ny;
        d += ` Q${cx},${cy} ${x1},${y1}`;
        if (i === Math.ceil(ps.length / 2)) mid = [(x0 + 2 * cx + x1) / 4, (y0 + 2 * cy + y1) / 4];
      } else {
        d += ` L${x1},${y1}`;
        if (i === Math.ceil(ps.length / 2)) mid = [(x0 + x1) / 2, (y0 + y1) / 2];
      }
    }
  }
  if (!d) return null;
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={line.width ?? 2}
        strokeDasharray={line.dashed ? `${(line.width ?? 2) * 3} ${(line.width ?? 2) * 2}` : undefined}
        strokeLinecap="round"
        markerEnd={line.arrow && markerIdx >= 0 ? `url(#arrow-${markerIdx})` : undefined}
      />
      {line.label && mid && (
        <text x={mid[0]} y={mid[1] - 8} fontSize={13} textAnchor="middle" fill={color} stroke={halo} strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
          {line.label}
        </text>
      )}
    </g>
  );
}

function markerPath(shape: MarkerShape, r: number): string {
  switch (shape) {
    case 'square':
      return `M${-r},${-r}h${2 * r}v${2 * r}h${-2 * r}z`;
    case 'diamond':
      return `M0,${-r * 1.3}L${r * 1.3},0L0,${r * 1.3}L${-r * 1.3},0z`;
    case 'triangle':
      return `M0,${-r * 1.3}L${r * 1.15},${r * 0.75}L${-r * 1.15},${r * 0.75}z`;
    case 'star': {
      let d = '';
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 ? r * 0.6 : r * 1.5;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        d += `${i ? 'L' : 'M'}${(Math.cos(a) * rad).toFixed(2)},${(Math.sin(a) * rad).toFixed(2)}`;
      }
      return d + 'z';
    }
    default:
      return `M${r},0A${r},${r} 0 1,1 ${-r},0A${r},${r} 0 1,1 ${r},0z`;
  }
}

// ---- title, legend, source ----------------------------------------------------------

function Chrome({ map, style, legends, frame }: { map: MapState; style: ResolvedStyle; legends: ChoroplethLegend[]; frame: Frame }) {
  // A halo in the background colour keeps text legible when the zoomed map slides under it.
  return (
    <g stroke={style.background} strokeLinejoin="round" paintOrder="stroke">
      {map.title && (
        <text x={W / 2} y={58} textAnchor="middle" fontSize={44} fontWeight={700} fill={style.textColor} strokeWidth={8}>
          {map.title}
        </text>
      )}
      {map.title && map.subtitle && (
        <text x={W / 2} y={98} textAnchor="middle" fontSize={23} fill={style.textColor} fillOpacity={0.8} strokeWidth={6}>
          {map.subtitle}
        </text>
      )}
      {map.source && (
        <text x={24} y={H - 16} fontSize={15} fill={style.textColor} fillOpacity={0.75} strokeWidth={5}>
          {map.source}
        </text>
      )}
      <Legend map={map} style={style} auto={legends} top={frame.y0} bottom={frame.y1} />
    </g>
  );
}
