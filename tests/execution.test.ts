import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareExecution } from '../src/data/execution.ts';
import type { MarketData } from '../src/data/market.ts';
import { runSimpleBacktest } from '../src/engine/simpleBacktest.ts';

function fixture(): MarketData {
  return { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'fixture', fetchedAt: '2026-01-10T00:00:00Z', priceBasis: 'split-adjusted', version: 'fixture', warnings: [],
    bars: ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].map(date => ({ date, open: 50, high: 50, low: 50, close: 50 })),
    splits: [{ date: '2026-01-05', ratio: 2 }, { date: '2026-01-08', ratio: 3 }], distributions: [] };
}
test('분할수정 가격은 선택 종료일 이후 분할까지 포함해 당시 단위로 복원', () => {
  const original = fixture();
  const prepared = prepareExecution(original, '2026-01-02', '2026-01-06');
  assert.equal(prepared.bars[0].open, 300);
  assert.equal(prepared.bars[1].open, 150);
  assert.equal(prepared.bars[4].open, 50);
  assert.equal(original.bars[0].open, 50);
  const result = runSimpleBacktest(prepared, { start: '2026-01-02', end: '2026-01-06', strategy: { kind: 'hold', capital: 1000 } });
  assert.equal(result.days[0].quantity, 3);
  assert.equal(result.days[1].quantity, 6);
  assert.equal(result.days[2].total, 1000);
});
test('분할 이중 적용 방지·전 기간 자산 보존·원본 불변', () => {
  const original = fixture();
  const result = runSimpleBacktest(prepareExecution(original, '2026-01-02', '2026-01-09'), { start: '2026-01-02', end: '2026-01-09', strategy: { kind: 'hold', capital: 1000 } });
  assert.equal(result.days.at(-1)!.quantity, 18);
  assert(result.days.every(day => day.total === 1000 && day.cost === 900));
  assert.equal(result.metrics.twr, 0);
});
test('사용자 정책: 지급일 유무와 관계없이 모든 분배금 제외, 차단 없음·결과 경고 유지', () => {
  const original = fixture();
  original.distributions = [{ exDate: '2026-01-06', amount: 0.1 }, { exDate: '2026-01-07', amount: 0.2, payDate: '2026-01-09' }];
  const prepared = prepareExecution(original, '2026-01-02', '2026-01-09');
  assert.deepEqual(prepared.distributions, []);
  const result = runSimpleBacktest(prepared, { start: '2026-01-02', end: '2026-01-09', strategy: { kind: 'hold', capital: 1000 } });
  assert(result.days.every(day => day.receivable === 0 && day.dividendIncome === 0));
  assert(result.warnings.some(warning => warning.includes('모든 분배금')));
  assert.equal(original.distributions.length, 2);
});
test('중복 분할과 잘못된 기간은 분배금 제외 정책과 관계없이 거부', () => {
  const original = fixture();
  original.splits.push({ date: '2026-01-05', ratio: 2 });
  assert.throws(() => prepareExecution(original, '2026-01-02', '2026-01-09'), /중복/);
  assert.throws(() => prepareExecution(fixture(), 'invalid', '2026-01-09'), /기간/);
});
