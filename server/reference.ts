import { createHash } from 'node:crypto';
import { isDate, positive, record } from '../src/data/market.ts';
import { referenceId, validateReference } from '../src/data/reference.ts';
import type { ReferenceData, ReferenceId } from '../src/data/reference.ts';
import { completedSessionFilter, localDate } from './provider.ts';
export const rateSource = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF&cosd=1990-01-01';
const indexSymbols = { NDX: '^NDX', SP500: '^GSPC', SOX: '^SOX', KOSPI: '^KS11' } as const;
function finish(id: ReferenceId, points: ReferenceData['points'], missingDates: string[], now: Date, source: string, sourceUrl: string, warnings: string[]): ReferenceData {
  const version = createHash('sha256').update(JSON.stringify({ id, points, missingDates })).digest('hex');
  return validateReference({ schema: 1, id, unit: id === 'DFF' ? 'annual-percent' : 'index-level', points, missingDates, fetchedAt: now.toISOString(), version, source, sourceUrl, warnings });
}
export function parseDffCsv(text: string, now = new Date()): ReferenceData {
  const rows = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (rows.shift() !== 'observation_date,DFF') { throw new Error('DFF CSV 열 형식이 바뀌었습니다.'); }
  const points: ReferenceData['points'] = [];
  const missingDates: string[] = [];
  for (const row of rows) {
    const columns = row.split(',');
    const [date, raw] = columns;
    if (columns.length !== 2 || !isDate(date)) { throw new Error('DFF CSV 날짜·열 오류입니다.'); }
    if (date >= now.toISOString().slice(0, 10)) { continue; }
    if (raw === '' || raw === '.') { missingDates.push(date); continue; }
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) { throw new Error(`${date}: DFF 금리 형식 오류입니다.`); }
    points.push({ date, value: Number(raw) });
  }
  return finish('DFF', points, missingDates, now, 'Federal Reserve H.15 via FRED DFF', 'https://fred.stlouisfed.org/series/DFF', [
    '일별 실효 연방기금금리, 연율 %입니다. ETF의 실제 스왑 조달금리가 아닌 모델 대용치입니다.',
    '사후 수정 가능한 관측 자료이며 당시 공표 시점의 빈티지를 재현하지 않습니다. 금리 결측을 0으로 바꾸지 않습니다.',
  ]);
}
export function parseIndex(payload: unknown, id: Exclude<ReferenceId, 'DFF'>, now = new Date()): ReferenceData {
  const chart = record(record(payload).chart);
  if (chart.error) { throw new Error(`지수 공급원 오류: ${JSON.stringify(chart.error)}`); }
  if (!Array.isArray(chart.result) || chart.result.length !== 1) { throw new Error('지수 결과가 없습니다.'); }
  const result = record(chart.result[0]);
  const meta = record(result.meta);
  if (meta.symbol !== indexSymbols[id] || meta.currency !== (id === 'KOSPI' ? 'KRW' : 'USD') || meta.exchangeTimezoneName !== (id === 'KOSPI' ? 'Asia/Seoul' : 'America/New_York')) { throw new Error('지수 식별자·통화·시간대 오류입니다.'); }
  const indicators = record(result.indicators);
  if (!Array.isArray(result.timestamp) || !Array.isArray(indicators.quote) || indicators.quote.length !== 1) { throw new Error('지수 날짜·종가 배열 오류입니다.'); }
  const close = record(indicators.quote[0]).close;
  if (!Array.isArray(close) || close.length !== result.timestamp.length) { throw new Error('지수 날짜·종가 길이가 다릅니다.'); }
  const points: ReferenceData['points'] = [];
  const missingDates: string[] = [];
  const zone = id === 'KOSPI' ? 'Asia/Seoul' : 'America/New_York';
  const isCompletedSession = completedSessionFilter(now, zone, meta);
  for (let index = 0; index < close.length; index++) {
    const date = localDate(positive(result.timestamp[index], '지수 timestamp'), zone);
    if (!isCompletedSession(date)) { continue; }
    if (close[index] === null) { missingDates.push(date); continue; }
    points.push({ date, value: positive(close[index], '지수 종가') });
  }
  return finish(id, points, missingDates, now, 'yahoo-index-close-research', `https://finance.yahoo.com/quote/${encodeURIComponent(indexSymbols[id])}/history/`, [
    '연구용 비공식 지수 종가 조회입니다. 지수 이용 조건과 전체 이력의 완전성 대조는 미완료입니다. 결측 종가·장중 가격을 생성하지 않습니다.',
    ...(id === 'SOX' ? ['PHLX SOX 자료입니다. SOXL은 2021-08-25 무렵 ICE Semiconductor Index로 변경했으므로 이 날짜 이후 SOXL을 SOX로 보정하지 않습니다.'] : []),
  ]);
}
export async function fetchReference(key: string): Promise<ReferenceData> {
  const id = referenceId(key);
  const url = id === 'DFF' ? new URL(rateSource) : new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(indexSymbols[id])}`);
  if (id !== 'DFF') { url.search = new URLSearchParams({ period1: '631152000', period2: String(Math.floor(Date.now() / 1000)), interval: '1d' }).toString(); }
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'BackTestView/0.1 local research' } });
  if (!response.ok) { throw new Error(`모델 참조 자료 조회 HTTP ${response.status}. 기존 캐시는 보존했습니다.`); }
  return id === 'DFF' ? parseDffCsv(await response.text()) : parseIndex(await response.json(), id);
}
