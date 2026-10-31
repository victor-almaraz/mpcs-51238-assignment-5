'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { satrecs, splitAtAntimeridian, STEP_MS, subPoint, subsolarPoint, sunCos, toMap, trail } from '@/src/landing/orbits.js';
import { useSnapshot } from './live-snapshot';

const ISS_ID = 'celestrak.stations:25544';
const CELL_DEG = 3;

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
}

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
  const panel = cssVar(canvas, '--panel');
  const line = cssVar(canvas, '--line');
  const accent = cssVar(canvas, '--accent');
  const fg = cssVar(canvas, '--fg');
  ctx.fillStyle = panel;
  ctx.fillRect(0, 0, w, h);

  // Night side: a smooth ramp across the terminator, so it never flashes.
  const sun = subsolarPoint(date);
  ctx.fillStyle = '#000';
  const cw = (w / 360) * CELL_DEG;
  const ch = (h / 180) * CELL_DEG;
  for (let lat = 90 - CELL_DEG / 2; lat > -90; lat -= CELL_DEG) {
    for (let lon = -180 + CELL_DEG / 2; lon < 180; lon += CELL_DEG) {
      const c = sunCos(lat, lon, sun);
      const a = Math.min(Math.max(-c * 4 + 0.15, 0), 1) * 0.4;
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      const p = toMap(lat + CELL_DEG / 2, lon - CELL_DEG / 2, w, h);
      ctx.fillRect(p.x, p.y, cw + 0.5, ch + 0.5);
    }
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) { const x = toMap(0, lon, w, h).x; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let lat = -60; lat <= 60; lat += 30) { const y = toMap(lat, 0, w, h).y; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();

  for (const s of sats) {
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.35;
    for (const run of splitAtAntimeridian(trail(s.satrec, date))) {
      ctx.beginPath();
      run.forEach((p, i) => { const m = toMap(p.lat, p.lon, w, h); if (i) ctx.lineTo(m.x, m.y); else ctx.moveTo(m.x, m.y); });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const p = subPoint(s.satrec, date);
    if (!p) continue;
    const m = toMap(p.lat, p.lon, w, h);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(m.x, m.y, s.id === ISS_ID ? 3.5 : 2, 0, Math.PI * 2);
    ctx.fill();
    if (s.id === ISS_ID) {
      ctx.fillStyle = fg;
      ctx.font = `11px ${cssVar(canvas, '--font-mono')}`;
      ctx.fillText('ISS', m.x + 6, m.y - 6);
    }
  }
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
    ? `Map of Earth with the current positions and recent ground tracks of ${sats.length} space station objects, including the ISS. The shaded area is the night side.`
    : 'Map of Earth. Station positions appear when live data arrives.';
  return <canvas ref={canvasRef} role="img" aria-label={label} className="block aspect-[2/1] w-full rounded-md border border-line" />;
}
