import { isDate } from '../data/market.ts';
import type { PriceBar } from '../data/market.ts';
import type { Trade } from '../engine/simpleBacktest.ts';
export type Timeframe = 'day' | 'week' | 'month';
export interface ChartBar extends PriceBar { endDate: string }
export function bucketKey(date: string, timeframe: Timeframe) {
  if (!isDate(date)) { throw new Error('차트 날짜 오류입니다.'); }
  if (timeframe === 'day') { return date; }
  if (timeframe === 'month') { return date.slice(0, 7); }
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}
export function aggregateBars(bars: PriceBar[], timeframe: Timeframe): ChartBar[] {
  if (!['day', 'week', 'month'].includes(timeframe)) { throw new Error('봉 주기 오류입니다.'); }
  const grouped: ChartBar[] = [];
  let previousKey = '';
  for (const bar of bars) {
    const key = bucketKey(bar.date, timeframe);
    const current = grouped.at(-1);
    if (!current || key !== previousKey) { grouped.push({ ...bar, endDate: bar.date }); }
    else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.endDate = bar.date;
      // 한 거래일이라도 미제공이면 합계 거래량을 완전한 값으로 표시하지 않는다.
      current.volume = current.volume !== undefined && bar.volume !== undefined ? current.volume + bar.volume : undefined;
    }
    previousKey = key;
  }
  return grouped;
}
export function movingAverage(bars: { date: string; close: number }[], period: number) {
  if (!Number.isInteger(period) || period < 1 || period > 1000) { return []; }
  let sum = 0;
  const values: { time: string; value: number }[] = [];
  for (let index = 0; index < bars.length; index++) {
    sum += bars[index].close;
    if (index >= period) { sum -= bars[index - period].close; }
    if (index >= period - 1) { values.push({ time: bars[index].date, value: sum / period }); }
  }
  return values;
}
export function groupTrades(trades: Trade[], bars: { date: string }[], timeframe: Timeframe) {
  const byBucket = new Map(bars.map(bar => [bucketKey(bar.date, timeframe), bar.date]));
  const groups = new Map<string, Trade[]>();
  for (const trade of trades) {
    const date = byBucket.get(bucketKey(trade.date, timeframe));
    if (!date) { continue; }
    const entries = groups.get(date) ?? [];
    entries.push(trade); groups.set(date, entries);
  }
  return groups;
}
export function moveRange(start: number, end: number, delta: number, maximum: number) {
  const offset = Math.max(-start, Math.min(delta, maximum - end));
  return { start: start + offset, end: end + offset };
}

export interface EstimatedChartBar { kind: 'estimated-close'; date: string; endDate: string; close: number }
export function aggregateEstimated(points: { date: string; close: number }[], timeframe: Timeframe): EstimatedChartBar[] {
  const result: EstimatedChartBar[] = [];
  let previous = '';
  for (const point of points) {
    const key = bucketKey(point.date, timeframe);
    const current = result.at(-1);
    if (!current || key !== previous) { result.push({ ...point, kind: 'estimated-close', endDate: point.date }); }
    else { current.close = point.close; current.endDate = point.date; }
    previous = key;
  }
  return result;
}
