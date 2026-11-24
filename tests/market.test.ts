import { fetchMarketUpdate } from '../server/marketUpdate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMarket } from '../src/data/market.ts';
import type { MarketData } from '../src/data/market.ts';
import { createMarketStore } from '../server/cache.ts';
import { parseYahoo } from '../server/provider.ts';

function fixture(): MarketData {
  return { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'test', fetchedAt: '2026-01-04T00:00:00Z', priceBasis: 'split-adjusted', bars: [{ date: '2026-01-02', open: 100, high: 110, low: 90, close: 105 }], splits: [], distributions: [], warnings: [], version: 'test-v1' };
}
test('가격 데이터: 중복 날짜·OHLC 불일치·비유한 숫자 거부', () => {
  const data = fixture();
  assert.equal(validateMarket(data), data);
  assert.throws(() => validateMarket({ ...data, bars: [...data.bars, ...data.bars] }), /중복/);
  assert.throws(() => validateMarket({ ...data, bars: [{ ...data.bars[0], high: 99 }] }), /대소관계/);
  assert.throws(() => validateMarket({ ...data, bars: [{ ...data.bars[0], close: Infinity }] }), /유한/);
  assert.throws(() => validateMarket({ ...data, bars: [{ ...data.bars[0], date: '2026-02-30' }] }), /날짜/);
});
test('정상 캐시 재사용, 조회 실패 시 기존 파일 보존, 손상 감지', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backtest-cache-'));
  let calls = 0;
  const store = createMarketStore(directory, async () => { calls++; return { ...fixture(), fetchedAt: new Date().toISOString() }; });
  try {
    assert.equal((await store.get('TQQQ')).cache, 'fresh');
    assert.equal((await store.get('TQQQ')).cache, 'cached');
    assert.equal(calls, 1);
    const before = await readFile(join(directory, 'TQQQ.json'), 'utf8');
    const failing = createMarketStore(directory, async () => { throw new Error('HTTP 429'); });
    await assert.rejects(failing.get('TQQQ', true), /429/);
    assert.equal(await readFile(join(directory, 'TQQQ.json'), 'utf8'), before);
    await writeFile(join(directory, 'TQQQ.json'), '{"hash":"invalid","payload":"{}"}');
    await assert.rejects(store.get('TQQQ'), /무결성/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('동일 종목 동시 요청은 한 번만 조회하며 유효하지 않은 응답은 저장하지 않음', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backtest-cache-'));
  let calls = 0;
  const store = createMarketStore(directory, async () => { calls++; return fixture(); });
  try {
    await Promise.all([store.get('TQQQ', true), store.get('TQQQ', true)]);
    assert.equal(calls, 1);
    const before = await readFile(join(directory, 'TQQQ.json'), 'utf8');
    const invalid = createMarketStore(directory, async () => ({ ...fixture(), bars: [] }));
    await assert.rejects(invalid.get('TQQQ', true), /비어/);
    assert.equal((await invalid.get('TQQQ')).stale, true);
    assert.equal(await readFile(join(directory, 'TQQQ.json'), 'utf8'), before);
    assert.equal((await store.get('TQQQ')).cache, 'fresh');
    assert.equal(calls, 2);
    await assert.rejects(store.get('../invalid'), /지원하지/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('공급원 파서: 현지 거래일, 미완성 당일 제외, 결측 경고와 지급일 미확보 유지', () => {
  const payload = { chart: { result: [{ meta: { symbol: 'TQQQ', currency: 'USD', exchangeTimezoneName: 'America/New_York' }, timestamp: [1767364200, 1767623400], indicators: { quote: [{ open: [100, 101], high: [110, 111], low: [90, 91], close: [105, 106], volume: [null, 1000] }] }, events: { dividends: { event: { date: 1767364200, amount: 1 } } } }], error: null } };
  const data = parseYahoo(payload, 'TQQQ', new Date('2026-01-05T23:00:00Z'));
  assert.equal(data.bars.length, 1);
  assert.equal(data.bars[0].date, '2026-01-02');
  assert.equal(data.bars[0].volume, undefined);
  assert.equal(data.distributions[0].payDate, undefined);
  assert(data.warnings.some(item => item.includes('지급일')));
  const result = payload.chart.result[0];
  Object.assign(result.meta, { currentTradingPeriod: { regular: { end: Date.parse('2026-01-05T21:00:00Z') / 1000 } } });
  assert.equal(parseYahoo(payload, 'TQQQ', new Date('2026-01-05T20:59:59Z')).bars.length, 1);
  assert.equal(parseYahoo(payload, 'TQQQ', new Date('2026-01-05T21:00:00Z')).bars.at(-1)?.date, '2026-01-05');
  result.indicators.quote[0].close[1] = 0;
  const incomplete = parseYahoo(payload, 'TQQQ', new Date('2026-01-06T05:00:00Z'));
  assert.equal(incomplete.bars.at(-1)?.date, '2026-01-02');
  assert(incomplete.warnings.some(item => item.startsWith('2026-01-05:')));
  result.indicators.quote[0].close[1] = 106;
  result.meta.symbol = 'QLD';
  assert.throws(() => parseYahoo(payload, 'TQQQ', new Date('2026-01-05T23:00:00Z')), /종목 코드/);
  result.meta.symbol = 'TQQQ';
  result.indicators.quote[0].open = [0, 1];
  assert.throws(() => parseYahoo(payload, 'TQQQ', new Date('2026-01-05T23:00:00Z')), /양의/);
});

test('Pages update merges recent corrections and missed trading dates without duplicate bars', async () => {
  const previous = fixture();
  const last = previous.bars.at(-1)!;
  const incoming = {
    ...previous,
    bars: [{ ...last, volume: 123 }, { ...last, date: '2026-01-07' }, { ...last, date: '2026-01-08' }],
  };
  const provider = async (_symbol: string, since?: string) => {
    assert.ok(since);
    return incoming;
  };
  const updated = await fetchMarketUpdate(previous.symbol, previous, provider);
  assert.equal(updated.bars.length, previous.bars.length + 2);
  assert.equal(updated.bars.find(bar => bar.date === last.date)?.volume, 123);
  assert.equal((await fetchMarketUpdate(previous.symbol, updated, provider)).version, updated.version);
});

test('Pages update reloads full history after a split', async () => {
  const previous = fixture();
  const split = { date: previous.bars.at(-1)!.date, ratio: 2 };
  const rebuilt = { ...previous, splits: [split], version: 'full-history' };
  const calls: (string | undefined)[] = [];
  const output = await fetchMarketUpdate(previous.symbol, previous, async (_symbol, since) => {
    calls.push(since);
    return rebuilt;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], undefined);
  assert.equal(output.version, 'full-history');
});

test('런던 QQQ5는 USD 시가와 종가를 보존하고 공급원 고가·저가 범위를 보정한다', () => {
  const payload = { chart: { result: [{
    meta: { symbol: 'QQQ5.L', currency: 'USD', exchangeTimezoneName: 'Europe/London' },
    timestamp: [Date.parse('2026-01-05T08:00:00Z') / 1000],
    indicators: { quote: [{ open: [0.75], high: [0.8], low: [0.7], close: [0.85], volume: [123] }] },
  }] } };
  const data = parseYahoo(payload, 'QQQ5.L', new Date('2026-01-06T00:00:00Z'));
  assert.equal(data.currency, 'USD');
  assert.deepEqual(data.bars[0], { date: '2026-01-05', open: 0.75, high: 0.85, low: 0.7, close: 0.85, volume: 123 });
  assert(data.warnings.some(warning => warning.includes('고가·저가')));
});
