import type { EstimatedHistory } from '../model/estimate.ts';
import type { FxData } from '../data/fx.ts';
import type { MarketData } from '../data/market.ts';
import type { ReferenceData } from '../data/reference.ts';
import type { BacktestRequest, BacktestResult } from '../engine/simpleBacktest.ts';
import type { TaxBasisData, TaxOptions, TaxReport } from '../tax/types.ts';
export type CalculationRequest = BacktestRequest & { tax?: TaxOptions };
export type CalculationResult = BacktestResult & { tax?: TaxReport };
export type WorkerRequest = { kind: 'load'; data: MarketData; estimate?: EstimatedHistory; nasdaq?: ReferenceData } | { kind: 'loadFx'; data?: FxData } | { kind:'loadTaxBasis';data?:TaxBasisData } | { kind: 'run'; id: number; request: CalculationRequest };
export type WorkerReply = { kind: 'ready' } | { kind: 'error'; id: number; error: string }
  | { kind: 'result'; id: number; result: CalculationResult; cached: boolean; milliseconds: number };
