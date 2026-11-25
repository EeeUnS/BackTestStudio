import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { alignFx, validateFx } from '../src/data/fx.ts';
import type { FxData } from '../src/data/fx.ts';
import { parseFedFx } from '../server/fx.ts';
import { createFxStore } from '../server/fxCache.ts';
import { convertToKrw } from '../src/engine/fx.ts';
import { runBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData } from '../src/engine/simpleBacktest.ts';
import { createCalculationSession } from '../src/worker/session.ts';
function fx(observations = [{ date: '2023-01-02', rate: 1000 }, { date: '2024-01-02', rate: 1200 }]): FxData { return { schema: 1, pair: 'USD-KRW', unit: 'KRW-per-USD', source: 'test', sources: ['https://www.federalreserve.gov/releases/h10/hist/dat00_ko.htm'], fetchedAt: '2026-01-03T00:00:00Z', version: 'fx-fixture', observations, missingDates: [], warnings: ['사후 환산 테스트 자료'] }; }
const bar = (date: string, price: number) => ({ date, open: price, high: price, low: price, close: price });
const data = (bars: ExecutionData['bars']): ExecutionData => ({ version: 'fixture', bars, splits: [], distributions: [] });
function near(actual: number, expected: number) { assert(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`); }
test('연준 신/구형 HTML 표·월 약자 태그·ND와 날짜 경계를 정확히 파싱', () => {
  const html = '<title>South Korean Won</title><table><tr><th>Date</th><th>Rate</th></tr><tr><th id="rowheader1">&nbsp;2-<ABBR>Jan-</ABBR>90&nbsp;</th><td>ND</td></tr><tr><th id="rowheader2">3-JAN-90</th><td>683.5000</td></tr></table>';
  assert.deepEqual(parseFedFx(html, 1900), { observations: [{ date: '1990-01-03', rate: 683.5 }], missingDates: ['1990-01-02'] });
  assert.throws(() => parseFedFx(html.replace('3-JAN-90', '32-JAN-90'), 1900), /날짜/);
  assert.throws(() => parseFedFx(html.replace('3-JAN-90', '2020/01/03'), 1900), /날짜/);
  assert.throws(() => parseFedFx(html.replace('683.5000', '-1'), 1900), /숫자/);
});
test('환율은 같은 날 또는 직전 관측만 적용, 첫 관측 전 미래 값 역보간 금지', () => {
  const aligned = alignFx(['2023-01-02', '2023-01-03', '2024-01-02'], fx());
  assert.deepEqual(aligned.map(item => item.rate), [1000, 1000, 1200]);
  assert.equal(aligned[1].observationDate, '2023-01-02');
  assert.equal(aligned[1].carriedDays, 1);
  assert.throws(() => alignFx(['2022-12-31'], fx()), /첫 환율/);
  assert.throws(() => validateFx({ ...fx(), observations: [{ date: '2023-01-02', rate: 0 }] }), /환율/);
  assert.throws(() => validateFx({ ...fx(), observations: [...fx().observations, ...fx().observations] }), /중복/);
});
test('가격 불변·환율 상승: USD성과0, KRW20%·XIRR/CAGR20%', () => {
  const base = runBacktest(data([bar('2023-01-02', 100), bar('2024-01-02', 100)]), { start: '2023-01-02', end: '2024-01-02', strategy: { kind: 'hold', capital: 1000 } });
  const converted = convertToKrw(base, fx());
  assert.equal(base.days.at(-1)!.total, 1000);
  assert.equal(base.metrics.twr, 0);
  assert.equal(converted.days.at(-1)!.total, 1200000);
  assert.equal(converted.days.at(-1)!.profit, 200000);
  near(converted.metrics.twr, .2);
  assert(converted.metrics.xirr.available);
  near(converted.metrics.xirr.value, .2);
  assert(converted.metrics.cagr.available);
  near(converted.metrics.cagr.value, .2);
});
test('납입일별 환산: 누적 납입금과 환차 손익은 최종 환율 일괄 곱셈과 구분', () => {
  const base = runBacktest(data([bar('2023-01-02', 100), bar('2023-02-01', 100)]), { start: '2023-01-02', end: '2023-02-01', strategy: { kind: 'dca', contribution: 1000, interval: 'monthly' } });
  const converted = convertToKrw(base, fx([{ date: '2023-01-02', rate: 1000 }, { date: '2023-02-01', rate: 2000 }]));
  const final = converted.days.at(-1)!;
  assert.equal(final.deposited, 3000000);
  assert.equal(final.total, 4000000);
  assert.equal(final.profit, 1000000);
  near(converted.metrics.twr, 1);
  assert.equal(converted.metrics.cagr.available, false);
});
test('실제 인출일 환율·입출금 중립 TWR·미지급액은 외부 흐름에서 제외', () => {
  const base = runBacktest(data([bar('2023-01-02', 100), bar('2023-01-16', 100)]), { start: '2023-01-02', end: '2023-01-16', strategy: { kind: 'vr', capital: 1000, mode: 'withdraw', advanced: false, initialStockFraction: .9, initialValue: 0, gradient: 10, annualGradientIncrease: 1, band: .15, cycleDays: 14, poolUse: .25, flowAmount: 250, flowDays: 14, tick: .01 } });
  const converted = convertToKrw(base, fx([{ date: '2023-01-02', rate: 1000 }, { date: '2023-01-16', rate: 1200 }]));
  const final = converted.days.at(-1)!;
  assert.equal(final.withdrawn, 120000);
  assert.equal(final.total, 1080000);
  assert.equal(final.profit, 200000);
  near(converted.metrics.twr, .2);
  assert.equal(converted.flows.filter(flow => flow.amount > 0).reduce((sum, flow) => sum + flow.amount, 0), 120000);
});
test('전액 인출 후 자산0인 기간에는 환율만 바뀌어도 운용 수익이 생기지 않음', () => {
  const base = runBacktest(data([bar('2026-01-02', 100), bar('2026-01-05', 1000), bar('2026-01-06', 1000), bar('2026-01-07', 1000)]), { start: '2026-01-02', end: '2026-01-07', strategy: { kind: 'vr', capital: 1000, mode: 'withdraw', advanced: false, initialStockFraction: .9, initialValue: 0, gradient: 10, annualGradientIncrease: 1, band: .15, cycleDays: 14, poolUse: .25, flowAmount: 1000000, flowDays: 1, tick: .01 } });
  const converted = convertToKrw(base, fx([{ date: '2026-01-02', rate: 1000 }, { date: '2026-01-07', rate: 2000 }]));
  assert.equal(converted.days[2].total, 0);
  assert.equal(converted.days[3].total, 0);
  near(converted.days[2].growth, converted.days[3].growth);
});
test('Worker는 USD원장 캐시를 재사용하고 FX 버전 변경·첫 관측 전·KRW 중복 적용을 구분', () => {
  const session = createCalculationSession();
  const market = { ...data([bar('2023-01-02', 100), bar('2024-01-02', 100)]), schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'fixture', fetchedAt: '2026-01-03T00:00:00Z', priceBasis: 'split-adjusted', warnings: [] };
  session.load(market);
  const request = { start: '2023-01-02', end: '2024-01-02', strategy: { kind: 'hold' as const, capital: 1000 } };
  session.run(request);
  session.loadFx(fx());
  const converted = session.run({ ...request, reportInKrw: true });
  assert.equal(converted.cached, true);
  assert.equal(converted.result.krw!.days.at(-1)!.total, 1200000);
  session.loadFx({ ...fx([{ date: '2023-01-02', rate: 1000 }, { date: '2024-01-02', rate: 1300 }]), version: 'fx-v2' });
  assert.equal(session.run({ ...request, reportInKrw: true }).result.krw!.days.at(-1)!.total, 1300000);
  session.loadFx(fx([{ date: '2024-01-02', rate: 1200 }]));
  assert.match(session.run({ ...request, reportInKrw: true }).result.krwError!, /첫 환율/);
  session.load({ ...market, symbol: '418660.KS', currency: 'KRW', timeZone: 'Asia/Seoul' });
  const native = session.run({ ...request, reportInKrw: true }).result;
  assert.equal(native.krw, undefined);
  assert.match(native.krwError!, /이미 KRW/);
});
test('환율 파일 캐시도 무결성·조회 실패 보존·동일 요청 합치기 적용', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backtest-fx-'));
  let calls = 0;
  try {
    const expired = createFxStore(directory, async () => fx());
    await expired.get('USD-KRW', true);
    const failure = createFxStore(directory, async () => { throw new Error('HTTP 503'); });
    assert.equal((await failure.get('USD-KRW')).stale, true);
    const store = createFxStore(directory, async () => {
      calls++;
      return { ...fx(), fetchedAt: new Date().toISOString() };
    });
    const results = await Promise.all([store.get('USD-KRW'), store.get('USD-KRW')]);
    assert.ok(results.every(result => result.cache === 'fresh'));
    assert.equal(calls, 1);
    assert.equal((await store.get('USD-KRW')).cache, 'cached');
    const before = await readFile(join(directory, 'USD-KRW.json'), 'utf8');
    await assert.rejects(failure.get('USD-KRW', true), /503/);
    assert.equal(await readFile(join(directory, 'USD-KRW.json'), 'utf8'), before);
    await writeFile(join(directory, 'USD-KRW.json'), '{"hash":"bad","payload":"{}"}');
    await assert.rejects(store.get('USD-KRW'), /무결성/);
  }
  finally {
    assert.equal(dirname(directory), tmpdir());
    assert(basename(directory).startsWith('backtest-fx-'));
    await rm(directory, { recursive: true, force: true });
  }
});
