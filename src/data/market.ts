export const instruments = [
  { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', currency: 'USD', zone: 'America/New_York', leverage: 3 },
  { symbol: 'QQQ5.L', name: 'Leverage Shares 5x Long Nasdaq 100 ETP', currency: 'USD', zone: 'Europe/London', leverage: 5 },
  { symbol: 'QLD', name: 'ProShares Ultra QQQ', currency: 'USD', zone: 'America/New_York', leverage: 2 },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', currency: 'USD', zone: 'America/New_York', leverage: 1 },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', currency: 'USD', zone: 'America/New_York', leverage: 1 },
  { symbol: 'UPRO', name: 'ProShares UltraPro S&P500', currency: 'USD', zone: 'America/New_York', leverage: 3 },
  { symbol: 'SSO', name: 'ProShares Ultra S&P500', currency: 'USD', zone: 'America/New_York', leverage: 2 },
  { symbol: '225040.KS', name: 'TIGER 미국S&P500레버리지(합성 H)', currency: 'KRW', zone: 'Asia/Seoul', leverage: 2 },
  { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X', currency: 'USD', zone: 'America/New_York', leverage: 3 },
  { symbol: '418660.KS', name: 'TIGER 미국나스닥100레버리지(합성)', currency: 'KRW', zone: 'Asia/Seoul', leverage: 2 },
  { symbol: '360750.KS', name: 'TIGER 미국S&P500', currency: 'KRW', zone: 'Asia/Seoul', leverage: 1 },
  { symbol: '133690.KS', name: 'TIGER 미국나스닥100', currency: 'KRW', zone: 'Asia/Seoul', leverage: 1 },
] as const;
export type SymbolCode = typeof instruments[number]['symbol'];
export function underlyingIndex(symbol: SymbolCode): 'NDX' | 'SP500' | 'SOX' {
  return symbol === 'SPY' || symbol === '360750.KS' || symbol === 'UPRO' || symbol === 'SSO' || symbol === '225040.KS' ? 'SP500' : symbol === 'SOXL' ? 'SOX' : 'NDX';
}
export function instrumentFor(symbol: string) {
  const instrument = instruments.find(item => item.symbol === symbol);
  if (!instrument) { throw new Error('지원하지 않는 종목입니다.'); }
  return instrument;
}
export interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
export interface Split { date: string; ratio: number }
export interface Distribution { exDate: string; amount: number; payDate?: string }
export interface MarketData {
  schema: 1;
  symbol: SymbolCode;
  currency: string;
  timeZone: string;
  source: string;
  fetchedAt: string;
  priceBasis: 'split-adjusted';
  bars: PriceBar[];
  splits: Split[];
  distributions: Distribution[];
  warnings: string[];
  version: string;
}
export interface MarketResponse { data: MarketData; cache: 'fresh' | 'cached'; stale: boolean }
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('데이터 객체 구조가 올바르지 않습니다.');
  }
  return value as Record<string, unknown>;
}
export function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}: 양의 유한 숫자가 필요합니다.`);
  }
  return value;
}
export function validateMarket(value: unknown): MarketData {
  const data = record(value);
  const instrument = instrumentFor(String(data.symbol));
  if (data.schema !== 1 || data.currency !== instrument.currency || data.timeZone !== instrument.zone
    || data.priceBasis !== 'split-adjusted' || typeof data.source !== 'string'
    || typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))
    || typeof data.version !== 'string' || data.version.length === 0) {
    throw new Error('데이터 메타데이터가 올바르지 않습니다.');
  }
  if (!Array.isArray(data.bars) || data.bars.length === 0 || data.bars.length > 30000) {
    throw new Error('가격 데이터가 비어 있거나 허용 범위를 넘었습니다.');
  }
  let previous = '';
  for (const raw of data.bars) {
    const bar = record(raw);
    if (!isDate(bar.date) || bar.date <= previous) { throw new Error('거래일 중복 또는 날짜 정렬 오류입니다.'); }
    previous = bar.date;
    const values = ['open', 'high', 'low', 'close'].map(key => positive(bar[key], `${bar.date} ${key}`));
    if (values[1] < Math.max(...values) || values[2] > Math.min(...values)) {
      throw new Error(`${bar.date}: OHLC 대소관계 오류입니다.`);
    }
    if (bar.volume !== undefined && (typeof bar.volume !== 'number' || !Number.isFinite(bar.volume) || bar.volume < 0)) {
      throw new Error(`${bar.date}: 거래량 오류입니다.`);
    }
  }
  for (const key of ['splits', 'distributions', 'warnings']) {
    if (!Array.isArray(data[key])) { throw new Error(`${key}: 배열이 필요합니다.`); }
  }
  for (const raw of data.splits as unknown[]) {
    const split = record(raw);
    if (!isDate(split.date)) { throw new Error('분할 날짜 오류입니다.'); }
    positive(split.ratio, '분할 비율');
  }
  for (const raw of data.distributions as unknown[]) {
    const dividend = record(raw);
    if (!isDate(dividend.exDate) || (dividend.payDate !== undefined && (!isDate(dividend.payDate) || dividend.payDate < dividend.exDate))) {
      throw new Error('분배금 날짜 오류입니다.');
    }
    positive(dividend.amount, '분배금');
  }
  if ((data.warnings as unknown[]).some(item => typeof item !== 'string')) { throw new Error('경고 형식 오류입니다.'); }
  return data as unknown as MarketData;
}
