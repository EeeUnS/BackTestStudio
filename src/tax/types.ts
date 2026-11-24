import type { Metric, CashFlow } from '../engine/metrics.ts';

export type TaxAccount = 'general' | 'isa' | 'pension';
export type CostMethod = 'fifo' | 'average';
export type TaxScenario = 'hold' | 'liquidate';
export interface TaxOptions { enabled: boolean; account: TaxAccount; costMethod: CostMethod; scenario: TaxScenario }
export interface BusinessCalendar { market: 'US' | 'KR'; version: string; source: string; from: string; to: string; businessDays: string[] }
export interface DateResolution { date: string; exact: boolean; source: string; version: string }
export interface TaxBasisData {
  symbol: string; version: string; source: string; fetchedAt: string;
  points: { date: string; value: number }[];
  warnings?: string[];
}
export interface TaxTrade {
  date: string; settlementDate: string; side: 'BUY' | 'SELL'; quantity: number; price: number;
  amountKrw: number; costKrw?: number; realizedKrw?: number; taxable?: number;
  exchangeRate: number; exchangeObservationDate: string; exactSettlement: boolean; estimated: boolean; hypothetical: boolean;
}
export interface AnnualTaxRow {
  year: number; profit: number; loss: number; net: number; deduction: number; taxable: number;
  tax: number; paid: number; unpaid: number; paymentDate: string;
  kind: 'capital-gains' | 'withholding' | 'settlement'; estimated: boolean;
}
export interface TaxEvent { date: string; kind: 'accrual' | 'payment' | 'withholding' | 'settlement'; amount: number; year: number; estimated: boolean; reason: string }
export interface TaxSettlement {
  investmentEnd: string; liquidationDate: string; settlementDate: string; minimumHoldingDate?: string;
  waitingDays: number; gross: number; tax: number; net: number; taxable: number; deduction: number; rate: number;
  principal?: number; exactDate: boolean;
}
export interface TaxReport {
  status: 'available' | 'estimated' | 'unavailable' | 'disabled'; reason?: string;
  account: TaxAccount; scenario: TaxScenario; costMethod: CostMethod; policyVersion: string;
  warnings: string[]; sources: string[]; annual: AnnualTaxRow[]; events: TaxEvent[]; trades: TaxTrade[];
  paid: number; unpaid: number; accrued: number;
  accountValueKrw?: number; afterTaxValueKrw?: number;
  afterTaxXirr: Metric; projectedAfterTaxXirr: Metric; settlement?: TaxSettlement;
  curve: { date: string; accountValue: number }[];
  flows: CashFlow[]; projectedFlows: CashFlow[];
  taxBasisVersion?: string; fxVersion?: string;
}
