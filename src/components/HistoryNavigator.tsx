import { useMemo, useRef } from 'react';
import type { PointerEvent } from 'react';
import { moveRange } from '../chart/data.ts';
export function HistoryNavigator({ data, start, end, onRange }: {
  data: { bars: { date: string; close: number }[] }; start: string; end: string; onRange: (start: string, end: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: string; index: number; start: number; end: number } | undefined>(undefined);
  const maximum = data.bars.length - 1;
  const left = Math.max(0, data.bars.findIndex(bar => bar.date >= start));
  const right = Math.max(left, data.bars.findLastIndex(bar => bar.date <= end));
  const position = (index: number) => maximum > 0 ? index / maximum * 100 : 50;
  const path = useMemo(() => {
    const values = data.bars.map(bar => bar.close);
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    return values.map((value, index) => `${index ? 'L' : 'M'}${maximum > 0 ? index / maximum * 1000 : 500},${85 - (value - min) / span * 65}`).join(' ');
  }, [data, maximum]);
  function setRange(next: { start: number; end: number }) { onRange(data.bars[next.start].date, data.bars[next.end].date); }
  function indexAt(event: PointerEvent) {
    const bounds = container.current!.getBoundingClientRect();
    return Math.max(0, Math.min(maximum, Math.round((event.clientX - bounds.left) / bounds.width * maximum)));
  }
  function keyMove(mode: string, delta: number) {
    if (mode === 'move') { setRange(moveRange(left, right, delta, maximum)); }
    else if (mode === 'start') { setRange({ start: Math.max(0, Math.min(right, left + delta)), end: right }); }
    else { setRange({ start: left, end: Math.max(left, Math.min(maximum, right + delta)) }); }
  }
  return <div className="history-explorer"><div className="history-caption"><strong>전체 이력 탐색</strong><span>{data.bars[0].date} ~ {data.bars.at(-1)!.date}</span></div>
    <div className="history-navigator" ref={container} onPointerDown={event => {
      const target = event.target as HTMLElement;
      const mode = target.closest<HTMLElement>('[data-edge]')?.dataset.edge;
      if (!mode) { return; }
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { mode, index: indexAt(event), start: left, end: right };
    }} onPointerMove={event => {
      const initial = drag.current;
      if (!initial) { return; }
      const delta = indexAt(event) - initial.index;
      if (initial.mode === 'move') { setRange(moveRange(initial.start, initial.end, delta, maximum)); }
      else if (initial.mode === 'start') { setRange({ start: Math.max(0, Math.min(initial.end, initial.start + delta)), end: initial.end }); }
      else { setRange({ start: initial.start, end: Math.min(maximum, Math.max(initial.start, initial.end + delta)) }); }
    }} onPointerUp={event => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-label="전체 이력 종가선"><path d={path} fill="none" stroke="#7188c5" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>
      <div className="history-selection" data-edge="move" role="slider" tabIndex={0} aria-label="선택 영역 이동" aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={left} aria-valuetext={`${start} ~ ${end}`} style={{ left: `${position(left)}%`, right: `${100 - position(right)}%` }} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); keyMove('move', event.key === 'ArrowLeft' ? -1 : 1); } }} />
      {(['start', 'end'] as const).map(edge => <button type="button" key={edge} className="history-handle" data-edge={edge} aria-label={edge === 'start' ? '이력 시작 핸들' : '이력 종료 핸들'} style={{ left: `${position(edge === 'start' ? left : right)}%` }} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); keyMove(edge, event.key === 'ArrowLeft' ? -1 : 1); } }}><span aria-hidden="true">Ⅱ</span></button>)}
    </div><small>양끝 핸들로 기간 조절 · 선택 영역을 끌어 이동 · 방향키 또는 아래 날짜 입력으로도 조절할 수 있습니다.</small>
  </div>;
}
