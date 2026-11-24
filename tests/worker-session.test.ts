import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalculationSession } from '../src/worker/session.ts';
import type { MarketData } from '../src/data/market.ts';
import { prepareExecution } from '../src/data/execution.ts';
import { runSimpleBacktest } from '../src/engine/simpleBacktest.ts';
import { compareHolding } from '../src/engine/benchmark.ts';

function fixture(): MarketData {
  return { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'fixture', fetchedAt: '2026-01-10T00:00:00Z', priceBasis: 'split-adjusted', version: 'fixture', warnings: [],
    bars: ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'].map((date, index) => ({ date, open: 100 + index, high: 100 + index, low: 100 + index, close: 100 + index })),
    splits: [], distributions: [{ exDate: '2026-01-06', amount: 1 }] };
}
const strategy = { kind: 'hold' as const, capital: 1000 };
test('Worker 세션은 데이터를 한 번 적재하고 기간 변경 결과를 독립 재계산과 일치시킴', () => {
  const session = createCalculationSession();
  const data = fixture();
  session.load(data);
  const prepared = prepareExecution(data, data.bars[0].date, data.bars.at(-1)!.date);
  for (const [start, end] of [['2026-01-02', '2026-01-09'], ['2026-01-02', '2026-01-06'], ['2026-01-05', '2026-01-08']]) {
    const request = { start, end, strategy };
    const expected = runSimpleBacktest(prepared, request);
    assert.deepEqual(session.run(request).result, { ...expected, comparison: compareHolding(prepared, expected) });
  }
});
test('동일 요청은 제한 캐시 재사용, 다섯 번째 요청은 오래된 결과 제거', () => {
  const session = createCalculationSession(); session.load(fixture());
  const first = { start: '2026-01-02', end: '2026-01-09', strategy };
  assert.equal(session.run(first).cached, false);
  assert.equal(session.run(first).cached, true);
  for (const capital of [2000, 3000, 4000, 5000]) { session.run({ ...first, strategy: { kind: 'hold', capital } }); }
  assert.equal(session.run(first).cached, false);
});
test('새 데이터 적재는 이전 캐시 제거, 실패한 적재 뒤 이전 종목 계산 금지', () => {
  const session = createCalculationSession();
  const request = { start: '2026-01-02', end: '2026-01-09', strategy };
  assert.throws(() => session.run(request), /먼저 로드/);
  session.load(fixture()); session.run(request);
  session.load({ ...fixture(), version: 'v2' });
  const next = session.run(request);
  assert.equal(next.cached, false);
  assert.match(next.result.dataVersion, /v2/);
  assert.throws(() => session.load({ invalid: true }));
  assert.throws(() => session.run(request), /먼저 로드/);
});
