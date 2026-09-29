import { mapSvgRef } from './MapView';
import { MAP_HEIGHT, MAP_WIDTH } from './types';

function serialize(): string {
  const svg = mapSvgRef.current;
  if (!svg) throw new Error('Map is not ready');
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[data-export="exclude"]').forEach((n) => n.remove());
  clone.querySelectorAll('[data-id]').forEach((n) => n.removeAttribute('data-id'));
  clone.removeAttribute('class');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(MAP_WIDTH));
  clone.setAttribute('height', String(MAP_HEIGHT));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(title: string | undefined) {
  return (title ?? 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'map';
}

export function exportSvg(title?: string) {
  download(new Blob([serialize()], { type: 'image/svg+xml' }), `${slug(title)}.svg`);
}

export async function exportPng(title?: string, scale = 2) {
  const url = URL.createObjectURL(new Blob([serialize()], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the map image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = MAP_WIDTH * scale;
    canvas.height = MAP_HEIGHT * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed');
    download(blob, `${slug(title)}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
