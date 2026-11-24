import { instrumentFor, underlyingIndex, validateMarket } from '../data/market.ts';
import type { MarketData } from '../data/market.ts';
import { validateReference } from '../data/reference.ts';
import type { ReferenceData, ReferenceId } from '../data/reference.ts';
import { validateFx } from '../data/fx.ts';
import type { FxData } from '../data/fx.ts';
const dayMs = 86400000;
export interface ModelValidation {
  start: string; end: string; observations: number; dailyRmse: number; dailyBias: number; annualTrackingError: number; terminalRelativeError: number; maxRelativeError: number;
}
export interface EstimatedHistory {
  schema: 1; symbol: MarketData['symbol']; currency: string; priceBasis: 'split-adjusted'; model: 'daily-leverage-financing-log-residual-v1';
  version: string; fetchedAt: string; points: { date: string; close: number }[];
  anchor: { date: string; close: number };
  calibration: { start: string; end: string; observations: number; annualResidual: number; financingLeverage: number; financingDayBasis: 360; residualDayBasis: 365; indexRegimeEnd?: string };
  validation: ModelValidation; omittedCalendarDates?: string[]; inputVersions: Record<string, string>; sources: string[]; warnings: string[];
}
function daysBetween(start: string, end: string) { return (Date.parse(end) - Date.parse(start)) / dayMs; }
function previousIndex<T extends { date: string }>(points: T[], date: string, strict = false) {
  let left = 0;
  let right = points.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (strict ? points[middle].date < date : points[middle].date <= date) { left = middle + 1; } else { right = middle; }
  }
  return left - 1;
}
function fundingIntegral(index: ReferenceData, rates: ReferenceData, leverage: number) {
  const result = new Map<string, number>();
  let accumulated = 0;
  const first = Date.parse(index.points[0].date);
  const last = Date.parse(index.points.at(-1)!.date);
  let rateIndex = -1;
  for (let time = first; time <= last; time += dayMs) {
    const date = new Date(time).toISOString().slice(0, 10);
    result.set(date, accumulated);
    if (leverage <= 1) { continue; }
    while (rateIndex + 1 < rates.points.length && rates.points[rateIndex + 1].date <= date) { rateIndex++; }
    if (rateIndex < 0 || daysBetween(rates.points[rateIndex].date, date) > 7) { throw new Error(`${date}: 조달금리 대용치가 없거나 7일 넘게 오래되어 추정할 수 없습니다.`); }
    accumulated += (leverage - 1) * rates.points[rateIndex].value / 100 / 360;
  }
  return result;
}
export function estimateHistory(etf: MarketData, index: ReferenceData, rates: ReferenceData, fx?: FxData, calendar?: ReferenceData): EstimatedHistory {
  validateMarket(etf); validateReference(index); validateReference(rates);
  const instrument = instrumentFor(etf.symbol);
  const expectedIndex: ReferenceId = underlyingIndex(etf.symbol);
  if (index.id !== expectedIndex || rates.id !== 'DFF') { throw new Error('종목의 기초지수 또는 조달금리 대용치가 일치하지 않습니다.'); }
  const regimeEnd = etf.symbol === 'SOXL' ? '2021-08-24' : undefined;
  const usableIndex = { ...index, points: index.points.filter(point => !regimeEnd || point.date <= regimeEnd) };
  if (usableIndex.points.length < 2) { throw new Error('기초지수의 사용 가능 구간이 부족합니다.'); }
  if (index.missingDates.some(date => date >= usableIndex.points[0].date && date <= usableIndex.points.at(-1)!.date)) { throw new Error('기초지수 종가 결측이 있어 일별 레버리지 경로를 생성할 수 없습니다.'); }
  const funding = fundingIntegral(usableIndex, rates, instrument.leverage);
  const path = new Map<string, number>();
  let logLevel = 0;
  path.set(usableIndex.points[0].date, logLevel);
  for (let i = 1; i < usableIndex.points.length; i++) {
    const previous = usableIndex.points[i - 1];
    const current = usableIndex.points[i];
    const gross = 1 + instrument.leverage * (current.value / previous.value - 1) - (funding.get(current.date)! - funding.get(previous.date)!);
    if (!Number.isFinite(gross) || gross <= 0) { throw new Error(`${current.date}: 일별 레버리지 모델이 0 이하입니다. 임의 가격이나 청산 규칙을 생성하지 않습니다.`); }
    logLevel += Math.log(gross);
    path.set(current.date, logLevel);
  }
  if (etf.currency === 'KRW') {
    if (!fx || !calendar) { throw new Error('TIGER 추정에는 과거 환율과 국내 거래일 자료가 필요합니다.'); }
    validateFx(fx); validateReference(calendar);
    if (calendar.id !== 'KOSPI') { throw new Error('국내 거래일 참조 자료가 일치하지 않습니다.'); }
  }
  function baseLevel(date: string): number {
    if (etf.currency === 'USD') {
      const value = path.get(date);
      if (value === undefined) { throw new Error(`${date}: ETF와 기초지수 날짜가 일치하지 않습니다.`); }
      return value;
    }
    const underlying = previousIndex(usableIndex.points, date, true);
    const currency = previousIndex(fx!.observations, date, true);
    if (underlying < 0 || currency < 0 || daysBetween(usableIndex.points[underlying].date, date) > 10 || daysBetween(fx!.observations[currency].date, date) > 14) {
      throw new Error(`${date}: 국내 평가일 이전의 미국 종가·환율 관측을 확보하지 못했습니다.`);
    }
    return path.get(usableIndex.points[underlying].date)! + Math.log(fx!.observations[currency].rate);
  }
  const actual = etf.bars.filter(bar => !regimeEnd || bar.date <= regimeEnd).map(bar => ({ date: bar.date, close: bar.close, base: baseLevel(bar.date) }));
  const pairs = actual.slice(1).map((current, i) => ({ previous: actual[i], current }));
  const trainingCount = Math.min(1260, Math.floor(pairs.length * 0.6));
  if (trainingCount < 252 || pairs.length - trainingCount < 252) { throw new Error('보정·미사용 검증에 각각 최소 252개 수익률 관측이 필요합니다.'); }
  const training = pairs.slice(0, trainingCount);
  const holdout = pairs.slice(trainingCount);
  let residualLog = 0;
  let years = 0;
  for (const { previous, current } of training) {
    residualLog += current.base - previous.base - Math.log(current.close / previous.close);
    years += daysBetween(previous.date, current.date) / 365;
  }
  const annualResidual = residualLog / years;
  if (!Number.isFinite(annualResidual)) { throw new Error('잔여 비용·추적 차이 보정이 유한하지 않습니다.'); }
  let predicted = holdout[0].previous.close;
  let squared = 0;
  let bias = 0;
  let maxRelativeError = 0;
  for (const { previous, current } of holdout) {
    const gross = Math.exp(current.base - previous.base - annualResidual * daysBetween(previous.date, current.date) / 365);
    predicted *= gross;
    const error = gross - current.close / previous.close;
    squared += error * error;
    bias += error;
    maxRelativeError = Math.max(maxRelativeError, Math.abs(predicted / current.close - 1));
  }
  const dailyBias = bias / holdout.length;
  const validation: ModelValidation = { start: holdout[0].current.date, end: holdout.at(-1)!.current.date, observations: holdout.length,
    dailyRmse: Math.sqrt(squared / holdout.length), dailyBias, annualTrackingError: Math.sqrt(Math.max(0, squared / holdout.length - dailyBias * dailyBias) * 252),
    terminalRelativeError: predicted / holdout.at(-1)!.current.close - 1, maxRelativeError };
  if (Object.values(validation).some(value => typeof value === 'number' && !Number.isFinite(value))) { throw new Error('독립 검증 결과가 유한하지 않습니다.'); }
  const anchor = { date: etf.bars[0].date, close: etf.bars[0].close };
  const anchorBase = baseLevel(anchor.date);
  const dates = (etf.currency === 'USD' ? usableIndex.points : calendar!.points).map(point => point.date).filter(date => date < anchor.date
    && (etf.currency === 'USD' || (date > usableIndex.points[0].date && date > fx!.observations[0].date)));
  const points = dates.map(date => {
    const close = anchor.close * Math.exp(baseLevel(date) - anchorBase - annualResidual * daysBetween(anchor.date, date) / 365);
    if (!Number.isFinite(close) || close <= 0) { throw new Error(`${date}: 추정 종가가 양의 유한 범위를 벗어났습니다.`); }
    return { date, close };
  });
  if (points.length === 0) { throw new Error('기초지수로 복원 가능한 상장 전 구간이 없습니다.'); }
  const inputVersions = { etf: etf.version, index: index.version, rates: rates.version, ...(fx ? { fx: fx.version } : {}), ...(calendar ? { calendar: calendar.version } : {}) };
  return { schema: 1, symbol: etf.symbol, currency: etf.currency, priceBasis: 'split-adjusted', model: 'daily-leverage-financing-log-residual-v1',
    version: JSON.stringify({ model: 1, inputVersions, annualResidual }), fetchedAt: new Date().toISOString(), points, anchor,
    calibration: { start: training[0].previous.date, end: training.at(-1)!.current.date, observations: trainingCount, annualResidual, financingLeverage: instrument.leverage - 1, financingDayBasis: 360, residualDayBasis: 365, ...(regimeEnd ? { indexRegimeEnd: regimeEnd } : {}) }, validation, ...(calendar ? { omittedCalendarDates: calendar.missingDates.filter(date => date < anchor.date) } : {}), inputVersions,
    sources: [`https://finance.yahoo.com/quote/${encodeURIComponent(etf.symbol)}/history/`, index.sourceUrl, rates.sourceUrl, ...(fx?.sources ?? []), ...(calendar ? [calendar.sourceUrl] : [])], warnings: [
      ...index.warnings, ...rates.warnings, ...(calendar?.warnings ?? []), ...(fx?.warnings ?? []),
      ...(calendar && calendar.missingDates.length > 0 ? [`국내 거래일 참조의 결측 ${calendar.missingDates.length}일은 휴장 확정으로 분류하지 않고 추정 날짜에서 제외합니다. 양의 KOSPI 종가가 확인된 날짜에만 추정값을 생성하며 제외 날짜를 메타데이터에 보존합니다.`] : []),
      '상장 후 자료로 보정한 사후 가상 가격이며 실제 운용 실적·당시 이용 가능 가격이 아닙니다. 최초 실제 ETF 종가에 연결하며 실제 구간에서는 비용을 추가 차감하지 않습니다.',
      '일별 지수 레버리지에서 (배율−1)×DFF 조달 대용치(ACT/360)를 분리하고 연율 로그 잔여 차이(ACT/365)를 보정합니다. 잔여 차이는 공시 운용보수가 아니며 추적·가격/NAV 차이와 분배금 제외 영향도 포함할 수 있습니다.',
      '최초 60%의 수익률 관측(최대 1260개)을 보정에 쓰고 이후 최소 252개를 미사용 검증에 씁니다. 연환산 추적오차는 252거래일 가정입니다. 검증 오차를 제거하거나 검증 자료로 재보정하지 않습니다.',
      '종가만 생성합니다. 추정 OHLC·거래량·분배금·가상 분할은 생성하지 않습니다. 체결·정수주 가격 단위 정책은 별도 적용이 필요합니다.',
      ...(regimeEnd ? ['SOXL은 PHLX SOX 추종 구간(2021-08-24까지)에서만 보정·검증합니다. 이후 ICE 지수와 혼합하지 않습니다. 확보된 SOX 이력 이전은 복원하지 않습니다.'] : []),
      ...(etf.currency === 'KRW' ? ['TIGER는 국내 거래일 이전의 최근 미국 일별 레버리지 종가와 이전 환율 관측을 원화로 결합하는 연구용 시차 근사입니다. 환율은 1배만 적용하며 실제 스왑 NAV 시각·국내 종가 프리미엄을 재현하지 않습니다.'] : []),
    ] };
}
