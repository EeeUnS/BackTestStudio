export type AccountKind = 'general' | 'isa' | 'pension';
export interface WithdrawalRequest { id: string; date: string; amount: number; currency: 'USD' | 'KRW' }
export interface ContributionEntry {
  date: string; source: 'initial' | 'dca' | 'vr'; requested: number; approved: number; blocked: number;
}
export interface AnnualContribution {
  year: number; available: number; requested: number; approved: number; blocked: number; cumulativeApproved: number;
}
export interface WithdrawalPayment { date: string; gross: number; tax: number; net: number; principal?: number }
export interface WithdrawalExecution {
  id: string; source: 'scheduled' | 'vr'; requestedDate: string; currency: 'USD' | 'KRW'; requested: number;
  processedDate?: string; paidDate?: string; settlementDate?: string; settlementExact?: boolean;
  allowed: number; restricted: number; soldQuantity: number; saleAmount: number;
  grossPaid: number; tax: number; netPaid: number; unpaid: number; pending: boolean;
  beforeTotal?: number; afterTotal?: number; reason: string; payments: WithdrawalPayment[];
  excluded?: boolean;
}
export interface AccountReport {
  kind: AccountKind; openedAt: string; currency: 'USD' | 'KRW'; policyVersion: string;
  contributions: ContributionEntry[]; annualContributions: AnnualContribution[]; withdrawals: WithdrawalExecution[];
  requested: number; approved: number; blocked: number;
  withdrawnGross: number; withdrawnNet: number; withdrawalTax: number; principalRemaining: number;
  warnings: string[];
}
