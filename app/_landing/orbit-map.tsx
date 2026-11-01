'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { satrecs, splitAtAntimeridian, STEP_MS, subPoint, subsolarPoint, terminator, toMap, trail } from '@/src/landing/orbits.js';
import { useSnapshot } from './live-snapshot';

const ISS_ID = 'celestrak.stations:25544';

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
}

/** Night side as a polygon bounded by the terminator and the pole on its night side. */
function nightPath(ctx: CanvasRenderingContext2D, sun: { lat: number; lon: number }, w: number, h: number) {
  ctx.beginPath();
  let pole = -90;
  for (let lon = -180; lon <= 180; lon += 2) {
    const t = terminator(lon, sun);
    pole = t.nightPole;
    const p = toMap(t.lat, lon, w, h);
    if (lon === -180) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  const a = toMap(pole, 180, w, h);
  const b = toMap(pole, -180, w, h);
  ctx.lineTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.closePath();
}

/** Graticule, ground tracks, positions and the ISS label in one ink colour. */
function scene(ctx: CanvasRenderingContext2D, sats: ReturnType<typeof satrecs>, date: Date, w: number, h: number, ink: string, font: string) {
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 3]);
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) { const x = toMap(0, lon, w, h).x; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let lat = -60; lat <= 60; lat += 30) { const y = toMap(lat, 0, w, h).y; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  for (const s of sats) {
    ctx.setLineDash([3, 3]);
    for (const run of splitAtAntimeridian(trail(s.satrec, date))) {
      ctx.beginPath();
      run.forEach((p, i) => { const m = toMap(p.lat, p.lon, w, h); if (i) ctx.lineTo(m.x, m.y); else ctx.moveTo(m.x, m.y); });
      ctx.stroke();
    }
    const p = subPoint(s.satrec, date);
    if (!p) continue;
    const m = toMap(p.lat, p.lon, w, h);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(m.x, m.y, s.id === ISS_ID ? 3.5 : 2, 0, Math.PI * 2);
    ctx.fill();
    if (s.id === ISS_ID) {
      ctx.font = font;
      ctx.fillText('ISS', m.x + 6, m.y - 6);
    }
  }
  ctx.setLineDash([]);
}

/**
 * Day side in the page colour with the scene in the text colour; the night side inverted, filled
 * with the text colour and the scene redrawn in the page colour (doc/ui.md, Landing).
 */
function draw(canvas: HTMLCanvasElement, sats: ReturnType<typeof satrecs>, date: Date) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const paper = cssVar(canvas, '--panel');
  const ink = cssVar(canvas, '--fg');
  const font = `11px ${cssVar(canvas, '--font-mono')}`;
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, w, h);
  scene(ctx, sats, date, w, h, ink, font);
  ctx.save();
  nightPath(ctx, subsolarPoint(date), w, h);
  ctx.clip();
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, w, h);
  scene(ctx, sats, date, w, h, paper, font);
  ctx.restore();
}

/** Space stations on an equirectangular map, updated every 2 s (doc/ui.md, Landing). */
export function OrbitMap() {
  const state = useSnapshot();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [reduced, setReduced] = useState(false);
  const sats = useMemo(
    () => (state.status === 'ready' ? satrecs(state.snapshot.objects.filter((o) => o.group === 'celestrak.stations')) : []),
    [state],
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => draw(canvas, sats, new Date());
    render();
    const ro = new ResizeObserver(render);
    ro.observe(canvas);
    if (reduced) return () => ro.disconnect();
    const id = setInterval(() => { if (document.visibilityState === 'visible') render(); }, STEP_MS);
    return () => { clearInterval(id); ro.disconnect(); };
  }, [sats, reduced]);

  const label = sats.length
    ? `Map of Earth with the current positions and recent ground tracks of ${sats.length} space station objects, including the ISS. The inverted area is the night side.`
    : 'Map of Earth. Station positions appear when live data arrives.';
  return <canvas ref={canvasRef} role="img" aria-label={label} className="block aspect-[2/1] w-full rounded-md border border-line" />;
}
