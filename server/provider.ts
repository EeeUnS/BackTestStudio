import { createHash } from 'node:crypto';
import { instrumentFor, positive, record, validateMarket } from '../src/data/market.ts';
import type { MarketData, PriceBar } from '../src/data/market.ts';

export function localDate(timestamp: number, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp * 1000);
}
export function completedSessionFilter(now: Date, timeZone: string, meta: Record<string, unknown>) {
  const nowSeconds = now.getTime() / 1000;
  const today = localDate(nowSeconds, timeZone);
  const end = (meta.currentTradingPeriod as { regular?: { end?: unknown } } | undefined)?.regular?.end;
  const todayClosed = typeof end === 'number' && Number.isFinite(end) && end > 0 && end <= nowSeconds && localDate(end, timeZone) === today;
  return (date: string) => date < today || (date === today && todayClosed);
}
export function parseYahoo(payload: unknown, symbol: string, now = new Date(), since?: string): MarketData {
  const instrument = instrumentFor(symbol);
  const chart = record(record(payload).chart);
  if (chart.error) { throw new Error(`공급원 오류: ${JSON.stringify(chart.error)}`); }
  if (!Array.isArray(chart.result) || chart.result.length !== 1) { throw new Error('가격 조회 결과가 없습니다.'); }
  const result = record(chart.result[0]);
  const meta = record(result.meta);
  if (meta.symbol !== instrument.symbol) { throw new Error('조회 응답의 종목 코드가 요청한 종목과 다릅니다.'); }
  if (meta.currency !== instrument.currency || meta.exchangeTimezoneName !== instrument.zone) {
    throw new Error('조회 통화 또는 거래소 시간대가 일치하지 않습니다.');
  }
  if (!Array.isArray(result.timestamp)) { throw new Error('거래일 목록이 없습니다.'); }
  const indicators = record(result.indicators);
  if (!Array.isArray(indicators.quote) || indicators.quote.length !== 1) { throw new Error('OHLC 배열이 없습니다.'); }
  const quote = record(indicators.quote[0]);
  const arrays = ['open', 'high', 'low', 'close', 'volume'].map(key => quote[key]);
  if (arrays.some(column => !Array.isArray(column) || column.length !== (result.timestamp as unknown[]).length)) {
    throw new Error('가격 배열 길이가 거래일 목록과 다릅니다.');
  }
  const isCompletedSession = completedSessionFilter(now, instrument.zone, meta);
  const bars: PriceBar[] = [];
  let extendedRanges = 0;
  const warnings = [
    'Yahoo 비공식 조회 경로 · 이용 조건과 기업행동 완전성 검증 전 연구용 데이터입니다.',
    '당일 일봉은 공급원이 제공한 정규장 종료 시각이 지난 뒤 반영합니다. 휴장·거래정지와 결측 여부는 별도로 대조하지 않습니다.',
    'OHLC는 분할수정 단위이며 체결 전 당시 1주 가격으로 복원해야 합니다. adjclose는 사용하지 않습니다.',
  ];
  for (let i = 0; i < result.timestamp.length; i++) {
    const timestamp = positive(result.timestamp[i], '시세 timestamp');
    const date = localDate(timestamp, instrument.zone);
    if (!isCompletedSession(date) || (since !== undefined && date < since)) { continue; }
    const [open, high, low, close, volume] = arrays.map(column => (column as unknown[])[i]);
    if ([open, high, low, close].every(value => value === null)) {
      warnings.push(`${date}: OHLC 미제공 행. 거래일 여부 확인 필요, 가격을 생성하지 않았습니다.`);
      continue;
    }
    const bar: PriceBar = { date, open: positive(open, date), high: positive(high, date), low: positive(low, date), close: positive(close, date) };
    if (instrument.symbol === 'QQQ5.L' && bar.high >= bar.low) {
      const high = Math.max(bar.high, bar.open, bar.close);
      const low = Math.min(bar.low, bar.open, bar.close);
      if (high !== bar.high || low !== bar.low) { extendedRanges++; }
      bar.high = high;
      bar.low = low;
    }
    if (volume !== null && volume !== undefined) {
      if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) { throw new Error(`${date}: 거래량 오류`); }
      bar.volume = volume;
    }
    bars.push(bar);
  }
  if (extendedRanges) {
    warnings.push(`QQQ5 일봉 ${extendedRanges}개의 공급원 고가·저가 범위를 시가와 종가까지 확장했습니다. 시가와 종가는 원본 값을 사용합니다.`);
  }
  const events = result.events === undefined ? {} : record(result.events);
  const splits = Object.values(record(events.splits ?? {})).map(raw => {
    const item = record(raw);
    return { date: localDate(positive(item.date, '분할일'), instrument.zone), ratio: positive(item.numerator, '분할 분자') / positive(item.denominator, '분할 분모') };
  }).filter(item => since === undefined || item.date >= since).sort((a, b) => a.date.localeCompare(b.date));
  const distributions = Object.values(record(events.dividends ?? {})).map(raw => {
    const item = record(raw);
    return { exDate: localDate(positive(item.date, '권리락일'), instrument.zone), amount: positive(item.amount, '분배금') };
  }).filter(item => since === undefined || item.exDate >= since).sort((a, b) => a.exDate.localeCompare(b.exDate));
  if (distributions.length > 0) {
    warnings.push('분배금 지급일은 미확보이며, 사용자 요청에 따라 분배금은 계산에서 제외합니다. 지급일 누락으로 계산을 차단하지 않습니다.');
  }
  const body = { schema: 1 as const, symbol: instrument.symbol, currency: instrument.currency, timeZone: instrument.zone,
    source: 'yahoo-chart-research', fetchedAt: now.toISOString(), priceBasis: 'split-adjusted' as const,
    bars, splits, distributions, warnings };
  const version = createHash('sha256').update(JSON.stringify({ symbol, bars, splits, distributions })).digest('hex');
  return validateMarket({ ...body, version });
}
export async function fetchMarket(symbol: string, since?: string): Promise<MarketData> {
  instrumentFor(symbol);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.search = new URLSearchParams({ period1: since ? String(Date.parse(since) / 1000 - 86400) : '631152000', period2: String(Math.floor(Date.now() / 1000)), interval: '1d', events: 'div,splits' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'BackTestView/0.1 local research' } });
  if (!response.ok) { throw new Error(`시세 조회 HTTP ${response.status}. 기존 캐시는 변경하지 않았습니다.`); }
  const payload = await response.json();
  return parseYahoo(payload, symbol, new Date(), since);
}
