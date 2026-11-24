import { buy, deposit, sell, withdraw } from './account.ts';
import type { Account } from './account.ts';
import type { ExecutionBar } from '../data/prices.ts';
import { isEstimatedClose, openingPrice, limitBuyPrice, limitSellPrice } from '../data/prices.ts';
import { isDate } from '../data/market.ts';
import type { Trade } from './simpleBacktest.ts';
export interface VrStrategy {
  kind: 'vr'; capital: number; mode: 'hold' | 'accumulate' | 'withdraw'; advanced: boolean;
  initialStockFraction: number; initialValue: number; gradient: number; annualGradientIncrease: number;
  band: number; cycleDays: number; poolUse: number; flowAmount: number; flowDays: number; withdrawalStart?: string; tick: number;
}
export interface VrState {
  kind: 'vr'; value: number; lower: number; upper: number; gradient: number; cycleBudget: number;
  mode: VrStrategy['mode']; advanced: boolean; cycleChanged: boolean; cashShortage: boolean; unfundedWithdrawals: number;
}
export function validateVr(settings: VrStrategy) {
  const fractions = [settings.initialStockFraction, settings.band, settings.poolUse];
  if (!Number.isFinite(settings.capital) || settings.capital <= 0 || !['hold', 'accumulate', 'withdraw'].includes(settings.mode)
    || typeof settings.advanced !== 'boolean' || fractions.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || settings.initialStockFraction === 0 || settings.band <= 0 || settings.band >= 1
    || !Number.isFinite(settings.initialValue) || settings.initialValue < 0
    || !Number.isFinite(settings.gradient) || settings.gradient < 1 || settings.gradient > 10000
    || !Number.isFinite(settings.annualGradientIncrease) || settings.annualGradientIncrease < 0 || settings.annualGradientIncrease > 100
    || !Number.isFinite(settings.flowAmount) || settings.flowAmount < 0
    || [settings.cycleDays, settings.flowDays].some(value => !Number.isInteger(value) || value < 1 || value > 366)
    || !Number.isFinite(settings.tick) || settings.tick <= 0 || (settings.withdrawalStart !== undefined && !isDate(settings.withdrawalStart))) {
    throw new Error('VR 설정 오류: 배분·V·G·밴드·주기·Pool 한도·입출금·가격 단위를 확인하세요.');
  }
}
export function nextVrValue(value: number, pool: number, previousStock: number, gradient: number, advanced: boolean) {
  if ([value, pool, previousStock].some(item => !Number.isFinite(item) || item < 0) || !Number.isFinite(gradient) || gradient < 1) {
    throw new Error('VR V 갱신 입력 오류입니다.');
  }
  const correction = advanced ? (previousStock - value) / (2 * Math.sqrt(gradient)) : 0;
  const next = Math.max(0, value + pool / gradient + correction);
  if (!Number.isFinite(next)) { throw new Error('VR 목표 V가 수치 범위를 넘었습니다.'); }
  return next;
}
export interface VrOrderBook { quantity: number; bought: number; sold: number }
export function executeVrOrders(account: Account, bar: ExecutionBar, value: number, settings: VrStrategy, cycleBudget: number, book?: VrOrderBook) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(value * (1 + settings.band)) || !Number.isFinite(cycleBudget) || cycleBudget < 0) {
    throw new Error('VR 목표 V 또는 Pool 예산이 유효 범위를 벗어났습니다.');
  }
  const originalQuantity = account.quantity;
  const reservedQuantity = book?.quantity ?? originalQuantity;
  const previousBought = book?.bought ?? 0;
  const previousSold = book?.sold ?? 0;
  const originalCash = account.cash;
  const lower = value * (1 - settings.band);
  const upper = value * (1 + settings.band);
  const trades: Trade[] = [];
  // Official VR5.0 overview /38944: the 176→181 share example rounds
  // 10509.46 / n to the nearest cent (59.71, 59.38, 59.04, 58.71, 58.39).
  // Apply the same rounding symmetrically to sales; other ticks are user settings.
  const round = (price: number) => Math.floor(price / settings.tick + 0.5 + 1e-10) * settings.tick;
  const down = (price: number) => Math.floor(price / settings.tick + 1e-10) * settings.tick;
  const up = (price: number) => Math.ceil(price / settings.tick - 1e-10) * settings.tick;
  let sold = 0;
  // 일봉으로 장중 순서를 알 수 없으므로 원래 보유분 매도를 먼저 기장한다. 매수 예산은 별도로 고정한다.
  while (sold < originalQuantity && previousSold + sold < reservedQuantity && upper > 0) {
    const denominator = reservedQuantity - previousSold - sold;
    const limit = round(upper / denominator);
    if (limit <= 0) { break; }
    const price = limitSellPrice(bar, limit);
    if (price === undefined) { break; }
    const groupLimit = limit <= openingPrice(bar) ? down(openingPrice(bar)) : limit;
    if (groupLimit <= 0) { break; }
    // round(upper/n) <= groupLimit iff upper/n < groupLimit + half a tick.
    const lastDenominator = Math.floor(upper / (groupLimit + settings.tick / 2) + 1e-10) + 1;
    const wanted = Math.min(originalQuantity - sold, denominator, Math.max(1, denominator - lastDenominator + 1));
    const filled = sell(account, price, wanted);
    trades.push({ date: bar.date, side: 'SELL', price, quantity: filled.quantity, amount: filled.amount, realized: filled.realized,
      orderType: 'LIMIT', reason: 'VR 상단 1주 예약매도 사다리 묶음' });
    sold += wanted;
  }
  const buyBase = Math.max(1, reservedQuantity);
  let bought = 0;
  let spent = 0;
  let cashShortage = false;
  while (lower > 0) {
    const denominator = buyBase + previousBought + bought;
    const limit = round(lower / denominator);
    if (limit <= 0) { break; }
    const price = limitBuyPrice(bar, limit);
    if (price === undefined) { break; }
    const groupLimit = limit >= openingPrice(bar) ? up(openingPrice(bar)) : limit;
    // round(lower/n) >= groupLimit iff lower/n >= groupLimit - half a tick.
    const lastDenominator = Math.floor(lower / (groupLimit - settings.tick / 2) + 1e-10);
    const wanted = Math.min(Number.MAX_SAFE_INTEGER - account.quantity, Math.max(1, lastDenominator - denominator + 1));
    if (!Number.isSafeInteger(wanted) || wanted <= 0) { throw new Error('VR 주문 수량이 안전한 정수 범위를 넘었습니다.'); }
    const available = Math.max(0, Math.min(cycleBudget - spent, originalCash - spent));
    const filled = buy(account, price, available, wanted);
    spent += filled.amount;
    bought += filled.quantity;
    if (filled.quantity > 0) {
      trades.push({ date: bar.date, side: 'BUY', price, ...filled, realized: 0, orderType: 'LIMIT', reason: 'VR 하단 1주 예약매수 사다리 묶음' });
    }
    if (filled.quantity < wanted) { cashShortage = true; break; }
  }
  if (book) { book.bought += bought; book.sold += sold; }
  return { trades, spent, cashShortage };
}
const millisecondsPerDay = 86400000;
function completedYears(start: string, current: string) {
  const years = Number(current.slice(0, 4)) - Number(start.slice(0, 4));
  let anniversary = `${current.slice(0, 4)}${start.slice(4)}`;
  if (!isDate(anniversary)) { anniversary = `${current.slice(0, 4)}-02-28`; }
  return years - (current < anniversary ? 1 : 0);
}
export interface VrFlowHooks {
  approveDeposit?: (date: string, requested: number) => number;
  withdraw?: (account: Account, date: string, requested: number) => { gross: number; net: number; tax: number };
  allowEmptyInitial?: boolean;
}
export function createVrTrader(settings: VrStrategy, hooks: VrFlowHooks = {}) {
  validateVr(settings);
  let initialized = false;
  let start = '';
  let nextCycle = 0;
  let nextFlow = 0;
  let value = 0;
  let gradient = settings.gradient;
  let cycleBudget = 0;
  let unfundedWithdrawals = 0;
  let cycleChanged = false;
  let orderBook: VrOrderBook = { quantity: 0, bought: 0, sold: 0 };
  function prepareDay(account: Account, date: string, previousStock: number) {
    cycleChanged = false;
    if (!initialized) { return { deposited: 0, withdrawn: 0, netWithdrawn: 0, withdrawalTax: 0 }; }
    // Corporate actions change the account before this callback. Adjust the
    // reserved ladder units too; rebuild when a reverse split creates half rows.
    const expectedQuantity = orderBook.quantity + orderBook.bought - orderBook.sold;
    if (expectedQuantity > 0 && expectedQuantity !== account.quantity) {
      const ratio = account.quantity / expectedQuantity;
      const adjusted = { quantity: orderBook.quantity * ratio, bought: orderBook.bought * ratio, sold: orderBook.sold * ratio };
      orderBook = Object.values(adjusted).every(Number.isSafeInteger) ? adjusted : { quantity: account.quantity, bought: 0, sold: 0 };
    }
    const day = Date.parse(date);
    if (day >= nextCycle) {
      gradient = settings.gradient + completedYears(start, date) * settings.annualGradientIncrease;
      value = nextVrValue(value, account.cash, previousStock, gradient, settings.advanced);
      do { nextCycle += settings.cycleDays * millisecondsPerDay; } while (nextCycle <= day);
      cycleBudget = account.cash * settings.poolUse;
      orderBook = { quantity: account.quantity, bought: 0, sold: 0 };
      cycleChanged = true;
    }
    let deposited = 0;
    let withdrawn = 0;
    let netWithdrawn = 0;
    let withdrawalTax = 0;
    if (settings.mode !== 'hold') {
      while (day >= nextFlow) {
        if (settings.mode === 'accumulate') {
          const approved = hooks.approveDeposit?.(date, settings.flowAmount) ?? settings.flowAmount;
          deposit(account, approved);
          deposited += approved;
          value += approved;
          cycleBudget += approved * settings.poolUse;
        } else {
          const paid = hooks.withdraw?.(account, date, settings.flowAmount);
          const gross = paid?.gross ?? withdraw(account, settings.flowAmount);
          withdrawn += gross;
          netWithdrawn += paid?.net ?? gross;
          withdrawalTax += paid?.tax ?? 0;
          value = Math.max(0, value - gross);
          cycleBudget = Math.min(cycleBudget, account.cash);
          unfundedWithdrawals += settings.flowAmount - gross;
        }
        nextFlow += settings.flowDays * millisecondsPerDay;
      }
    }
    if (cycleChanged) { cycleBudget = account.cash * settings.poolUse; }
    return { deposited, withdrawn, netWithdrawn, withdrawalTax };
  }
  function getState(cashShortage = false): VrState {
    return { kind:'vr',value,lower:value*(1-settings.band),upper:value*(1+settings.band),gradient,cycleBudget,
      mode:settings.mode,advanced:settings.advanced,cycleChanged,cashShortage,unfundedWithdrawals };
  }
  function applyExternalWithdrawal(account: Account, gross: number) {
    if (!initialized) { return; }
    value = Math.max(0,value-gross);
    cycleBudget = Math.min(cycleBudget,account.cash);
    orderBook = { quantity:account.quantity,bought:0,sold:0 };
  }
  function tradeDay(account: Account, bar: ExecutionBar): { trades: Trade[]; state: VrState } {
    let trades: Trade[] = [];
    let cashShortage = false;
    if (!initialized) {
      const filled = buy(account, openingPrice(bar), Math.min(settings.capital,account.cash) * settings.initialStockFraction);
      if (filled.quantity === 0 && !hooks.allowEmptyInitial) { throw new Error('VR 초기 주식 배정액으로 1주를 살 수 없습니다. 투자금·배분을 조정하세요.'); }
      trades = filled.quantity > 0 ? [{ date: bar.date, side: 'BUY', price: openingPrice(bar), ...filled, realized: 0, orderType: isEstimatedClose(bar) ? 'CLOSE_ESTIMATE' : 'OPEN', reason: isEstimatedClose(bar) ? 'VR 초기 주식 배분 추정 종가 정수주 매수' : 'VR 초기 주식 배분 정수주 매수' }] : [];
      cashShortage = filled.quantity === 0;
      value = settings.initialValue > 0 ? settings.initialValue : filled.amount;
      cycleBudget = account.cash * settings.poolUse;
      orderBook = { quantity: account.quantity, bought: 0, sold: 0 };
      initialized = true;
      start = bar.date;
      nextCycle = Date.parse(start) + settings.cycleDays * millisecondsPerDay;
      nextFlow = Date.parse(start) + settings.flowDays * millisecondsPerDay;
      if (settings.withdrawalStart && settings.mode === 'withdraw') { nextFlow = Math.max(nextFlow, Date.parse(settings.withdrawalStart)); }
    } else {
      const result = executeVrOrders(account, bar, value, settings, cycleBudget, orderBook);
      trades = result.trades;
      cycleBudget = Math.max(0, cycleBudget - result.spent);
      cashShortage = result.cashShortage;
    }
    if (!Number.isFinite(value * (1 + settings.band)) || !Number.isFinite(cycleBudget)) { throw new Error('VR 상태가 수치 범위를 넘었습니다.'); }
    return { trades, state: getState(cashShortage) };
  }
  return { prepareDay, tradeDay, getState, applyExternalWithdrawal };
}
