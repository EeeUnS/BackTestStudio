import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateHistory } from '../src/model/estimate.ts';
import type { MarketData } from '../src/data/market.ts';
import type { FxData } from '../src/data/fx.ts';
import type { ReferenceData } from '../src/data/reference.ts';
function fixture() {
  const dates: string[] = [];
  for (let day = 0; dates.length < 1100; day++) {
    const date = new Date(Date.UTC(2010, 0, 4 + day));
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) { dates.push(date.toISOString().slice(0, 10)); }
  }
  const index: ReferenceData = { schema: 1, id: 'NDX', unit: 'index-level', source: 'test', sourceUrl: 'https://example.com/index', fetchedAt: '2015-01-01T00:00:00Z', version: 'index-1', points: dates.map((date, i) => ({ date, value: 100 * Math.exp(i * 0.0005 + Math.sin(i / 7) * 0.01) })), missingDates: [], warnings: [] };
  const rates: ReferenceData = { ...index, id: 'DFF', unit: 'annual-percent', version: 'rates-1', points: [] };
  for (let time = Date.parse(dates[0]); time <= Date.parse(dates.at(-1)!); time += 86400000) { rates.points.push({ date: new Date(time).toISOString().slice(0, 10), value: 5 }); }
  const etf: MarketData = { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'test', fetchedAt: '2015-01-01T00:00:00Z', priceBasis: 'split-adjusted', version: 'etf-1', bars: [], splits: [], distributions: [], warnings: [] };
  let close = 100;
  for (let i = 100; i < dates.length; i++) {
    if (i > 100) {
      const days = (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86400000;
      close *= (1 + 3 * (index.points[i].value / index.points[i - 1].value - 1) - 2 * 0.05 * days / 360) * Math.exp(-0.02 * days / 365);
    }
    etf.bars.push({ date: dates[i], open: close, high: close, low: close, close });
  }
  return { etf, index, rates };
}
test('알려진 일별 레버리지·금리·잔여 차이를 복원하고 독립 검증·종가 역산·원본 불변', () => {
  const { etf, index, rates } = fixture();
  const before = JSON.stringify({ etf, index, rates });
  const result = estimateHistory(etf, index, rates);
  assert(Math.abs(result.calibration.annualResidual - 0.02) < 1e-12);
  assert(result.validation.dailyRmse < 1e-12);
  assert(result.validation.maxRelativeError < 1e-10);
  assert.equal(result.points.length, 100);
  assert(result.points.every(point => point.date < result.anchor.date && point.close > 0 && !('open' in point)));
  assert(result.calibration.end < result.validation.start);
  assert.equal(result.points.at(-1)!.date, index.points[99].date);
  const last = index.points[99]; const anchor = index.points[100];
  const days = (Date.parse(anchor.date) - Date.parse(last.date)) / 86400000;
  const gross = (1 + 3 * (anchor.value / last.value - 1) - 2 * 0.05 * days / 360) * Math.exp(-0.02 * days / 365);
  assert(Math.abs(result.points.at(-1)!.close * gross - 100) < 1e-10);
  assert.equal(JSON.stringify({ etf, index, rates }), before);
});
test('미사용 검증 구간의 오차를 보정에 흡수하지 않으며 실제 ETF 가격을 변경하지 않음', () => {
  const { etf, index, rates } = fixture();
  const original = estimateHistory(etf, index, rates);
  for (let i = etf.bars.length - 10; i < etf.bars.length; i++) {
    const factor = 1 + (i - etf.bars.length + 11) * 0.005;
    for (const key of ['open', 'high', 'low', 'close'] as const) { etf.bars[i][key] *= factor; }
  }
  const changed = estimateHistory(etf, index, rates);
  assert.equal(changed.calibration.annualResidual, original.calibration.annualResidual);
  assert.deepEqual(changed.points, original.points);
  assert(changed.validation.dailyRmse > original.validation.dailyRmse);
  assert(changed.validation.terminalRelativeError < -0.04);
});
test('기초지수 불일치·금리 과거 결측·지수 결측·0 이하 일별 경로·짧은 검증은 거부', () => {
  const { etf, index, rates } = fixture();
  assert.throws(() => estimateHistory({ ...etf, symbol: 'SPY' }, index, rates), /기초지수/);
  assert.throws(() => estimateHistory(etf, index, { ...rates, points: rates.points.slice(20) }), /조달금리/);
  assert.throws(() => estimateHistory(etf, { ...index, missingDates: ['2010-01-09'] }, rates), /종가 결측/);
  const crash = structuredClone(index); crash.points[1].value = crash.points[0].value * 0.5;
  assert.throws(() => estimateHistory(etf, crash, rates), /0 이하/);
  assert.throws(() => estimateHistory({ ...etf, bars: etf.bars.slice(0, 300) }, index, rates), /최소 252/);
});
test('SOXL 보정·검증은 PHLX 구간에 한정하고 TIGER는 환율·국내 거래일 없이 생성하지 않음', () => {
  const { etf, index, rates } = fixture();
  const soxl = estimateHistory({ ...etf, symbol: 'SOXL' }, { ...index, id: 'SOX' }, rates);
  assert.equal(soxl.calibration.indexRegimeEnd, '2021-08-24');
  assert(soxl.validation.end <= '2021-08-24');
  assert.throws(() => estimateHistory({ ...etf, symbol: '418660.KS', currency: 'KRW', timeZone: 'Asia/Seoul' }, index, rates), /국내 거래일/);
});


