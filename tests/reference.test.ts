import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDffCsv, parseIndex } from '../server/reference.ts';
import { referenceId, validateReference } from '../src/data/reference.ts';
const now = new Date('2026-01-05T22:00:00Z');
function indexPayload() {
  return { chart: { result: [{ meta: { symbol: '^NDX', currency: 'USD', exchangeTimezoneName: 'America/New_York' }, timestamp: [Date.parse('2026-01-02T21:00:00Z') / 1000, Date.parse('2026-01-05T21:00:00Z') / 1000], indicators: { quote: [{ close: [100, 110] }] } }] } };
}
test('DFF 연율%·주말 일별 값·결측은 별도 보존하고 당일은 제외', () => {
  const data = parseDffCsv('observation_date,DFF\n2026-01-01,3.88\n2026-01-02,.\n2026-01-03,3.88\n2026-01-04,3.88\n2026-01-05,3.88\n', now);
  assert.equal(data.unit, 'annual-percent');
  assert.deepEqual(data.points, [{ date: '2026-01-01', value: 3.88 }, { date: '2026-01-03', value: 3.88 }, { date: '2026-01-04', value: 3.88 }]);
  assert.deepEqual(data.missingDates, ['2026-01-02']);
  assert.equal(data.version, parseDffCsv('observation_date,DFF\n2026-01-01,3.88\n2026-01-02,.\n2026-01-03,3.88\n2026-01-04,3.88\n', now).version);
});
test('DFF 헤더·날짜·중복·비유한 값·임의 문자열은 거부하고 실제 0금리는 보존', () => {
  for (const text of ['DATE,DFF\n2026-01-01,1', 'observation_date,DFF\n2026-02-30,1', 'observation_date,DFF\n2026-01-01,NaN', 'observation_date,DFF\n2026-01-01,1x', 'observation_date,DFF\n2026-01-01,1\n2026-01-01,2']) {
    assert.throws(() => parseDffCsv(text, now));
  }
  assert.equal(parseDffCsv('observation_date,DFF\n2026-01-01,0', now).points[0].value, 0);
});
test('지수는 종가만 보존하고 미완성 당일·지수 식별자·배열 길이를 검증', () => {
  const data = parseIndex(indexPayload(), 'NDX', now);
  assert.deepEqual(data.points, [{ date: '2026-01-02', value: 100 }]);
  assert.equal('open' in data.points[0], false);
  assert.throws(() => parseIndex(indexPayload(), 'SP500', now), /식별자/);
  const bad = indexPayload(); bad.chart.result[0].indicators.quote[0].close.pop();
  assert.throws(() => parseIndex(bad, 'NDX', now), /길이/);
});
test('지수 결측은 값 생성 없이 날짜를 남기고 SOX는 지수 변경 경고 보존', () => {
  const payload = indexPayload();
  const quote = payload.chart.result[0].indicators.quote[0] as { close: (number | null)[] };
  quote.close[0] = null;
  const data = parseIndex(payload, 'NDX', new Date('2026-01-06T22:00:00Z'));
  assert.deepEqual(data.missingDates, ['2026-01-02']);
  payload.chart.result[0].meta.symbol = '^SOX';
  assert.match(parseIndex(payload, 'SOX', new Date('2026-01-06T22:00:00Z')).warnings.join(' '), /2021-08-25/);
});
test('참조 자료는 금리/지수 단위·정렬·결측 중복·경로 입력을 검증', () => {
  const data = parseDffCsv('observation_date,DFF\n2026-01-01,3.88\n2026-01-02,3.88', now);
  assert.throws(() => validateReference({ ...data, unit: 'index-level' }));
  assert.throws(() => validateReference({ ...data, points: [...data.points].reverse() }));
  assert.throws(() => validateReference({ ...data, missingDates: ['2026-01-01'] }));
  assert.throws(() => referenceId('../TQQQ'));
});


test('국내 거래일용 KOSPI는 KRW·서울 시간대를 검증하고 현지 당일 제외', () => {
  const payload = indexPayload();
  Object.assign(payload.chart.result[0].meta, { symbol: '^KS11', currency: 'KRW', exchangeTimezoneName: 'Asia/Seoul' });
  payload.chart.result[0].timestamp = [Date.parse('2026-01-02T06:00:00Z') / 1000, Date.parse('2026-01-05T06:00:00Z') / 1000];
  const result = parseIndex(payload, 'KOSPI', new Date('2026-01-05T07:00:00Z'));
  assert.deepEqual(result.points, [{ date: '2026-01-02', value: 100 }]);
  payload.chart.result[0].meta.currency = 'USD';
  assert.throws(() => parseIndex(payload, 'KOSPI', now), /통화/);
});
