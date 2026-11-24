import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, createChart, ColorType, createSeriesMarkers, HistogramSeries, LineSeries } from 'lightweight-charts';
import type { PointerEvent } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { MarketData } from '../data/market.ts';
import { instrumentFor } from '../data/market.ts';
import type { BacktestResult } from '../engine/simpleBacktest.ts';
import type { EstimatedHistory } from '../model/estimate.ts';
import { aggregateBars, aggregateEstimated, bucketKey, groupTrades, movingAverage } from '../chart/data.ts';
import type { Timeframe } from '../chart/data.ts';
import { profitSegments } from '../chart/profit.ts';
import { costZonePoints, createCostZonePrimitive } from '../chart/zones.ts';
import { dateFromTime } from './AssetChart.tsx';
import type { TimelineEvent } from '../chart/events.ts';

const defaults = [5, 20, 60, 120, 200].map((period, index) => ({ period, enabled: index < 2, color: ['#ab6913', '#7456b2', '#137660', '#c14f61', '#4267b0'][index] }));
export function PriceChart({ data, result, markers, start, end, onInspect, accountDate, onRange, estimate, events }: {
  data: MarketData; estimate?: EstimatedHistory; result?: BacktestResult; markers: boolean; start: string; end: string; onInspect: (date: string) => void; accountDate?: string; onRange: (start: string, end: string) => void;
  events?:TimelineEvent[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const settings = useRef<HTMLDetailsElement>(null);
  const chart = useRef<IChartApi | undefined>(undefined);
  const series = useRef<ISeriesApi<'Candlestick'> | undefined>(undefined);
  const markerSeries = useRef<ISeriesApi<'Line'> | undefined>(undefined);
  const [timeframe, setTimeframe] = useState<Timeframe>('day');
  const [averages, setAverages] = useState(defaults);
  const [hovered, setHovered] = useState('');
  const [showProfit, setShowProfit] = useState(true);
  const [tradeDate, setTradeDate] = useState('');
  const drag = useRef<{ edge: 'start' | 'end'; start: number; end: number; target: HTMLButtonElement; pointerId: number } | undefined>(undefined);
  const [handles, setHandles] = useState({ start: 22, end: 44 });
  const bars = useMemo(() => [...aggregateEstimated(estimate?.points ?? [], timeframe), ...aggregateBars(data.bars, timeframe)], [data, estimate, timeframe]);
  const daily = useMemo(() => [...(estimate?.points ?? []), ...data.bars], [data, estimate]);
  const groups = useMemo(() => groupTrades(result?.trades ?? [], bars, timeframe), [result, bars, timeframe]);
  const segments = useMemo(() => profitSegments(data, groups), [data, groups]);
  const zones = useMemo(() => costZonePoints(data, result?.days ?? [], bars), [data, result, bars]);
  const holding = result?.days.find(day => day.date === accountDate) ?? result?.days.at(-1);
  const inspectedBar = bars.find(bar => accountDate && bar.date <= accountDate && bar.endDate >= accountDate);
  const displayed = inspectedBar ?? bars.find(bar => bar.date === hovered) ?? bars.at(-1)!;
  const selectedTrades = groups.get(tradeDate) ?? [];
  const money = (value: number) => new Intl.NumberFormat('ko-KR', { style: 'currency', currency: data.currency, maximumFractionDigits: 4 }).format(value);
  useEffect(() => {
    const close = (event: KeyboardEvent | globalThis.PointerEvent) => {
      const element = settings.current;
      if (!element?.open) { return; }
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') { return; }
        element.open = false;
        element.querySelector('summary')?.focus();
      } else if (event.target instanceof Node && !element.contains(event.target)) { element.open = false; }
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); };
  }, []);
  useEffect(() => {
    if (!container.current) { return; }
    const instance = createChart(container.current, {
      autoSize: true, height: 390,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#52677b', attributionLogo: true },
      grid: { vertLines: { color: '#edf0f5' }, horzLines: { color: '#edf0f5' } },
    });
    chart.current = instance;
    const candles = instance.addSeries(CandlestickSeries, { upColor: '#137660', downColor: '#b53f4b', borderVisible: false, wickUpColor: '#137660', wickDownColor: '#b53f4b' });
    series.current = candles;
    candles.setData(bars.map(bar => 'kind' in bar ? { time: bar.date } : { time: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
    const estimatedLine = instance.addSeries(LineSeries, { color: '#a26a15', lineStyle: 2, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: '추정 종가' });
    estimatedLine.setData(bars.map((bar, index) => ({ time: bar.date, value: bar.close, color: 'kind' in bar || (index > 0 && 'kind' in bars[index - 1]) ? '#a26a15' : 'transparent' })));
    markerSeries.current = estimatedLine;
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.25 } });
    const volume = instance.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    volume.setData(bars.flatMap(bar => 'kind' in bar || bar.volume === undefined ? [] : [{ time: bar.date, value: bar.volume, color: bar.close >= bar.open ? '#13766055' : '#b53f4b55' }]));
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    instance.subscribeCrosshairMove(event => {
      const date = dateFromTime(event.time);
      if (event.sourceEvent && date) {
        setHovered(date);
        const bar = bars.find(item => item.date === date);
        onInspect(bar?.endDate ?? date);
      }
    });
    instance.subscribeClick(event => { const date = dateFromTime(event.time); if (date) { setTradeDate(date); } });
    return () => { chart.current = undefined; series.current = undefined; markerSeries.current = undefined; instance.remove(); };
  }, [bars, onInspect]);
  useEffect(() => {
    const first = bars.find(bar => bar.endDate >= start) ?? bars[0];
    const last = bars.findLast(bar => bar.date <= end) ?? bars.at(-1)!;
    if (chart.current && first.date <= last.date) { chart.current.timeScale().setVisibleRange({ from: first.date, to: last.date }); }
    // Selection changes move the handles without resetting the chart viewport.
  }, [bars, onInspect]);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) { return; }
    const lines = averages.filter(average => average.enabled).map(average => {
      const line = instance.addSeries(LineSeries, { color: average.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: `MA ${average.period}` });
      line.setData(movingAverage([...new Map(bars.map(bar => [bucketKey(bar.date, timeframe), bar])).values()], average.period));
      return line;
    });
    return () => { if (chart.current === instance) { for (const line of lines) { instance.removeSeries(line); } } };
  }, [bars, averages]);
  useEffect(() => {
    if (!markerSeries.current) { return; }
    const entries = markers ? [...groups].flatMap(([date, trades]) => (['BUY', 'SELL'] as const).flatMap(side => {
      const count = trades.filter(trade => trade.side === side).length;
      const sales = segments.filter(segment => segment.date === date);
      const cost = sales.reduce((sum, segment) => sum + segment.cost * segment.quantity, 0);
      const realized = sales.reduce((sum, segment) => sum + segment.realized, 0);
      const distance = side === 'SELL' && cost > 0 ? ` · ${realized >= 0 ? '+' : ''}${(realized / cost * 100).toFixed(2)}%` : '';
      return count ? [{ time: date, id: `${date}-${side}`, position: side === 'BUY' ? 'belowBar' as const : 'aboveBar' as const,
        shape: side === 'BUY' ? 'arrowUp' as const : 'arrowDown' as const, color: side === 'BUY' ? '#225ab6' : '#a84b32', text: `${side} ${count}건${distance}` }] : [];
    })) : [];
    const byBucket=new Map(bars.map(bar=>[bucketKey(bar.date,timeframe),bar.date]));
    const eventGroups=new Map<string,TimelineEvent[]>();
    for (const event of events ?? []) {
      if (event.label !== '인출 지급' || event.date < bars[0].date || event.date > bars.at(-1)!.endDate) { continue; }
      const date = byBucket.get(bucketKey(event.date, timeframe));
      if (!date) { continue; }
      const grouped = eventGroups.get(date) ?? [];
      grouped.push(event); eventGroups.set(date, grouped);
    }
    const extras=[...eventGroups].map(([date,group])=>({time:date,id:`event-${date}`,position:'aboveBar' as const,shape:'circle' as const,color:group[0].color,text:[...new Set(group.map(event=>event.label))].join(' · ')}));
    const instance = chart.current;
    const plugin = createSeriesMarkers(markerSeries.current, [...entries,...extras].sort((a,b)=>a.time.localeCompare(b.time)));
    return () => { if (chart.current === instance) { plugin.detach(); } };
  }, [bars, groups, segments, markers,events,timeframe]);
  useEffect(() => {
    const instance = chart.current;
    const candles = series.current;
    if (!instance || !candles) { return; }
    if (!inspectedBar) { instance.clearCrosshairPosition(); return; }
    instance.setCrosshairPosition(inspectedBar.close, inspectedBar.date, candles);
  }, [bars, inspectedBar]);
  useEffect(() => {
    const instance = chart.current;
    const element = container.current;
    if (!instance || !element) { return; }
    const update = () => {
      const width = instance.timeScale().width();
      const first = bars.find(bar => bar.endDate >= start) ?? bars[0];
      const last = bars.findLast(bar => bar.date <= end) ?? bars.at(-1)!;
      const left = instance.timeScale().timeToCoordinate(first.date);
      const right = instance.timeScale().timeToCoordinate(last.date);
      setHandles({ start: Math.max(22, Math.min(width - 22, left ?? 0)), end: Math.max(22, Math.min(width - 22, right ?? width)) });
    };
    instance.timeScale().subscribeVisibleLogicalRangeChange(update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => { observer.disconnect(); instance.timeScale().unsubscribeVisibleLogicalRangeChange(update); };
  }, [bars, start, end]);
  useEffect(() => {
    const instance = chart.current;
    const candles = series.current;
    if (!instance || !candles || !showProfit) { return; }
    const primitive = createCostZonePrimitive(instance, candles, zones);
    candles.attachPrimitive(primitive);
    return () => {
      if (chart.current !== instance) { return; }
      candles.detachPrimitive(primitive);
    };
  }, [bars, zones, showProfit]);
  const startIndex = Math.max(0, daily.findIndex(bar => bar.date >= start));
  const endIndex = Math.max(startIndex, daily.findLastIndex(bar => bar.date <= end));
  function changeEdge(edge: 'start' | 'end', index: number, first = startIndex, last = endIndex) {
    const value = Math.max(0, Math.min(daily.length - 1, index));
    onRange(daily[edge === 'start' ? Math.min(last, value) : first].date,
      daily[edge === 'end' ? Math.max(first, value) : last].date);
  }
  function moveHandle(event: PointerEvent<HTMLDivElement>) {
    const initial = drag.current;
    const instance = chart.current;
    const element = container.current;
    if (!initial || !instance || !element) { return; }
    const position = instance.timeScale().coordinateToLogical(event.clientX - element.getBoundingClientRect().left);
    if (position === null) { return; }
    const bar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(position)))];
    const date = initial.edge === 'start' ? bar.date : bar.endDate;
    changeEdge(initial.edge, daily.findIndex(item => item.date === date), initial.start, initial.end);
  }
  function stopDrag() {
    if (!drag.current) { return; }
    const active = drag.current;
    drag.current = undefined;
    if (active.target.hasPointerCapture(active.pointerId)) { active.target.releasePointerCapture(active.pointerId); }
  }
  return <div className="chart-display">
    <div className="chart-options"><div className="symbol-line"><strong>{data.symbol}</strong><small>{instrumentFor(data.symbol).name} · {data.currency}</small></div><div className="timeframe-buttons" aria-label="봉 주기">{([['day', '일봉'], ['week', '주봉'], ['month', '월봉']] as const).map(([value, label]) => <button key={value} aria-pressed={timeframe === value} onClick={() => { setTimeframe(value); setTradeDate(''); }}>{label}</button>)}</div></div>
    <div className="chart-quote" aria-live="off"><strong>{displayed.date}{displayed.endDate !== displayed.date ? ` ~ ${displayed.endDate}` : ''}</strong>{'kind' in displayed ? <><span>추정 종가 {money(displayed.close)}</span><span>OHLC·거래량 생성 없음</span></> : <><span>시 {money(displayed.open)}</span><span>고 {money(displayed.high)}</span><span>저 {money(displayed.low)}</span><span>종 {money(displayed.close)}</span><span>거래량 {displayed.volume === undefined ? '미제공·미집계' : displayed.volume.toLocaleString()}</span></>}</div>
    {events?.some(event => event.label === '인출 지급') && <p className="phase-chart-event-key">보라 ● 인출 지급 · 세금 내역은 별도 세금 섹션에서 확인하세요.</p>}
    {estimate && <p className="estimate-chart-key">주황 점선: 추정 종가 ~ {estimate.points.at(-1)!.date} · 캔들: 실제 {estimate.anchor.date} 이후 · 연결 경계의 주·월봉은 각 자료 구간을 분리 집계합니다.</p>}
    <div className="chart-workspace">
    <details ref={settings} className="moving-average-settings"><summary>이동평균선 설정 · 현재 봉 주기 기준</summary><div>{averages.map((average, index) => <fieldset key={index}><legend>이평선 {index + 1}</legend><label><input aria-label={`이평선 ${index + 1} 표시`} type="checkbox" checked={average.enabled} onChange={event => { setAverages(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item)); }} />표시</label><label>기간<input aria-label={`이평선 ${index + 1} 기간`} type="number" min="1" max="1000" value={average.period || ''} onChange={event => { setAverages(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, period: Number(event.target.value) } : item)); }} /></label><label>색상<input aria-label={`이평선 ${index + 1} 색상`} type="color" value={average.color} onChange={event => { setAverages(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, color: event.target.value } : item)); }} /></label></fieldset>)}</div><small>기본 5·20·60·120·200 · 주봉20은20주 · 월봉20은20개월 · 기간1~1000, 충분한 봉이 쌓인 시점부터 표시합니다.</small></details>
    <div className="price-range-chart" onPointerMove={moveHandle} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
      <div className="price-chart" data-inspect-date={inspectedBar?.date} ref={container} aria-label="실제 캔들·추정 종가 차트. 확대·이동은 백테스트 기간을 바꾸지 않습니다." />
      {(['start', 'end'] as const).map(edge => <button key={edge} type="button" className="price-range-handle" data-overlap={edge === 'end' && Math.abs(handles.end - handles.start) < 44} style={{ left: handles[edge] }} aria-label={edge === 'start' ? '상세 차트 시작 핸들' : '상세 차트 종료 핸들'} title={`${edge === 'start' ? '시작' : '종료'} ${edge === 'start' ? start : end} · 드래그 또는 방향키`} onPointerDown={event => {
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { edge, start: startIndex, end: endIndex, target: event.currentTarget, pointerId: event.pointerId };
      }} onPointerUp={event => { stopDrag(); if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag} onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); changeEdge(edge, (edge === 'start' ? startIndex : endIndex) + (event.key === 'ArrowLeft' ? -1 : 1)); }
      }}><span>{edge === 'start' ? '시작' : '종료'}</span><i aria-hidden="true" /></button>)}
    </div></div><small className="hint">상단 시작·종료 핸들을 끌거나 방향키로 기간 조절 · 주·월봉 드래그는 해당 봉의 첫/마지막 거래일 · 확대·이동은 계산 기간 유지</small>
    {result && <div className="profit-legend"><label className="check"><input aria-label="평균원가 손익 구간 표시" type="checkbox" checked={showProfit} onChange={event => { setShowProfit(event.target.checked); }} />평단 대비 손익 구간</label>
      {showProfit && <><div className="zone-legend"><span className="zone-profit" aria-hidden="true"></span><span>연녹색 · 평단 대비 수익</span><span className="zone-loss" aria-hidden="true"></span><span>연붉은색 · 평단 대비 손실</span><span>회색 점선 · 보유 평단</span></div><span>조회일 {holding?.date} · 보유 {holding?.quantity.toLocaleString()}주 · 미실현 평가손익 {holding ? money(holding.unrealized) : '—'}</span><small>보유 중 종가와 이동평균 원가 사이의 평가손익 영역입니다. 주·월봉은 해당 봉의 마지막 계좌 상태를 사용하며 봉 사이를 연결합니다. 보유가 없는 봉은 연결하지 않습니다. 가격과 평단은 분할수정 단위입니다. 매도 실현손익은 거래 상세에서 확인하세요.</small></>}
    </div>}

    {result && markers && <div className="candle-trades"><label>봉별 거래 상세<select aria-label="봉별 거래 상세" value={groups.has(tradeDate) ? tradeDate : ''} onChange={event => { setTradeDate(event.target.value); }}><option value="">차트의 봉을 누르거나 거래 봉을 선택하세요</option>{[...groups].map(([date, trades]) => <option key={date} value={date}>{date} · {trades.length}건</option>)}</select></label>
      {selectedTrades.length > 0 && <ul>{selectedTrades.map((trade, index) => <li key={index}><button onClick={() => { onInspect(trade.date); }}>{trade.date} · {trade.side} · {trade.quantity}주 · 체결 {money(trade.price)} · 실현 {money(trade.realized)} · {trade.reason}</button></li>)}</ul>}
      <small>봉 안의 거래를 묶어 표시합니다. 체결가는 당시1주 단위이며 차트는 분할수정 단위입니다.</small>
    </div>}
  </div>;
}
