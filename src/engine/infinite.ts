import { buy, sell } from './account.ts';
import type { Account } from './account.ts';
import type { ExecutionBar } from '../data/prices.ts';
import { isEstimatedClose, openingPrice, limitSellPrice } from '../data/prices.ts';
import type { Trade } from './simpleBacktest.ts';
export interface InfiniteStrategy {
  kind: 'infinite'; capital: number; splits: number; target: number; reinvestment: number; tick: number;
}
export interface InfiniteState {
  kind: 'infinite'; round: number; mode: 'normal' | 'quarter'; oneBuy: number; starPercent: number; cashShortage: boolean;
}
export interface InfinitePlan {
  originalQuantity: number; round: number; starPercent: number; targetPrice: number; locPrice: number;
  quarterQuantity: number; limitQuantity: number; exhausted: boolean;
  buys: { limit: number; quantity: number; budget: number; reason: string }[];
}
export function validateInfinite(settings: InfiniteStrategy) {
  if (!Number.isFinite(settings.capital) || settings.capital <= 0 || !Number.isInteger(settings.splits) || settings.splits < 2 || settings.splits > 1000
    || !Number.isFinite(settings.target) || settings.target <= 0 || settings.target >= 1
    || !Number.isFinite(settings.reinvestment) || settings.reinvestment < 0 || settings.reinvestment > 1
    || !Number.isFinite(settings.tick) || settings.tick <= 0) {
    throw new Error('V3 설정 오류: 투자금·분할2~1000·목표0~100%미만·재투입0~100%·가격 단위를 확인하세요.');
  }
}
export function planInfinite(account: Readonly<Account>, oneBuy: number, quarterMode: boolean, settings: InfiniteStrategy): InfinitePlan {
  validateInfinite(settings);
  if (!Number.isFinite(oneBuy) || oneBuy <= 0 || account.quantity <= 0) { throw new Error('V3 주문 생성에 보유 주식과 양의 회당 매수액이 필요합니다.'); }
  const down = (price: number) => Math.floor(price / settings.tick + 1e-10) * settings.tick;
  const up = (price: number) => Math.ceil(price / settings.tick - 1e-10) * settings.tick;
  const average = account.cost / account.quantity;
  const round = Math.ceil(account.cost / oneBuy * 10 - 1e-10) / 10;
  // V3.0 /59826 keeps the T-dependent star point in quarter mode too.
  const starPercent = settings.target * (1 - 2 * round / settings.splits);
  const locPrice = down(average * (1 + starPercent));
  const targetPrice = up(average * (1 + settings.target));
  // The original 125-share table assigns 31 to the quarter and 94 to the target.
  const quarterQuantity = Math.floor(account.quantity / 4);
  const exhausted = round > settings.splits - 1 || account.cash <= 0;
  const early = !quarterMode && round < settings.splits / 2;
  const budgets = [{ limit: down(locPrice - settings.tick), budget: early ? oneBuy / 2 : oneBuy, reason: quarterMode ? 'V3 쿼터 LOC 매수' : 'V3 별지점 LOC 매수' }];
  if (early) {
    const first = budgets[0];
    const reserved = first.limit > 0 ? Math.floor(first.budget / first.limit) * first.limit : 0;
    budgets.push({ limit: down(average) - settings.tick, budget: oneBuy - reserved, reason: 'V3 평단 LOC 매수' });
  }
  return { originalQuantity: account.quantity, round, starPercent, targetPrice, locPrice, quarterQuantity,
    limitQuantity: account.quantity - quarterQuantity, exhausted,
    buys: exhausted ? [] : budgets.map(order => ({ limit: order.limit, budget: order.budget, quantity: order.limit > 0 ? Math.floor(order.budget / order.limit) : 0, reason: order.reason })) };
}
export function createInfiniteTrader(settings: InfiniteStrategy) {
  validateInfinite(settings);
  let oneBuy = settings.capital / settings.splits;
  let quarterMode = false;
  function tradeDay(account: Account, bar: ExecutionBar): { trades: Trade[]; state: InfiniteState } {
    const trades: Trade[] = [];
    let cashShortage = false;
    if (account.quantity === 0) {
      const filled = buy(account, openingPrice(bar), Math.min(oneBuy, account.cash));
      if (filled.quantity > 0) { trades.push({ date: bar.date, side: 'BUY', price: openingPrice(bar), ...filled, realized: 0, reason: isEstimatedClose(bar) ? 'V3 최초·새 사이클 추정 종가 매수' : 'V3 최초·새 사이클 시가 매수', orderType: isEstimatedClose(bar) ? 'CLOSE_ESTIMATE' : 'OPEN' }); }
      quarterMode = false;
      return { trades, state: { kind: 'infinite', round: 0, mode: 'normal', oneBuy, starPercent: settings.target, cashShortage: filled.quantity === 0 } };
    }
    // 주문 가격·수량은 당일 OHLC를 읽기 전에 전일 확정 장부로 생성한다.
    const plan = planInfinite(account, oneBuy, quarterMode, settings);
    const priorCash = account.cash;
    const executeSale = (quantity: number, price: number, reason: string, orderType: 'LOC' | 'LIMIT' | 'MOC') => {
      if (quantity <= 0) { return; }
      const filled = sell(account, price, Math.min(quantity, account.quantity));
      trades.push({ date: bar.date, side: 'SELL', price, quantity: filled.quantity, amount: filled.amount, realized: filled.realized, reason, orderType });
    };
    const targetFill = limitSellPrice(bar, plan.targetPrice);
    if (plan.limitQuantity > 0 && targetFill !== undefined) {
      executeSale(plan.limitQuantity, targetFill, 'V3 목표 지정가 매도', 'LIMIT');
    }
    if (plan.exhausted) {
      // 종가를 미리 보고 MOC를 선택하지 않도록 소진 상태에서 무조건 사전 예약한다.
      executeSale(plan.quarterQuantity, bar.close, 'V3 원금 소진 사전 예약 1/4 MOC', 'MOC');
      // Keep the integer quarter rule for holdings below four shares, but
      // expose that this MOC cannot replenish exhausted cash.
      cashShortage = plan.quarterQuantity === 0 && account.quantity > 0 && account.cash <= 0;
      quarterMode = bar.close < plan.locPrice && account.quantity > 0;
    } else {
      if (bar.close >= plan.locPrice) {
        executeSale(plan.quarterQuantity, bar.close, quarterMode ? 'V3 쿼터 복귀 LOC 매도' : 'V3 별지점 LOC 매도', 'LOC');
        quarterMode = false;
      }
      let reservedCash = priorCash;
      for (const order of plan.buys) {
        if (order.limit <= 0 || bar.close > order.limit || order.quantity <= 0) { continue; }
        const filled = buy(account, bar.close, reservedCash, order.quantity);
        reservedCash -= filled.amount;
        cashShortage ||= filled.quantity < order.quantity;
        if (filled.quantity > 0) { trades.push({ date: bar.date, side: 'BUY', price: bar.close, ...filled, realized: 0,
          reason: order.reason, orderType: 'LOC' }); }
      }
      // Original table: one common lower ladder supplements the complete
      // base order, with limit(n) = floor((oneBuy/n)/tick)*tick for total n.
      // Count qualifying predeclared rows without allocating a row per share.
      if (plan.buys.length && plan.buys.every(order => order.limit > 0 && bar.close <= order.limit)) {
        const closingTick = Math.ceil(bar.close / settings.tick - 1e-10) * settings.tick;
        const baseQuantity = plan.buys.reduce((sum, order) => sum + order.quantity, 0);
        const quantity = Math.max(0, Math.floor(oneBuy / closingTick + 1e-10) - baseQuantity);
        if (!Number.isSafeInteger(quantity)) { throw new Error('V3 추가 LOC 수량이 안전한 정수 범위를 넘었습니다.'); }
        if (quantity > 0) {
          const filled = buy(account, bar.close, reservedCash, quantity);
          cashShortage ||= filled.quantity < quantity;
          if (filled.quantity > 0) { trades.push({ date: bar.date, side: 'BUY', price: bar.close, ...filled, realized: 0,
            reason: 'V3 회당 정액 보완 사전 예약 1주 LOC 사다리 묶음', orderType: 'LOC' }); }
        }
      }
    }
    for (const trade of trades) { if (trade.side === 'SELL' && trade.realized > 0) { oneBuy += trade.realized * settings.reinvestment / settings.splits; } }
    return { trades, state: { kind: 'infinite', round: plan.round, mode: quarterMode ? 'quarter' : 'normal', oneBuy,
      starPercent: plan.starPercent, cashShortage } };
  }
  function getState(account: Account): InfiniteState {
    const round = account.quantity > 0 ? Math.ceil(account.cost / oneBuy * 10 - 1e-10) / 10 : 0;
    return {kind:'infinite',round,mode:quarterMode?'quarter':'normal',oneBuy,
      starPercent:settings.target*(1-2*round/settings.splits),cashShortage:false};
  }
  return { tradeDay, getState };
}
