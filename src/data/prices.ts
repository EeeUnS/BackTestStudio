import type { PriceBar } from './market.ts';
export interface EstimatedClose { kind: 'estimated-close'; date: string; close: number }
export type ExecutionBar = PriceBar | EstimatedClose;
export function isEstimatedClose(bar: ExecutionBar): bar is EstimatedClose { return 'kind' in bar && bar.kind === 'estimated-close'; }
export function openingPrice(bar: ExecutionBar) { return isEstimatedClose(bar) ? bar.close : bar.open; }
export function limitBuyPrice(bar: ExecutionBar, limit: number): number | undefined {
  if (isEstimatedClose(bar)) { return bar.close <= limit ? bar.close : undefined; }
  return bar.low <= limit ? Math.min(bar.open, limit) : undefined;
}
export function limitSellPrice(bar: ExecutionBar, limit: number): number | undefined {
  if (isEstimatedClose(bar)) { return bar.close >= limit ? bar.close : undefined; }
  return bar.high >= limit ? Math.max(bar.open, limit) : undefined;
}
