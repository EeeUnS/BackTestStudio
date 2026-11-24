import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer } from 'lightweight-charts';
import type { MarketData } from '../data/market.ts';
import { splitFactorAfter } from '../data/execution.ts';
import type { Snapshot } from '../engine/simpleBacktest.ts';

export interface CostZonePoint { date: string; price: number; cost: number; held: boolean }

export function costZonePoints(data: MarketData, days: Snapshot[], bars: { date: string; endDate: string }[]): CostZonePoint[] {
  let index = 0;
  return bars.map(bar => {
    while (index < days.length && days[index].date < bar.date) { index++; }
    let last: Snapshot | undefined;
    while (index < days.length && days[index].date <= bar.endDate) { last = days[index++]; }
    if (!last || last.quantity <= 0) { return { date: bar.date, price: 0, cost: 0, held: false }; }
    const factor = splitFactorAfter(last.date, data);
    return { date: bar.date, price: last.stock / last.quantity / factor, cost: last.averageCost / factor, held: true };
  });
}

export function createCostZonePrimitive(chart: IChartApi, candles: ISeriesApi<'Candlestick'>, points: CostZonePoint[]): ISeriesPrimitive {
  const renderer: IPrimitivePaneRenderer = { draw(target) {
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      type Coordinate = { x: number; price: number; cost: number };
      const fill = (a: Coordinate, b: Coordinate) => {
        context.fillStyle = a.cost - a.price + b.cost - b.price >= 0 ? '#147d622b' : '#bc41572b';
        context.beginPath();
        context.moveTo(a.x, a.price); context.lineTo(b.x, b.price);
        context.lineTo(b.x, b.cost); context.lineTo(a.x, a.cost);
        context.closePath(); context.fill();
      };
      let previous: Coordinate | undefined;
      for (const point of points) {
        const x = chart.timeScale().timeToCoordinate(point.date);
        const price = point.held ? candles.priceToCoordinate(point.price) : null;
        const cost = point.held ? candles.priceToCoordinate(point.cost) : null;
        if (x === null || price === null || cost === null) { previous = undefined; continue; }
        const current = { x, price, cost };
        if (previous) {
          const first = previous.cost - previous.price;
          const last = cost - price;
          if (first * last < 0) {
            const fraction = first / (first - last);
            const y = previous.price + (price - previous.price) * fraction;
            const crossing = { x: previous.x + (x - previous.x) * fraction, price: y, cost: y };
            fill(previous, crossing); fill(crossing, current);
          } else { fill(previous, current); }
          context.strokeStyle = '#63758a'; context.lineWidth = 1.2; context.setLineDash([5, 4]);
          context.beginPath(); context.moveTo(previous.x, previous.cost); context.lineTo(x, cost); context.stroke();
        }
        previous = current;
      }
      context.restore();
    });
  } };
  return { paneViews: () => [{ zOrder: () => 'bottom', renderer: () => renderer }] };
}
