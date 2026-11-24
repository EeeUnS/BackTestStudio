import assert from 'node:assert/strict';
import test from 'node:test';
import { runBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData } from '../src/engine/simpleBacktest.ts';
import { createCalculationSession } from '../src/worker/session.ts';

function bar(index: number, close: number, open = close) {
  const date = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
  return { date, open, close, high: Math.max(open, close), low: Math.min(open, close) };
}

const strategy = { kind: 'sma200' as const, capital: 1000 };

test('200일선은 선택 기간 전 종가를 포함하고 신호 다음 거래일에만 체결한다', () => {
  const bars = Array.from({ length: 199 }, (_, index) => bar(index, 100));
  bars.push(bar(199, 110), bar(200, 80, 125), bar(201, 100, 70), bar(202, 105, 95));
  const data: ExecutionData = { version: 'sma-test', bars, splits: [], distributions: [] };
  const result = runBacktest(data, { start: bars[198].date, end: bars[202].date, strategy });
  assert.deepEqual(result.trades.map(({ date, side, price, quantity }) => [date, side, price, quantity]), [
    [bars[200].date, 'BUY', 125, 8],
    [bars[201].date, 'SELL', 70, 8],
    [bars[202].date, 'BUY', 95, 5],
  ]);
  assert.equal(result.days[1].cash, 1000);
  assert.equal(runBacktest(data, { start: bars[200].date, end: bars[200].date, strategy }).trades[0]?.side, 'BUY');
});

test('분할로 매도 신호가 발생하지 않고 200개 종가가 없으면 현금을 보유한다', () => {
  const bars = Array.from({ length: 199 }, (_, index) => bar(index, 200));
  bars.push(bar(199, 220), bar(200, 110), bar(201, 110));
  const data: ExecutionData = { version: 'sma-split-test', bars, splits: [{ date: bars[200].date, ratio: 2 }], distributions: [] };
  const result = runBacktest(data, { start: bars[0].date, end: bars[201].date, strategy });
  assert.deepEqual(result.trades.map(({ date, side }) => [date, side]), [[bars[200].date, 'BUY']]);
  const short = runBacktest(data, { start: bars[0].date, end: bars[198].date, strategy });
  assert.equal(short.trades.length, 0);
  assert.equal(short.days.at(-1)?.cash, 1000);
});

test('나스닥100 지수의 신호를 한국 종목의 다음 거래일 시가에 체결한다', () => {
  const nasdaqBars = Array.from({ length: 199 }, (_, index) => bar(index, 100));
  nasdaqBars.push(bar(199, 110), bar(200, 112), bar(201, 80), bar(202, 70));
  const bars = [bar(199, 50), bar(201, 49, 50), bar(204, 47, 40)];
  const session = createCalculationSession();
  session.load({
    schema: 1, symbol: '225040.KS', currency: 'KRW', timeZone: 'Asia/Seoul',
    source: 'test', fetchedAt: '2025-01-01T00:00:00Z', priceBasis: 'split-adjusted',
    bars, splits: [], distributions: [], warnings: [], version: 'etf-test',
  }, undefined, {
    schema: 1, id: 'NDX', unit: 'index-level', source: 'test', sourceUrl: 'https://example.com/ndx',
    fetchedAt: '2025-01-01T00:00:00Z', version: 'ndx-test', missingDates: [], warnings: [],
    points: nasdaqBars.map(({ date, close }) => ({ date, value: close })),
  });
  const { result } = session.run({ start: bars[0].date, end: bars[2].date, strategy: { ...strategy, kind: 'nasdaq-sma200' } });
  assert.deepEqual(result.trades.map(({ date, side, price, quantity }) => [date, side, price, quantity]), [
    [bars[1].date, 'BUY', 50, 20],
    [bars[2].date, 'SELL', 40, 20],
  ]);
});
