import type { Trade } from './simpleBacktest.ts';

export interface CostLossPoint {
  date: string;
  rate: number;
  amount: number;
  quantity: number;
  cost: number;
  averageCost: number;
  price: number;
  basis: 'close' | 'sell';
  estimated: boolean;
}

export function worseCostLoss(first: CostLossPoint | undefined, next: CostLossPoint | undefined) {
  return next && (!first || next.rate < first.rate) ? next : first;
}

// Reconstruct positions in the engine's execution order. A full exit must not
// erase the loss observed just before the sale; cash is never part of the basis.
export function dailyCostLoss(position: { quantity: number; cost: number }, trades: Trade[], date: string, close: number, estimated: boolean) {
  let quantity = position.quantity;
  let cost = position.cost;
  let worst: CostLossPoint | undefined;
  function observe(price: number, basis: CostLossPoint['basis']) {
    if (quantity <= 0 || cost <= 0) { return; }
    const averageCost = cost / quantity;
    const loss = Math.min(0, quantity * price - cost);
    const amount = Math.abs(loss) <= Number.EPSILON * 64 * Math.max(1, cost, quantity * price) ? 0 : loss;
    const rate = amount / cost;
    worst = worseCostLoss(worst, { date, rate, amount, quantity, cost, averageCost, price, basis, estimated });
  }
  for (const trade of trades) {
    if (trade.side === 'BUY') {
      quantity += trade.quantity;
      cost += trade.amount;
    } else {
      observe(trade.price, 'sell');
      quantity -= trade.quantity;
      cost = quantity === 0 ? 0 : cost - (trade.amount - trade.realized);
    }
  }
  observe(close, 'close');
  return worst;
}
