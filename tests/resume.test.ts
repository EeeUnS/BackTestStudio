import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBacktestRunner, runBacktest } from '../src/engine/simpleBacktest.ts';
import type { BacktestRequest, ExecutionData } from '../src/engine/simpleBacktest.ts';
const strategies: BacktestRequest['strategy'][] = [
  { kind: 'hold', capital: 10000 },
  ...(['weekly', 'biweekly', 'monthly'] as const).map(interval => ({ kind: 'dca' as const, contribution: 500, interval })),
  { kind: 'infinite', capital: 10000, splits: 4, target: 0.1, reinvestment: 0.5, tick: 0.01 },
  ...(['hold', 'accumulate', 'withdraw'] as const).flatMap(mode => [false, true].map(advanced => ({ kind: 'vr' as const, capital: 10000, mode, advanced, initialStockFraction: 0.9, initialValue: 0, gradient: 10, annualGradientIncrease: 1, band: 0.15, cycleDays: 14, poolUse: 0.5, flowAmount: 250, flowDays: 14, tick: 0.01 }))),
];
function fixture(): ExecutionData {
  const bars: ExecutionData['bars'] = [];
  for (let offset = 0; bars.length < 100; offset++) {
    const date = new Date(Date.UTC(2025, 0, 2 + offset));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) { continue; }
    const price = (100 + Math.sin(bars.length / 3) * 30) / (bars.length >= 30 ? 2 : 1);
    bars.push({ date: date.toISOString().slice(0, 10), open: price, high: price * 1.3, low: price * 0.7, close: price * 1.05 });
  }
  return { version: 'resume-fixture', bars, splits: [{ date: bars[30].date, ratio: 2 }], distributions: [{ exDate: bars[40].date, payDate: bars[55].date, amount: 0.2 }] };
}
test('11개 전략 설정: 종료일 연장·축소·재연장은 독립 실행과 일치하고 새 거래일만 계산', () => {
  const data = fixture();
  for (const strategy of strategies) {
    const request = { start: data.bars[0].date, end: data.bars[10].date, strategy };
    const runner = createBacktestRunner(data, request);
    let maximum = 0;
    let first: ReturnType<typeof runBacktest> | undefined;
    let preserved = '';
    for (const index of [10, 29, 30, 45, 55, 70, 20, 50, 90, 35, 99]) {
      const end = data.bars[index].date;
      const result = runner.run(end);
      assert.deepEqual(result, runBacktest(data, { ...request, end }), JSON.stringify({ strategy, index }));
      maximum = Math.max(maximum, index + 1);
      assert.equal(runner.calculatedDays, maximum);
      if (!first) { first = result; preserved = JSON.stringify(first); }
      assert.equal(JSON.stringify(first), preserved, '연장 실행이 이미 반환한 원장·전략 상태를 변경하면 안 됩니다.');
    }
  }
});
test('축소 결과에는 미래 거래·외부 흐름·낙폭이 섞이지 않고 잘못된 종료일은 상태를 진행하지 않음', () => {
  const data = fixture();
  const request = { start: data.bars[0].date, end: data.bars[99].date, strategy: strategies[5] };
  const runner = createBacktestRunner(data, request);
  const full = runner.run(request.end);
  const end = data.bars[20].date;
  const short = runner.run(end);
  assert(short.days.every(day => day.date <= end));
  assert(short.trades.every(trade => trade.date <= end));
  assert(short.flows.every(flow => flow.date <= end));
  assert.deepEqual(short, runBacktest(data, { ...request, end }));
  assert.throws(() => runner.run('2030-01-01'), /범위/);
  assert.deepEqual(runner.run(request.end), full);
  assert.equal(runner.calculatedDays, 100);
});
test('일별 체결 실패 후 부분 변경된 실행기는 재사용하지 않음', () => {
  const data = fixture();
  data.splits = [{ date: data.bars[1].date, ratio: 0.5 }];
  const request = { start: data.bars[0].date, end: data.bars[0].date, strategy: { kind: 'hold' as const, capital: 300 } };
  const runner = createBacktestRunner(data, request);
  runner.run(request.end);
  assert.throws(() => runner.run(data.bars[1].date), /단주/);
  assert.throws(() => runner.run(request.end), /이전 일별 계산이 실패/);
});
