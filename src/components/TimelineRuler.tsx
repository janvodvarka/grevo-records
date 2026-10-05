import { memo, useEffect, useMemo, useState } from 'react';
import { formatDuration } from '../lib/format';

const STEPS = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
const MIN_LABEL_GAP_PX = 70;

/** Smallest "nice" step (seconds) that keeps labels at least ~70 px apart. */
export function rulerStep(pxPerSec: number): number {
  for (const s of STEPS) if (s * pxPerSec >= MIN_LABEL_GAP_PX) return s;
  return STEPS[STEPS.length - 1];
}

interface Props {
  duration: number;
  /** Width of the whole (zoomed) content in px. */
  contentWidth: number;
  /** The horizontally scrolling viewport; labels are rendered only in view. */
  viewport: HTMLDivElement | null;
}

/**
 * Thin tick ruler. Lives inside the scrolling content and positions everything
 * in percent of the full duration, so it scales with the track. It subscribes
 * to the viewport's scroll itself, so scrolling re-renders only this small
 * component and only the labels in view are mounted.
 */
export const TimelineRuler = memo(function TimelineRuler({
  duration,
  contentWidth,
  viewport,
}: Props) {
  const [scroll, setScroll] = useState(0);
  const [viewW, setViewW] = useState(0);

  useEffect(() => {
    if (!viewport) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      setScroll(viewport.scrollLeft);
      setViewW(viewport.clientWidth);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [viewport, contentWidth]);

  const pxPerSec = duration > 0 ? contentWidth / duration : 0;
  const step = pxPerSec > 0 ? rulerStep(pxPerSec) : 1;

  const labels = useMemo(() => {
    if (pxPerSec <= 0) return [];
    const pad = 100;
    const from = Math.max(0, Math.floor((scroll - pad) / pxPerSec / step));
    const to = Math.min(
      Math.floor(duration / step),
      Math.ceil((scroll + viewW + pad) / pxPerSec / step)
    );
    const out: number[] = [];
    // Skip a label that would run past the end of the content.
    for (let i = from; i <= to; i++) {
      if ((duration - i * step) * pxPerSec >= 34 || i === 0) out.push(i * step);
    }
    return out;
  }, [scroll, viewW, pxPerSec, step, duration]);

  if (duration <= 0) return null;

  const majorPct = (step / duration) * 100;
  const minorSec = step / 5;
  const showMinor = minorSec * pxPerSec >= 10;
  const minorPct = (minorSec / duration) * 100;
  const tick = (c: string) => `linear-gradient(to right, ${c} 1px, transparent 1px)`;

  return (
    <div
      className="relative h-5 mb-1 overflow-hidden select-none pointer-events-none"
      style={{
        backgroundImage: showMinor
          ? `${tick('rgba(255,255,255,0.35)')}, ${tick('rgba(255,255,255,0.12)')}`
          : tick('rgba(255,255,255,0.35)'),
        backgroundSize: showMinor
          ? `${majorPct}% 8px, ${minorPct}% 4px`
          : `${majorPct}% 8px`,
        backgroundPosition: 'left bottom',
        backgroundRepeat: 'repeat-x',
      }}
    >
      {labels.map((t) => (
        <span
          key={t}
          className="absolute top-0 pl-1 font-mono text-[10px] leading-3 text-text-muted tabular-nums whitespace-nowrap"
          style={{ left: `${(t / duration) * 100}%` }}
        >
          {formatDuration(t)}
        </span>
      ))}
    </div>
  );
});
