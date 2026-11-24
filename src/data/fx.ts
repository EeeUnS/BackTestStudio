import { isDate, positive, record } from './market.ts';
export interface FxObservation {
  date: string;
  rate: number;
}
export interface FxData {
  schema: 1;
  pair: 'USD-KRW';
  unit: 'KRW-per-USD';
  source: string;
  sources: string[];
  fetchedAt: string;
  version: string;
  observations: FxObservation[];
  missingDates: string[];
  warnings: string[];
}
export function validateFx(value: unknown): FxData {
  const data = record(value);
  if (data.schema !== 1 || data.pair !== 'USD-KRW' || data.unit !== 'KRW-per-USD' || typeof data.source !== 'string'
    || typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt)) || typeof data.version !== 'string' || !data.version
    || !Array.isArray(data.observations) || data.observations.length === 0 || data.observations.length > 40000
    || !Array.isArray(data.sources) || data.sources.length === 0 || data.sources.some(item => typeof item !== 'string' || !item.startsWith('https://'))
    || !Array.isArray(data.warnings) || data.warnings.some(item => typeof item !== 'string') || !Array.isArray(data.missingDates)) {
    throw new Error('환율 메타데이터·관측 목록 오류입니다.');
  }
  let previous = '';
  const dates = new Set<string>();
  for (const item of data.observations) {
    const observation = record(item);
    if (!isDate(observation.date) || observation.date <= previous) {
      throw new Error('환율 날짜 중복·정렬 오류입니다.');
    }
    positive(observation.rate, '환율');
    previous = observation.date;
    dates.add(previous);
  }
  const missing = new Set<string>();
  for (const date of data.missingDates) {
    if (!isDate(date) || dates.has(date) || missing.has(date)) {
      throw new Error('환율 미제공 날짜 오류입니다.');
    }
    missing.add(date);
  }
  return data as unknown as FxData;
}
export function alignFx(dates: string[], data: FxData) {
  validateFx(data);
  let index = -1;
  let previous = '';
  return dates.map(date => {
    if (!isDate(date) || date < previous) {
      throw new Error('환산 날짜 정렬 오류입니다.');
    }
    previous = date;
    while (index + 1 < data.observations.length && data.observations[index + 1].date <= date) {
      index++;
    }
    if (index < 0) {
      throw new Error(`${date}: 첫 환율 관측 이전은 원화 환산할 수 없습니다.`);
    }
    const observation = data.observations[index];
    return { date, rate: observation.rate, observationDate: observation.date, carriedDays: (Date.parse(date) - Date.parse(observation.date)) / 86400000 };
  });
}
