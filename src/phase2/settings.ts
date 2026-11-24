import { isDate, instrumentFor } from '../data/market.ts';
import type { AccountKind } from '../accounts/types.ts';

export type { AccountKind } from '../accounts/types.ts';
export type TaxCostMethod = 'fifo' | 'average';
export type TaxScenario = 'hold' | 'liquidate';
export interface Phase2SettingsValue {
  account: AccountKind | '';
  taxEnabled: boolean;
  costMethod: TaxCostMethod;
  scenario: TaxScenario;
}
export const accountNames: Record<AccountKind, string> = {
  general: '일반계좌', isa: '중개형 ISA · 일반형', pension: '연금저축펀드',
};
export const scenarioNames: Record<TaxScenario, string> = {
  hold: '보유 유지', liquidate: '전량 매도 가정',
};
export function accountEligibility(symbol: string, account: AccountKind) {
  let instrument;
  try { instrument=instrumentFor(symbol); } catch { return { allowed:false,reason:'지원하는 종목을 먼저 선택하세요.' }; }
  if (account === 'general') { return { allowed: true, reason: '매매차익 과세는 외부 자금 납부 모형으로 구분합니다.' }; }
  if (instrument.currency !== 'KRW') { return { allowed: false, reason: '해외 상장 ETF를 직접 매수할 수 없는 계좌입니다.' }; }
  if (account === 'pension' && instrument.leverage !== 1) {
    return { allowed: false, reason: '연금저축에서는 레버리지 ETF를 매수할 수 없습니다.' };
  }
  return { allowed: true, reason: account === 'isa' ? '일반형 · 신규 개설 · 납입한도 적용' : '세액공제 안 받음 · 신규 개설 · 전액 중도인출 모형' };
}
export function validateWithdrawalDraft(date: string, amount: string): string | undefined {
  if (!isDate(date)) { return '올바른 인출 요청일을 입력하세요.'; }
  const number = Number(amount);
  if (!amount.trim() || !Number.isFinite(number) || number <= 0 || number > Number.MAX_SAFE_INTEGER) {
    return '인출 금액은 0보다 크고 안전하게 표현 가능한 숫자로 입력하세요.';
  }
  return undefined;
}
