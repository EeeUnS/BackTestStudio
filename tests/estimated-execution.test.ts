import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitBuyPrice, limitSellPrice } from '../src/data/prices.ts';
import type { ExecutionBar } from '../src/data/prices.ts';
import { runBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData } from '../src/engine/simpleBacktest.ts';
import { prepareEstimatedExecution } from '../src/data/execution.ts';
import type { MarketData } from '../src/data/market.ts';
import type { EstimatedHistory } from '../src/model/estimate.ts';
import { createCalculationSession } from '../src/worker/session.ts';
const close = (date: string, value: number): ExecutionBar => ({ kind: 'estimated-close', date, close: value });
const source = (bars: ExecutionBar[]): ExecutionData => ({ version: 'estimate-execution', bars, splits: [], distributions: [] });
const vr = { kind: 'vr' as const, capital: 1000, mode: 'hold' as const, advanced: false, initialStockFraction: 0.9, initialValue: 0, gradient: 10, annualGradientIncrease: 1, band: 0.15, cycleDays: 14, poolUse: 0.5, flowAmount: 250, flowDays: 14, tick: 0.01 };
test('추정 지정가는 종가 조건·종가로만 체결하고 실제 장중 터치와 구분', () => {
  const estimated = close('2026-01-02', 90);
  assert.equal(limitBuyPrice(estimated, 100), 90);
  assert.equal(limitSellPrice(estimated, 100), undefined);
  assert.equal(limitSellPrice({ date: '2026-01-02', open: 95, high: 120, low: 80, close: 90 }, 100), 100);
  assert.equal(limitBuyPrice(close('2026-01-02', 110), 100), undefined);
  assert.equal(limitSellPrice(close('2026-01-02', 110), 100), 110);
});
test('일시불·적립식은 추정 종가 정수주와 실제 흐름으로 평가하며 가상 OHLC를 만들지 않음', () => {
  const data = source([close('2026-01-02', 100), close('2026-02-02', 200)]);
  const hold = runBacktest(data, { start: '2026-01-02', end: '2026-02-02', strategy: { kind: 'hold', capital: 1000 } });
  assert.equal(hold.days.at(-1)!.total, 2000);
  assert.equal(hold.trades[0].price, 100);
  assert(hold.trades.every(trade => trade.estimated));
  const dca = runBacktest(data, { start: '2026-01-02', end: '2026-02-02', strategy: { kind: 'dca', contribution: 1000, interval: 'monthly' } });
  assert.equal(dca.days.at(-1)!.quantity, 15);
  assert.equal(dca.days.at(-1)!.total, 3000);
  assert.equal(dca.days.at(-1)!.deposited, 2000);
  assert.equal(dca.metrics.twr, 1);
  assert(data.bars.every(bar => !('open' in bar)));
});
test('V3 목표 지정가·LOC와 VR 사다리는 추정 종가로만 체결하고 매도금은 잠금', () => {
  const data = source([close('2026-01-02', 100), close('2026-01-05', 120)]);
  const result = runBacktest(data, { start: '2026-01-02', end: '2026-01-05', strategy: { kind: 'infinite', capital: 1000, splits: 4, target: 0.1, reinvestment: 0.5, tick: 0.01 } });
  const sold = result.trades.filter(trade => trade.side === 'SELL');
  assert.equal(sold.length, 1); // Both shares belong to the target order; quarter floor is zero.
  assert(sold.every(trade => trade.price === 120));
  assert.equal(result.days.at(-1)!.lockedCash, 240);
  assert.equal(result.days.at(-1)!.realized, 40);
  const vrResult = runBacktest(source([close('2026-01-02', 100), close('2026-01-05', 200)]), { start: '2026-01-02', end: '2026-01-05', strategy: vr });
  assert(vrResult.trades.some(trade => trade.side === 'SELL'));
  assert(vrResult.trades.filter(trade => trade.side === 'SELL').every(trade => trade.price === 200));
  assert(vrResult.days.at(-1)!.lockedCash > 0);
});
test('추정 종가로 표시하면서 가상 OHLC·거래량을 섞는 입력은 거부', () => {
  const data = source([{ kind: 'estimated-close', date: '2026-01-02', close: 100, open: 50 } as ExecutionBar]);
  assert.throws(() => runBacktest(data, { start: '2026-01-02', end: '2026-01-02', strategy: { kind: 'hold', capital: 1000 } }), /가상 OHLC/);
});
function modelFixture() {
  const data: MarketData = { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'test', fetchedAt: '2026-01-06T00:00:00Z', priceBasis: 'split-adjusted', version: 'actual-1', warnings: [], splits: [{ date: '2026-01-05', ratio: 2 }], distributions: [], bars: ['2026-01-02', '2026-01-05'].map(date => ({ date, open: 100, high: 100, low: 100, close: 100 })) };
  const estimate: EstimatedHistory = { schema: 1, symbol: 'TQQQ', currency: 'USD', priceBasis: 'split-adjusted', model: 'daily-leverage-financing-log-residual-v1', version: 'model-1', fetchedAt: '2026-01-06T00:00:00Z', anchor: { date: '2026-01-02', close: 100 }, points: [{ date: '2025-12-31', close: 90 }], calibration: { start: '2026-01-02', end: '2027-01-02', observations: 252, annualResidual: 0.01, financingLeverage: 2, financingDayBasis: 360, residualDayBasis: 365 }, validation: { start: '2027-01-03', end: '2028-01-03', observations: 252, dailyRmse: 0, dailyBias: 0, annualTrackingError: 0, terminalRelativeError: 0, maxRelativeError: 0 }, inputVersions: { etf: data.version, index: 'index-1', rates: 'rates-1' }, sources: ['https://example.com/model'], warnings: ['test'] };
  return { data, estimate };
}
test('최초 실제1주에 단위를 연결하고 추정→실제 경계·실제 분할에서 자산과 수량 보존', () => {
  const { data, estimate } = modelFixture();
  const prepared = prepareEstimatedExecution(data, estimate);
  assert.deepEqual(prepared.bars[0], { kind: 'estimated-close', date: '2025-12-31', close: 180 });
  const request = { start: '2025-12-31', end: '2026-01-05', strategy: { kind: 'hold' as const, capital: 1000 } };
  const result = runBacktest(prepared, request);
  assert.deepEqual(result.days.map(day => day.quantity), [5, 5, 10]);
  assert.deepEqual(result.days.map(day => day.total), [1000, 1100, 1100]);
  assert.deepEqual(result.days.map(day => Boolean(day.estimated)), [true, false, false]);
  const session = createCalculationSession(); session.load(data, estimate);
  const { comparison, ...sessionResult } = session.run(request).result;
  assert.deepEqual(sessionResult, result);
  assert(comparison?.available);
  assert.equal(comparison.total, result.days.at(-1)!.total);
  assert.throws(() => prepareEstimatedExecution(data, { ...estimate, inputVersions: { ...estimate.inputVersions, etf: 'wrong' } }), /버전/);
});
