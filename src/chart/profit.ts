import { splitFactorAfter } from '../data/execution.ts';
import type { MarketData } from '../data/market.ts';
import type { Trade } from '../engine/simpleBacktest.ts';
import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer } from 'lightweight-charts';
export interface ProfitSegment { date: string; sign: number; quantity: number; price: number; cost: number; realized: number; count: number }
export function profitSegments(data: MarketData, groups: Map<string, Trade[]>): ProfitSegment[] {
  const output: ProfitSegment[] = [];
  const factors = new Map<string, number>();
  for (const [date, trades] of groups) {
    const bySign = new Map<number, { quantity: number; amount: number; realized: number; count: number }>();
    for (const trade of trades) {
      if (trade.side !== 'SELL') { continue; }
      const factor = factors.get(trade.date) ?? splitFactorAfter(trade.date, data);
      factors.set(trade.date, factor);
      const sign = Math.sign(trade.realized);
      const group = bySign.get(sign) ?? { quantity: 0, amount: 0, realized: 0, count: 0 };
      group.quantity += trade.quantity * factor;
      group.amount += trade.amount;
      group.realized += trade.realized;
      group.count++;
      bySign.set(sign, group);
    }
    for (const [sign, group] of bySign) {
      output.push({ date, sign, quantity: group.quantity, price: group.amount / group.quantity,
        cost: (group.amount - group.realized) / group.quantity, realized: group.realized, count: group.count });
    }
  }
  return output;
}
export function createProfitPrimitive(chart: IChartApi, candles: ISeriesApi<'Candlestick'>, segments: ProfitSegment[]): ISeriesPrimitive {
  const renderer: IPrimitivePaneRenderer = { draw(target) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      context.lineWidth = 2;
      for (const segment of segments) {
        const coordinate = chart.timeScale().timeToCoordinate(segment.date);
        if (coordinate === null || coordinate < 0 || coordinate > mediaSize.width) { continue; }
        const cost = candles.priceToCoordinate(segment.cost);
        const price = candles.priceToCoordinate(segment.price);
        if (cost === null || price === null) { continue; }
        const x = coordinate + segment.sign * 3;
        context.strokeStyle = segment.sign > 0 ? '#137660' : segment.sign < 0 ? '#b53f4b' : '#52677b';
        context.beginPath();
        context.moveTo(x - 4, cost); context.lineTo(x + 4, cost);
        context.moveTo(x, cost); context.lineTo(x, price);
        context.moveTo(x - 4, price);
        if (segment.sign !== 0) { context.lineTo(x, price + (segment.sign > 0 ? -4 : 4)); }
        context.lineTo(x + 4, price);
        context.stroke();
      }
      context.restore();
    });
  } };
  return { paneViews: () => [{ zOrder: () => 'top', renderer: () => renderer }] };
}
