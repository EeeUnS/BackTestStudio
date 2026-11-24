import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareHolding } from '../src/engine/benchmark.ts';
import { runBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData } from '../src/engine/simpleBacktest.ts';

const data: ExecutionData = { version: 'comparison-fixture', splits: [], distributions: [], bars: [
  { date: '2024-01-02', open: 100, high: 100, low: 100, close: 100 },
  { date: '2024-02-01', open: 60, high: 70, low: 60, close: 70 },
  { date: '2024-03-01', open: 80, high: 90, low: 80, close: 90 },
] };
test('동일 실제 납입 일정과 정수주 잔액으로 적립식 기준선 일치', () => {
  const result = runBacktest(data, { start: '2024-01-02', end: '2024-03-01', strategy: { kind: 'dca', contribution: 250, interval: 'monthly' } });
  const comparison = compareHolding(data, result);
  assert(comparison.available);
  assert.equal(comparison.total, result.days.at(-1)!.total);
  assert.equal(comparison.profit, result.days.at(-1)!.profit);
  assert.equal(comparison.quantity, 10);
  assert.equal(comparison.cash, 10);
  assert.deepEqual(comparison.xirr, result.metrics.xirr);
});
test('분할 이후 수량과 원가를 보존하며 입력 결과를 변경하지 않음', () => {
  const splitData = { ...data, splits: [{ date: '2024-02-01', ratio: 2 }] };
  const result = runBacktest(splitData, { start: '2024-01-02', end: '2024-03-01', strategy: { kind: 'hold', capital: 1050 } });
  const before = JSON.stringify(result);
  const comparison = compareHolding(splitData, result);
  assert(comparison.available);
  assert.equal(comparison.quantity, 20);
  assert.equal(comparison.total, 1850);
  assert.equal(comparison.profit, 800);
  assert.equal(JSON.stringify(result), before);
});
test('보유 현금 부족 인출은 다른 현금흐름이나 강제매도로 대신하지 않음', () => {
  const result = runBacktest(data, { start: '2024-01-02', end: '2024-03-01', strategy: { kind: 'hold', capital: 1000 } });
  result.days[1].withdrawal = 50;
  const comparison = compareHolding(data, result);
  assert(!comparison.available);
  assert.match(comparison.reason, /2024-02-01.*동일 인출액/);
  assert.equal(compareHolding({ ...data, bars: data.bars.slice(1) }, result).available, false);
});

test('전략과 보유 수량이 다른 역분할에서 비교 불가만 반환하고 원래 결과 보존', () => {
  const result = runBacktest(data, { start: '2024-01-02', end: '2024-03-01', strategy: { kind: 'hold', capital: 100 } });
  const before = JSON.stringify(result);
  const comparison = compareHolding({ ...data, splits: [{ date: '2024-02-01', ratio: 0.5 }] }, result);
  assert(!comparison.available);
  assert.match(comparison.reason, /단주 정산/);
  assert.equal(JSON.stringify(result), before);
});
