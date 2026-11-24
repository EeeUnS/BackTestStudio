import { isDate } from '../data/market.ts';
export interface CashFlow { date: string; amount: number }
export type Metric = { available: true; value: number } | { available: false; reason: string };
const yearMilliseconds = 365 * 86400000;
export function xirr(flows: CashFlow[]): Metric {
  const byDate = new Map<string, number>();
  for (const flow of flows) {
    if (!isDate(flow.date) || !Number.isFinite(flow.amount)) { throw new Error('XIRR 현금흐름 입력 오류입니다.'); }
    byDate.set(flow.date, (byDate.get(flow.date) ?? 0) + flow.amount);
  }
  const ordered = [...byDate].sort(([a], [b]) => a.localeCompare(b)).filter(([, amount]) => amount !== 0);
  if (ordered.length < 2 || ordered[0][0] === ordered.at(-1)![0]) {
    return { available: false, reason: '서로 다른 날짜의 양·음 현금흐름이 필요합니다.' };
  }
  const signs = ordered.map(([, amount]) => Math.sign(amount));
  let changes = 0;
  for (let i = 1; i < signs.length; i++) { if (signs[i] !== signs[i - 1]) { changes++; } }
  if (changes !== 1) {
    return { available: false, reason: changes === 0 ? '양·음 현금흐름이 모두 필요합니다.' : '부호가 여러 번 바뀌어 다중 해 가능성이 있습니다. 단일 XIRR을 확정하지 않습니다.' };
  }
  const origin = Date.parse(ordered[0][0]);
  const items = ordered.map(([date, amount]) => ({ years: (Date.parse(date) - origin) / yearMilliseconds, amount }));
  function npv(logRate: number) {
    const largest = Math.max(...items.map(item => Math.log(Math.abs(item.amount)) - item.years * logRate));
    return items.reduce((sum, item) => sum + Math.sign(item.amount) * Math.exp(Math.log(Math.abs(item.amount)) - item.years * logRate - largest), 0);
  }
  let lower = -36;
  let upper = 36;
  let lowerValue = npv(lower);
  if (Math.sign(lowerValue) === Math.sign(npv(upper))) {
    return { available: false, reason: '탐색 가능한 연환산 수익률 범위에서 해를 찾지 못했습니다.' };
  }
  for (let i = 0; i < 200; i++) {
    const middle = (lower + upper) / 2;
    const value = npv(middle);
    if (value === 0) { lower = middle; upper = middle; break; }
    if (Math.sign(value) === Math.sign(lowerValue)) { lower = middle; lowerValue = value; }
    else { upper = middle; }
  }
  const rate = Math.expm1((lower + upper) / 2);
  if (!Number.isFinite(rate) || rate <= -1) { return { available: false, reason: '수치적으로 표현 가능한 해가 없습니다.' }; }
  return { available: true, value: rate };
}
export function cagr(initial: number, final: number, start: string, end: string): Metric {
  if (!isDate(start) || !isDate(end) || !Number.isFinite(initial) || !Number.isFinite(final) || initial <= 0 || final < 0) {
    throw new Error('CAGR 입력 오류입니다.');
  }
  const years = (Date.parse(end) - Date.parse(start)) / yearMilliseconds;
  if (years <= 0) { return { available: false, reason: '연환산에는 하루 이상의 평가 기간이 필요합니다.' }; }
  const value = Math.pow(final / initial, 1 / years) - 1;
  return Number.isFinite(value) ? { available: true, value } : { available: false, reason: '연환산 결과가 유한 범위를 넘었습니다.' };
}
