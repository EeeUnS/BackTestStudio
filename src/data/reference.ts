import { isDate, record } from './market.ts';
export const referenceIds = ['NDX', 'SP500', 'SOX', 'DFF', 'KOSPI'] as const;
export type ReferenceId = typeof referenceIds[number];
export interface ReferenceData {
  schema: 1;
  id: ReferenceId;
  unit: 'index-level' | 'annual-percent';
  source: string;
  sourceUrl: string;
  fetchedAt: string;
  version: string;
  points: { date: string; value: number }[];
  missingDates: string[];
  warnings: string[];
}
export function referenceId(value: string): ReferenceId {
  const id = referenceIds.find(item => item === value);
  if (!id) { throw new Error('지원하지 않는 모델 참조 자료입니다.'); }
  return id;
}
export function validateReference(value: unknown): ReferenceData {
  const data = record(value);
  const id = referenceId(String(data.id));
  if (data.schema !== 1 || data.unit !== (id === 'DFF' ? 'annual-percent' : 'index-level')
    || typeof data.source !== 'string' || !data.source || typeof data.sourceUrl !== 'string' || !data.sourceUrl.startsWith('https://')
    || typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt)) || typeof data.version !== 'string' || !data.version
    || !Array.isArray(data.points) || data.points.length === 0 || data.points.length > 50000
    || !Array.isArray(data.missingDates) || !Array.isArray(data.warnings) || data.warnings.some(item => typeof item !== 'string')) {
    throw new Error('모델 참조 자료 메타데이터 오류입니다.');
  }
  let previous = '';
  const dates = new Set<string>();
  for (const raw of data.points) {
    const point = record(raw);
    if (!isDate(point.date) || point.date <= previous || typeof point.value !== 'number' || !Number.isFinite(point.value)
      || (id === 'DFF' ? point.value < -100 || point.value > 100 : point.value <= 0)) {
      throw new Error('모델 참조 자료 날짜·값 오류입니다.');
    }
    previous = point.date;
    dates.add(point.date);
  }
  previous = '';
  for (const date of data.missingDates) {
    if (!isDate(date) || date <= previous || dates.has(date)) { throw new Error('모델 참조 자료 결측 날짜 오류입니다.'); }
    previous = date;
  }
  return data as unknown as ReferenceData;
}
