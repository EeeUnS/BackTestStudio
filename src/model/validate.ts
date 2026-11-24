import { instruments, isDate, positive, record } from '../data/market.ts';
import type { EstimatedHistory } from './estimate.ts';
export function validateEstimate(value: unknown): EstimatedHistory {
  const data = record(value);
  const anchor = record(data.anchor);
  const fit = record(data.calibration);
  const validation = record(data.validation);
  const versions = record(data.inputVersions);
  const instrument = instruments.find(item => item.symbol === data.symbol);
  if (data.schema !== 1 || !instrument
    || data.currency !== instrument.currency || data.priceBasis !== 'split-adjusted' || data.model !== 'daily-leverage-financing-log-residual-v1'
    || typeof data.version !== 'string' || !data.version || typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))
    || !isDate(anchor.date) || !isDate(fit.start) || !isDate(fit.end) || !isDate(validation.start) || !isDate(validation.end)
    || fit.start > fit.end || fit.end >= validation.start || validation.start > validation.end || anchor.date > fit.start
    || fit.financingDayBasis !== 360 || fit.residualDayBasis !== 365
    || !Array.isArray(data.points) || data.points.length === 0 || data.points.length > 30000
    || !Array.isArray(data.warnings) || data.warnings.some(item => typeof item !== 'string') || !Array.isArray(data.sources) || data.sources.length === 0 || data.sources.some(item => typeof item !== 'string' || !item.startsWith('https://'))
    || ['etf', 'index', 'rates'].some(key => typeof versions[key] !== 'string' || !versions[key]) || Object.values(versions).some(version => typeof version !== 'string' || !version)) {
    throw new Error('추정 모델 메타데이터 오류입니다.');
  }
  if (data.omittedCalendarDates !== undefined) {
    if (!Array.isArray(data.omittedCalendarDates) || data.omittedCalendarDates.some(date => !isDate(date) || date >= String(anchor.date))
      || new Set(data.omittedCalendarDates).size !== data.omittedCalendarDates.length) { throw new Error('추정 제외 날짜 메타데이터 오류입니다.'); }
  }
  positive(anchor.close, '연결 종가');
  for (const [object, keys] of [[fit, ['annualResidual', 'financingLeverage']], [validation, ['dailyRmse', 'dailyBias', 'annualTrackingError', 'terminalRelativeError', 'maxRelativeError']]] as const) {
    for (const key of keys) { if (typeof object[key] !== 'number' || !Number.isFinite(object[key])) { throw new Error('추정 모델 보정·검증 수치 오류입니다.'); } }
  }
  for (const count of [fit.observations, validation.observations]) { if (typeof count !== 'number' || !Number.isInteger(count) || count < 252) { throw new Error('추정 모델 보정·검증 관측이 부족합니다.'); } }
  let previous = '';
  for (const raw of data.points) {
    const point = record(raw);
    if (!isDate(point.date) || point.date <= previous || point.date >= anchor.date || ['open', 'high', 'low', 'volume'].some(key => key in point)) { throw new Error('추정 종가 날짜·가격 종류 오류입니다.'); }
    positive(point.close, '추정 종가');
    previous = point.date;
  }
  return data as unknown as EstimatedHistory;
}
