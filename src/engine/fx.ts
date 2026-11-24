import { alignFx } from '../data/fx.ts';
import type { FxData } from '../data/fx.ts';
import { cagr, xirr } from './metrics.ts';
import type { CashFlow, Metric } from './metrics.ts';
import type { BacktestResult } from './simpleBacktest.ts';
export interface KrwDay {
  date: string;
  rate: number;
  observationDate: string;
  carriedDays: number;
  total: number;
  stock: number;
  cash: number;
  lockedCash: number;
  deposited: number;
  withdrawn: number;
  contribution: number;
  withdrawal: number;
  profit: number;
  growth: number;
  drawdown: number;
}
export interface KrwResult {
  days: KrwDay[];
  flows: CashFlow[];
  source: string;
  fxVersion: string;
  fetchedAt: string;
  warnings: string[];
  metrics: {
    twr: number;
    mdd: number;
    xirr: Metric;
    cagr: Metric;
    returnOnContributions: number;
  };
}
export function convertToKrw(result: BacktestResult, fx: FxData): KrwResult {
  const aligned = alignFx(result.days.map(day => day.date), fx);
  let deposited = 0, withdrawn = 0, previousTotal = 0, growth = 1, peak = 1, mdd = 0;
  const rates = new Map<string, number>();
  const days = result.days.map((day, index) => {
    const observation = aligned[index];
    const rate = observation.rate;
    rates.set(day.date, rate);
    const contribution = day.contribution * rate;
    const withdrawal = day.withdrawal * rate;
    deposited += contribution;
    withdrawn += withdrawal;
    const total = day.total * rate;
    if (previousTotal > 0) {
      growth *= day.openingBeforeFlow * rate / previousTotal;
    }
    if (day.openingAfterFlow > 0) {
      growth *= day.total / day.openingAfterFlow;
    }
    peak = Math.max(peak, growth);
    const drawdown = growth / peak - 1;
    mdd = Math.min(mdd, drawdown);
    const converted = { ...observation, total, stock: day.stock * rate, cash: day.cash * rate, lockedCash: day.lockedCash * rate,
      deposited, withdrawn, contribution, withdrawal, profit: total + withdrawn - deposited, growth, drawdown };
    if (Object.values(converted).some(value => typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('원화 환산 결과가 유한 범위를 넘었습니다.');
    }
    previousTotal = total;
    return converted;
  });
  const flows = result.flows.map(flow => {
    const rate = rates.get(flow.date);
    if (rate === undefined) {
      throw new Error('외부 입출금의 환율 관측을 찾을 수 없습니다.');
    }
    return { date: flow.date, amount: flow.amount * rate };
  });
  const final = days.at(-1);
  if (!final) {
    throw new Error('환산할 백테스트 결과가 없습니다.');
  }
  const first = flows[0];
  return { days, flows, source: fx.source, fxVersion: fx.version, fetchedAt: fx.fetchedAt, warnings: fx.warnings,
    metrics: { twr: growth - 1, mdd, xirr: xirr([...flows, { date: result.end, amount: final.total }]),
      cagr: flows.length === 1 && first.amount < 0 ? cagr(-first.amount, final.total, result.start, result.end) : { available: false, reason: '추가 입출금이 있어 일반 CAGR을 적용하지 않습니다.' },
      returnOnContributions: final.profit / final.deposited } };
}
