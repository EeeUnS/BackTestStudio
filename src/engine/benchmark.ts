import { applySplit, buy, createAccount, deposit, valueAccount, withdraw } from './account.ts';
import { openingPrice } from '../data/prices.ts';
import { xirr } from './metrics.ts';
import type { Metric } from './metrics.ts';
import type { BacktestResult, ExecutionData } from './simpleBacktest.ts';

export type HoldingComparison = { available: false; reason: string } | {
  available: true; total: number; profit: number; stock: number; cash: number; quantity: number; xirr: Metric;
};

// A reference for the selected run only: its actual external flows, never strategy sales.
export function compareHolding(data: ExecutionData, result: BacktestResult): HoldingComparison {
  const account = createAccount();
  const flows = new Map<string, { deposit: number; withdrawal: number }>();
  for (const day of result.days) {
    flows.set(day.date, { deposit: day.contribution, withdrawal: day.withdrawal });
  }
  const splits = new Map(data.splits.map(split => [split.date, split.ratio]));
  const bars = data.bars.filter(bar => bar.date >= result.start && bar.date <= result.end);
  if (bars.length !== result.days.length || bars.some((bar, index) => bar.date !== result.days[index].date)) {
    return { available: false, reason: '비교 가격과 전략의 거래일이 일치하지 않습니다.' };
  }
  if (data.distributions.length) {
    return { available: false, reason: '이 비교는 분배금 제외 가격수익 기준에서만 제공합니다.' };
  }
  for (const bar of bars) {
    const ratio = splits.get(bar.date);
    if (ratio !== undefined) {
      if (!Number.isSafeInteger(account.quantity * ratio)) {
        return { available: false, reason: `${bar.date} 단순 보유의 분할 후 단주 정산 자료가 없어 비교를 제공하지 않습니다.` };
      }
      applySplit(account, ratio);
    }
    const flow = flows.get(bar.date)!;
    deposit(account, flow.deposit);
    if (flow.withdrawal > account.cash) {
      return { available: false, reason: `${bar.date} 단순 보유 현금으로 동일 인출액을 지급할 수 없습니다. 강제매도·차입 없이 같은 입출금 비교가 성립하지 않습니다.` };
    }
    withdraw(account, flow.withdrawal);
    if (flow.deposit > 0) { buy(account, openingPrice(bar), account.cash); }
  }
  const final = bars.at(-1);
  if (!final) { return { available: false, reason: '비교 가능한 거래일이 없습니다.' }; }
  const value = valueAccount(account, final.close);
  return { available: true, total: value.total, profit: value.profit, stock: value.stock,
    cash: account.cash, quantity: account.quantity,
    xirr: xirr([...result.flows, { date: result.end, amount: value.total }]) };
}
