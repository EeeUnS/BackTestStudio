import { useEffect, useRef, useState } from 'react';
import { ColorType, createChart, createSeriesMarkers, LineSeries } from 'lightweight-charts';
import type { TimelineEvent } from '../chart/events.ts';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
interface AssetCurve { days: { date: string; total: number; stock: number; cash: number; lockedCash: number }[] }
export function dateFromTime(time: Time | undefined): string | undefined {
  if (typeof time === 'string') { return time; }
  if (typeof time === 'object') { return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`; }
  return undefined;
}
export function AssetChart({ result, onInspect, accountDate, events }: { result: AssetCurve; onInspect: (date: string) => void; accountDate?: string;events?:TimelineEvent[] }) {
  const [mode, setMode] = useState<'amount' | 'ratio'>('amount');
  const selected = result.days.find(day => day.date === accountDate) ?? result.days.at(-1);
  const percentage = (value: number) => selected && selected.total > 0 ? `${(value / selected.total * 100).toFixed(2)}%` : '산출 불가';
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | undefined>(undefined);
  const anchorRef = useRef<ISeriesApi<'Line'> | undefined>(undefined);
  useEffect(() => {
    if (!container.current) { return; }
    const chart = createChart(container.current, { autoSize: true, height: 240,
      layout: { background: { type: ColorType.Solid, color: '#fff' }, textColor: '#52677b' },
      grid: { vertLines: { color: '#edf0f5' }, horzLines: { color: '#edf0f5' } } });
    chartRef.current = chart;
    for (const [key, color, title] of [['total', '#344cc1', '총자산'], ['stock', '#137660', '주식'], ['cash', '#a26a15', '현금(잠금 포함)']] as const) {
      if (mode === 'ratio' && key === 'total') { continue; }
      const series = chart.addSeries(LineSeries, { color, lineWidth: 2, title, priceLineVisible: false, ...(mode === 'ratio' ? { priceFormat: { type: 'custom' as const, minMove: 0.01, formatter: (value: number) => `${value.toFixed(2)}%` }, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) } : {}) });
      if (key === (mode === 'ratio' ? 'stock' : 'total')) { anchorRef.current = series; }
      series.setData(result.days.map(day => {
        const amount = key === 'cash' ? day.cash + day.lockedCash : day[key];
        return mode === 'ratio' && day.total <= 0 ? { time: day.date } : { time: day.date, value: mode === 'ratio' ? amount / day.total * 100 : amount };
      }));
    }
    const dates=new Set(result.days.map(day=>day.date));
    const eventGroups=new Map<string,TimelineEvent[]>();
    for(const event of events??[]){if(!dates.has(event.date))continue;const group=eventGroups.get(event.date)??[];group.push(event);eventGroups.set(event.date,group);}
    const plugin=anchorRef.current?createSeriesMarkers(anchorRef.current,[...eventGroups].sort(([a],[b])=>a.localeCompare(b)).map(([date,group])=>({time:date,position:'aboveBar' as const,shape:'circle' as const,color:group[0].color,text:[...new Set(group.map(event=>event.label))].join(' · ')}))):undefined;
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove(event => { const date = dateFromTime(event.time); if (event.sourceEvent && date) { onInspect(date); } });
    return () => { plugin?.detach();chartRef.current = undefined; anchorRef.current = undefined; chart.remove(); };
  }, [result, onInspect, mode,events]);
  useEffect(() => {
    const chart = chartRef.current;
    const anchor = anchorRef.current;
    if (!chart || !anchor) { return; }
    const day = result.days.find(item => item.date === accountDate);
    if (!day || (mode === 'ratio' && day.total <= 0)) { chart.clearCrosshairPosition(); return; }
    chart.setCrosshairPosition(mode === 'ratio' ? day.stock / day.total * 100 : day.total, day.date, anchor);
  }, [accountDate, result, mode]);
  return <div className="asset-display">
    <div className="timeframe-buttons" aria-label="자산 차트 표시"><button aria-pressed={mode === 'amount'} onClick={() => { setMode('amount'); }}>금액</button><button aria-pressed={mode === 'ratio'} onClick={() => { setMode('ratio'); }}>비중</button></div>
    <div ref={container} className="asset-chart" data-inspect-date={accountDate} aria-label={mode === 'ratio' ? '주식·현금 비중 곡선' : '총자산·주식·현금 곡선'} />
    <p className="hint asset-composition">{selected?.date ?? '—'} · 주식 {percentage(selected?.stock ?? 0)} · 현금(잠금 포함) {percentage((selected?.cash ?? 0) + (selected?.lockedCash ?? 0))}</p>
    {mode === 'ratio' && <small className="hint">총자산 대비 비중 · 총자산이 0인 날은 비중을 산출하지 않습니다. 현금은 가용 현금과 당일 매도 잠금의 합계입니다.</small>}
  </div>;
}