test('TIGER는 이전 미국 종가와 이전 환율을1배 적용하고 같은 날 미래 관측은 사용하지 않음', () => {
  const { etf, index, rates } = fixture();
  const calendar: ReferenceData = { ...index, id: 'KOSPI', version: 'calendar-1', points: index.points.map(point => {
    const date = new Date(point.date);
    do { date.setUTCDate(date.getUTCDate() + 1); } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
    return { date: date.toISOString().slice(0, 10), value: 1000 };
  }) };
  const fx: FxData = { schema: 1, pair: 'USD-KRW', unit: 'KRW-per-USD', source: 'test', sources: ['https://example.com/fx'], fetchedAt: '2015-01-01T00:00:00Z', version: 'fx-1', missingDates: [], warnings: [], observations: rates.points.map(point => ({ date: point.date, rate: point.date < index.points[550].date ? 1000 : 2000 })) };
  const usdPath = [1];
  for (let i = 1; i < index.points.length; i++) {
    const days = (Date.parse(index.points[i].date) - Date.parse(index.points[i - 1].date)) / 86400000;
    usdPath.push(usdPath[i - 1] * (1 + 2 * (index.points[i].value / index.points[i - 1].value - 1) - 0.05 * days / 360));
  }
  const base = calendar.points.map((point, i) => usdPath[i] * fx.observations.findLast(observation => observation.date < point.date)!.rate);
  etf.symbol = '418660.KS'; etf.currency = 'KRW'; etf.timeZone = 'Asia/Seoul'; etf.bars = [];
  let close = 10000;
  for (let i = 100; i < calendar.points.length; i++) {
    if (i > 100) {
      const days = (Date.parse(calendar.points[i].date) - Date.parse(calendar.points[i - 1].date)) / 86400000;
      close *= base[i] / base[i - 1] * Math.exp(-0.02 * days / 365);
    }
    etf.bars.push({ date: calendar.points[i].date, open: close, high: close, low: close, close });
  }
  const original = estimateHistory(etf, index, rates, fx, calendar);
  assert(Math.abs(original.calibration.annualResidual - 0.02) < 1e-12);
  assert(original.validation.dailyRmse < 1e-12);
  const omittedDate = calendar.points[20].date;
  calendar.points = calendar.points.filter(point => point.date !== omittedDate);
  calendar.missingDates = [omittedDate];
  const sparse = estimateHistory(etf, index, rates, fx, calendar);
  assert.deepEqual(sparse.omittedCalendarDates, [omittedDate]);
  assert(!sparse.points.some(point => point.date === omittedDate));
  const date = calendar.points[10].date;
  fx.observations.find(observation => observation.date === date)!.rate *= 2;
  const changed = estimateHistory(etf, index, rates, fx, calendar);
  assert.equal(changed.points.find(point => point.date === date)!.close, original.points.find(point => point.date === date)!.close);
  assert.notEqual(changed.points.find(point => point.date === calendar.points[11].date)!.close, original.points.find(point => point.date === calendar.points[11].date)!.close);
});
