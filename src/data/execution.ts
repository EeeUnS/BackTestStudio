import { validateEstimate } from '../model/validate.ts';
import type { EstimatedHistory } from '../model/estimate.ts';
import { instrumentFor, isDate, validateMarket } from './market.ts';
import type { MarketData, PriceBar } from './market.ts';
import type { ExecutionData } from '../engine/simpleBacktest.ts';

export function splitFactorAfter(date: string, data: Pick<MarketData, 'splits'>) {
  const factor = data.splits.filter(split => split.date > date).reduce((value, split) => value * split.ratio, 1);
  if (!Number.isFinite(factor) || factor <= 0) { throw new Error('분할 단위 복원 비율 오류입니다.'); }
  return factor;
}
export function prepareExecution(data: MarketData, start: string, end: string): ExecutionData & { bars: PriceBar[] } {
  validateMarket(data);
  if (!isDate(start) || !isDate(end) || end < start) { throw new Error('체결 준비 기간 오류입니다.'); }
  const duplicateSplits = new Set<string>();
  for (const split of data.splits) {
    if (duplicateSplits.has(split.date)) { throw new Error('분할 이벤트 중복입니다.'); }
    duplicateSplits.add(split.date);
  }
  const bars: PriceBar[] = data.bars.map(bar => {
    // 선택 종료일 이후 분할도 포함해야 현재 단위 가격을 당시 단위로 되돌릴 수 있다.
    const factor = splitFactorAfter(bar.date, data);
    return { date: bar.date, open: bar.open * factor, high: bar.high * factor, low: bar.low * factor, close: bar.close * factor };
  });
  return { symbol:data.symbol, currency:instrumentFor(data.symbol).currency, version: `${data.version}:as-traded-no-dividends-v1`, bars, splits: data.splits, distributions: [],
    warnings: ['사용자 요청에 따라 모든 분배금은 계산에서 제외합니다. 가격수익·매매·외부 입출금만 반영하며 분배금 포함 총수익이 아닙니다.'] };
}

export function prepareEstimatedExecution(data: MarketData, estimate: EstimatedHistory): ExecutionData {
  validateEstimate(estimate);
  if (estimate.symbol !== data.symbol || estimate.currency !== data.currency || estimate.inputVersions.etf !== data.version
    || estimate.anchor.date !== data.bars[0].date || estimate.anchor.close !== data.bars[0].close) { throw new Error('추정 모델의 종목·버전·실제 연결 가격이 현재 시세와 다릅니다.'); }
  const actual = prepareExecution(data, data.bars[0].date, data.bars.at(-1)!.date);
  const bars = estimate.points.map(point => ({ kind: 'estimated-close' as const, date: point.date, close: point.close * splitFactorAfter(point.date, data) }));
  return { ...actual, version: `${actual.version}:${estimate.version}`, bars: [...bars, ...actual.bars], warnings: [...(actual.warnings ?? []), ...estimate.warnings,
    '추정 구간의 1주 단위는 최초 실제 ETF 1주에 연결하고 이후 실제 분할만 반영합니다. 가상 분할·가격 재정규화는 하지 않습니다. 정수주·고정 주문 호가에 민감한 연구용 결과입니다.'] };
}
