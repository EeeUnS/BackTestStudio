import type { KrwResult } from './fx.ts';
import { createVrTrader } from './vr.ts';
import type { VrStrategy, VrState } from './vr.ts';
import { createInfiniteTrader } from './infinite.ts';
import type { InfiniteStrategy, InfiniteState } from './infinite.ts';
import { isDate } from '../data/market.ts';
import { splitFactorAfter } from '../data/execution.ts';
import { movingAverage } from '../chart/data.ts';
import { isEstimatedClose, openingPrice } from '../data/prices.ts';
import type { ExecutionBar } from '../data/prices.ts';
import type { Split, SymbolCode } from '../data/market.ts';
import type { ReferenceData } from '../data/reference.ts';
import type { AccountKind, AccountReport, WithdrawalRequest } from '../accounts/types.ts';
import { createAccountController } from '../accounts/ledger.ts';
import type { BusinessCalendar } from '../tax/types.ts';
import { accrueDividend, applySplit, assertAccount, buy, createAccount, deposit, payDividend, sell, settleSales, valueAccount } from './account.ts';
import type { Account } from './account.ts';
import { cagr, xirr } from './metrics.ts';
import type { CashFlow, Metric } from './metrics.ts';
import { dailyCostLoss, worseCostLoss } from './costLoss.ts';
import type { CostLossPoint } from './costLoss.ts';

export interface PayableDistribution { exDate: string; payDate: string; amount: number }
export interface ExecutionData {
  symbol?: SymbolCode;
  currency?: 'USD' | 'KRW';
  settlementCalendar?: BusinessCalendar;
  warnings?: string[];
  version: string;
  bars: ExecutionBar[];
  splits: Split[];
  distributions: PayableDistribution[];
  nasdaq?: ReferenceData;
}
export type SimpleStrategy = { kind: 'hold'; capital: number }
  | { kind: 'sma200'; capital: number }
  | { kind: 'nasdaq-sma200'; capital: number }
  | { kind: 'dca'; contribution: number; interval: 'weekly' | 'biweekly' | 'monthly' };
export interface BacktestRequest { reportInKrw?: boolean; account?: AccountKind; withdrawals?: WithdrawalRequest[]; start: string; end: string; strategy: SimpleStrategy | InfiniteStrategy | VrStrategy }
export interface Trade { estimated?: true; date: string; side: 'BUY' | 'SELL'; price: number; quantity: number; amount: number; realized: number; reason: string; orderType?: 'OPEN' | 'LOC' | 'MOC' | 'LIMIT' | 'CLOSE_ESTIMATE' }
export interface Snapshot extends Account {
  costLoss?: CostLossPoint;
  estimated?: true;
  strategyState?: InfiniteState | VrState;
  date: string;
  stock: number;
  total: number;
  averageCost: number;
  unrealized: number;
  profit: number;
  contribution: number;
  withdrawal: number;
  contributionRequested?: number;
  contributionBlocked?: number;
  withdrawalTax?: number;
  withdrawalNet?: number;
  openingBeforeFlow: number;
  openingAfterFlow: number;
  growth: number;
  drawdown: number;
}
export interface BacktestResult {
  accountReport?: AccountReport;
  comparison?: import('./benchmark.ts').HoldingComparison;
  krw?: KrwResult;
  krwError?: string;
  warnings: string[];
  start: string;
  end: string;
  dataVersion: string;
  days: Snapshot[];
  trades: Trade[];
  flows: CashFlow[];
  metrics: { twr: number; mdd: number; maxCostLoss?: CostLossPoint; xirr: Metric; cagr: Metric; returnOnContributions: number };
}
function validateExecutionData(data: ExecutionData) {
  if (!data.version || data.bars.length === 0) { throw new Error('체결 데이터가 없습니다.'); }
  let last = '';
  for (const bar of data.bars) {
    const prices = isEstimatedClose(bar) ? [bar.close] : [bar.open, bar.high, bar.low, bar.close];
    if (!isDate(bar.date) || bar.date <= last || prices.some(value => !Number.isFinite(value) || value <= 0)) {
      throw new Error('체결 데이터 날짜·가격 오류입니다.');
    }
    if (isEstimatedClose(bar)) {
      if (['open', 'high', 'low', 'volume'].some(key => key in bar)) { throw new Error('추정 종가에 가상 OHLC·거래량을 섞을 수 없습니다.'); }
    } else if (bar.high < Math.max(bar.open, bar.low, bar.close) || bar.low > Math.min(bar.open, bar.high, bar.close)) {
      throw new Error('체결 데이터 OHLC 오류입니다.');
    }
    last = bar.date;
  }
  for (const event of data.splits) {
    if (!isDate(event.date) || !Number.isFinite(event.ratio) || event.ratio <= 0) { throw new Error('분할 입력 오류입니다.'); }
  }
  for (const event of data.distributions) {
    if (!isDate(event.exDate) || !isDate(event.payDate) || event.payDate < event.exDate || !Number.isFinite(event.amount) || event.amount <= 0) {
      throw new Error('분배금 권리락일·지급일·금액 입력 오류입니다.');
    }
  }
  const tradingDates = new Set(data.bars.map(bar => bar.date));
  const first = data.bars[0].date;
  const end = data.bars.at(-1)!.date;
  for (const date of [...data.splits.map(event => event.date), ...data.distributions.map(event => event.exDate)]) {
    if (date >= first && date <= end && !tradingDates.has(date)) {
      throw new Error('기업행동 기준일의 거래 봉이 없습니다. 결측을 다음 거래일로 임의 이동하지 않습니다.');
    }
  }
  const splitDates = data.splits.map(event => event.date);
  const dividendDates = data.distributions.map(event => event.exDate);
  if (new Set(splitDates).size !== splitDates.length || new Set(dividendDates).size !== dividendDates.length) {
    throw new Error('기업행동 중복 날짜입니다. 같은 날 분배금은 공급 계층에서 합산해야 합니다.');
  }
}
export function contributionDates(bars: { date: string }[], start: string, interval: 'weekly' | 'biweekly' | 'monthly') {
  if (!isDate(start) || !['weekly', 'biweekly', 'monthly'].includes(interval)) { throw new Error('적립 일정 입력 오류입니다.'); }
  const eligible = bars.filter(bar => bar.date >= start);
  const dates = new Set<string>();
  if (eligible.length === 0) { return dates; }
  dates.add(eligible[0].date);
  if (interval === 'monthly') {
    let previousMonth = eligible[0].date.slice(0, 7);
    for (const bar of eligible) {
      const month = bar.date.slice(0, 7);
      if (month !== previousMonth) { dates.add(bar.date); previousMonth = month; }
    }
  } else {
    const step = (interval === 'weekly' ? 7 : 14) * 86400000;
    let next = Date.parse(start) + step;
    for (const bar of eligible) {
      const date = Date.parse(bar.date);
      if (date >= next) {
        dates.add(bar.date);
        // 긴 휴장 뒤에도 과거 미실행 납입을 같은 날 여러 번 수행하지 않는다.
        do { next += step; } while (next <= date);
      }
    }
  }
  return dates;
}
function sma200Orders(prices: { date: string; close: number }[], bars: ExecutionBar[]) {
  const period = 200;
  const averages = movingAverage(prices, period);
  const orders = new Map<string, Trade['side']>();
  let offset = 0;
  let above = false;
  let previousTarget = false;
  for (const bar of bars) {
    while (offset < averages.length && averages[offset].time < bar.date) {
      const average = averages[offset];
      const difference = prices[offset + period - 1].close - average.value;
      if (Math.abs(difference) > average.value * 1e-12) { above = difference > 0; }
      offset++;
    }
    if (above !== previousTarget) { orders.set(bar.date, above ? 'BUY' : 'SELL'); }
    previousTarget = above;
  }
  return orders;
}
export function createBacktestRunner(data: ExecutionData, request: BacktestRequest) {
  validateExecutionData(data);
  if (!isDate(request.start) || !isDate(request.end) || request.end < request.start) { throw new Error('백테스트 기간 오류입니다.'); }
  const strategy = request.strategy;
  if(request.withdrawals!==undefined&&!Array.isArray(request.withdrawals)){throw new Error('중간 인출 일정은 배열이어야 합니다.');}
  if (data.symbol === 'QQQ5.L' && ((request.account && request.account !== 'general') || request.withdrawals?.length)) {
    throw new Error('QQQ5는 일반계좌와 전략 자체 입출금만 지원합니다.');
  }
  if(data.currency!==undefined&&!['USD','KRW'].includes(data.currency)){throw new Error('계좌 계산 통화 오류입니다.');}
  if (!['hold', 'dca', 'sma200', 'nasdaq-sma200', 'infinite', 'vr'].includes(strategy.kind)) { throw new Error('지원하지 않는 전략입니다.'); }
  const funding = strategy.kind === 'dca' ? strategy.contribution : strategy.capital;
  if (!Number.isFinite(funding) || funding <= 0) { throw new Error('투자금은 양의 유한 숫자여야 합니다.'); }
  const bars = data.bars.filter(bar => bar.date >= request.start);
  if (bars.length === 0) { throw new Error('선택 기간에 거래일이 없습니다.'); }
  if (request.start < data.bars[0].date || request.end > data.bars.at(-1)!.date) {
    throw new Error('요청 기간이 데이터 범위를 벗어났습니다. 가능한 기간을 먼저 선택하세요.');
  }
  const accountFeatures = request.account !== undefined || Boolean(request.withdrawals?.length);
  const controller = accountFeatures ? createAccountController({kind:request.account??'general',openedAt:request.start,
    currency:data.currency??'USD',symbol:data.symbol,requests:request.withdrawals,calendar:data.settlementCalendar}) : undefined;
  const effectiveCapital = strategy.kind === 'dca' ? 0 : Math.min(strategy.capital,controller?.contributions.remaining(bars[0].date)??Infinity);
  const infinite = strategy.kind === 'infinite' ? createInfiniteTrader({...strategy,capital:effectiveCapital}) : undefined;
  const vr = strategy.kind === 'vr' ? createVrTrader({...strategy,capital:effectiveCapital},controller?{
    approveDeposit:(date,amount)=>controller.depositApproval(date,amount,'vr'),
    withdraw:(account,date,amount)=>controller.periodicWithdrawal(account,date,amount),allowEmptyInitial:(request.account??'general')!=='general'||Boolean(request.withdrawals?.length),
  }:{}) : undefined;
  const scheduled = strategy.kind === 'dca' ? contributionDates(bars, request.start, strategy.interval) : new Set([bars[0].date]);
  const usesNasdaq = strategy.kind === 'nasdaq-sma200';
  if (usesNasdaq && data.nasdaq?.id !== 'NDX') { throw new Error('나스닥100 지수 시세가 필요합니다.'); }
  const smaPrices = usesNasdaq ? data.nasdaq!.points.map(({ date, value }) => ({ date, close: value }))
    : strategy.kind === 'sma200' ? data.bars.map(bar => ({ date: bar.date, close: bar.close / splitFactorAfter(bar.date, data) })) : undefined;
  const smaOrders = smaPrices && sma200Orders(smaPrices, bars);
  const smaLabel = usesNasdaq ? '나스닥100 ' : '';
  const splits = [...data.splits].filter(event => event.date >= bars[0].date).sort((a, b) => a.date.localeCompare(b.date));
  const distributions = [...data.distributions].filter(event => event.exDate >= bars[0].date).sort((a, b) => a.exDate.localeCompare(b.exDate));
  const pending: { payDate: string; amount: number }[] = [];
  let splitIndex = 0;
  let dividendIndex = 0;
  const account = createAccount();
  const days: Snapshot[] = [];
  const trades: Trade[] = [];
  const flows: CashFlow[] = [];
  let growth = 1;
  let peak = 1;
  let previousTotal = 0;
  function step(bar: ExecutionBar) {
    const firstTrade = trades.length;
    if(controller)controller.releaseNormalSales(account);else settleSales(account);
    while (splitIndex < splits.length && splits[splitIndex].date <= bar.date) {
      const ratio=splits[splitIndex++].ratio; applySplit(account, ratio);
    }
    while (dividendIndex < distributions.length && distributions[dividendIndex].exDate <= bar.date) {
      const distribution = distributions[dividendIndex++];
      pending.push({ payDate: distribution.payDate, amount: accrueDividend(account, distribution.amount) });
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].payDate <= bar.date) { payDividend(account, pending[i].amount); pending.splice(i, 1); }
    }
    const beforeFlow = valueAccount(account, openingPrice(bar)).total;
    if (previousTotal > 0) { growth *= beforeFlow / previousTotal; }
    const contributionEntryStart=controller?.contributions.entries.length??0;
    const requestedContribution = scheduled.has(bar.date) ? funding : 0;
    let contribution = requestedContribution > 0 ? controller?.depositApproval(bar.date,requestedContribution,strategy.kind==='dca'?'dca':'initial')??requestedContribution : 0;
    if (contribution > 0) {
      deposit(account, contribution);
      flows.push({ date: bar.date, amount: -contribution });
    }
    const vrFlow = vr?.prepareDay(account, bar.date, days.at(-1)?.stock ?? 0) ?? { deposited: 0, withdrawn: 0, netWithdrawn:0, withdrawalTax:0 };
    if (vrFlow.deposited > 0) { flows.push({ date: bar.date, amount: -vrFlow.deposited }); }
    if (vrFlow.netWithdrawn > 0) { flows.push({ date: bar.date, amount: vrFlow.netWithdrawn }); }
    contribution += vrFlow.deposited;
    const positionBeforeTrades = { quantity: account.quantity, cost: account.cost };
    const manual = controller?.process(account,bar) ?? {gross:0,net:0,tax:0,trades:[],forcedSale:false};
    trades.push(...manual.trades);
    if(manual.net>0)flows.push({date:bar.date,amount:manual.net});
    if(manual.gross>0||manual.forcedSale)vr?.applyExternalWithdrawal(account,manual.gross);
    let strategyState: InfiniteState | VrState | undefined;
    if(manual.forcedSale) {
      strategyState=infinite?.getState(account)??vr?.getState();
    } else if (infinite) {
      const day = infinite.tradeDay(account, bar);
      trades.push(...day.trades);
      strategyState = day.state;
    } else if (vr) {
      const day = vr.tradeDay(account, bar);
      trades.push(...day.trades);
      strategyState = day.state;
    } else if (smaOrders) {
      const side = smaOrders.get(bar.date);
      if (side && (side === 'BUY' || account.quantity > 0)) {
        const price = openingPrice(bar);
        const trade = side === 'BUY' ? { ...buy(account, price, account.cash), realized: 0 } : sell(account, price, account.quantity);
        if (trade.quantity > 0) {
          trades.push({ date: bar.date, side, price, quantity: trade.quantity, amount: trade.amount,
            realized: trade.realized, orderType: isEstimatedClose(bar) ? 'CLOSE_ESTIMATE' : 'OPEN',
            reason: side === 'BUY' ? `${smaLabel}종가가 200일선 위 · 정수주 매수` : `${smaLabel}종가가 200일선 아래 · 전량 매도` });
        }
      }
    } else if (contribution > 0) {
      const trade = buy(account, openingPrice(bar), account.cash);
      if (trade.quantity > 0) {
        trades.push({ date: bar.date, side: 'BUY', price: openingPrice(bar), quantity: trade.quantity, amount: trade.amount, realized: 0,
          reason: strategy.kind === 'hold' ? '최초 정수주 매수' : '정기 납입·잔액 합산 매수' });
      }
    }
    if (isEstimatedClose(bar)) {
      for (let index = firstTrade; index < trades.length; index++) {
        trades[index] = { ...trades[index], estimated: true, reason: `${trades[index].reason} · 추정 종가 판정` };
      }
    }
    const withdrawnGross=vrFlow.withdrawn+manual.gross;
    const afterFlow = beforeFlow + contribution - withdrawnGross;
    const value = valueAccount(account, bar.close);
    const costLoss = dailyCostLoss(positionBeforeTrades, trades.slice(firstTrade), bar.date, bar.close, isEstimatedClose(bar));
    const contributionEntries=controller?.contributions.entries.slice(contributionEntryStart)??[];
    if (afterFlow > 0) { growth *= value.total / afterFlow; }
    peak = Math.max(peak, growth);
    const drawdown = growth / peak - 1;
    assertAccount(account);
    const decomposition = account.realized + value.unrealized + account.dividendIncome;
    // 전액 인출 후 자산이 0이어도 누적 금액의 덧셈·뺄셈 오차는 남는다.
    const accumulatedScale = Math.max(1, account.deposited, account.withdrawn, Math.abs(account.realized), account.cost);
    const roundingAllowance = Number.EPSILON * 64 * accumulatedScale * (days.length + 1);
    if (Math.abs(value.profit - decomposition) > 1e-7 * Math.max(1, value.total) + roundingAllowance) {
      throw new Error(`일별 자산·손익 보존 검산 실패입니다. ${JSON.stringify({ date: bar.date, profit: value.profit, decomposition, total: value.total, deposited: account.deposited, withdrawn: account.withdrawn })}`);
    }
    days.push({ ...account, costLoss, ...(isEstimatedClose(bar) ? { estimated: true as const } : {}), ...(strategyState ? { strategyState } : {}), date: bar.date, stock: value.stock, total: value.total, averageCost: value.averageCost,
      unrealized: value.unrealized, profit: value.profit, contribution, withdrawal: withdrawnGross,
      ...(controller?{contributionRequested:contributionEntries.reduce((sum,entry)=>sum+entry.requested,0),contributionBlocked:contributionEntries.reduce((sum,entry)=>sum+entry.blocked,0),withdrawalTax:vrFlow.withdrawalTax+manual.tax,withdrawalNet:vrFlow.netWithdrawn+manual.net}:{}),
      openingBeforeFlow: beforeFlow, openingAfterFlow: afterFlow, growth, drawdown });
    previousTotal = value.total;
  }
  let failed = false;
  function run(endDate: string): BacktestResult {
    if (failed) { throw new Error('이전 일별 계산이 실패한 실행기는 다시 사용할 수 없습니다. 새로 계산하세요.'); }
    if (!isDate(endDate) || endDate < request.start || endDate > data.bars.at(-1)!.date) { throw new Error('요청 기간이 데이터 범위를 벗어났습니다. 가능한 기간을 먼저 선택하세요.'); }
    if (bars[0].date > endDate) { throw new Error('선택 기간에 거래일이 없습니다.'); }
    while (days.length < bars.length && bars[days.length].date <= endDate) {
      // 체결 중 예외가 나면 부분 변경된 계좌를 다시 사용하지 않는다.
      failed = true;
      step(bars[days.length]);
      failed = false;
    }
    const selectedDays = days.filter(day => day.date <= endDate);
    const final = selectedDays.at(-1)!;
    const selectedTrades = trades.filter(trade => trade.date <= final.date);
    const selectedFlows = flows.filter(flow => flow.date <= final.date);
    const start = bars[0].date;
    const end = final.date;
    const accountReport=controller?.report(endDate);
    const strategyWarnings = vr ? ['VR5.0 기본공식·Pool 한도·예약매수표는 https://cafe.naver.com/infinitebuying/38944 원문과 대조했습니다(2026-11-13). 실력공식과 E 시점은 원저자 https://www.youtube.com/watch?v=cIp8G3AVtnM 의55~65초 수식·마지막 평가금 표를 직접 대조했습니다. 직전 종가의 주식 평가액 E, V 갱신 후 예정 입출금, 주기별 Pool 한도와 주기 시작 장부로 예약하는1주 사다리(소진한 주문은 다음 주기 전 재사용하지 않음), 같은 날 양방향 체결 시 기존 보유분 매도 우선 기장, 최초일 초기 배분만 실행, 미지급 인출 분리, 고정 호가 최근접 반올림(매도는 매수표의 대칭 확장)을 적용합니다. 일봉만으로 장중 순서를 확정할 수 없습니다.'] : [];
    return { start, end, ...(accountReport?{accountReport}:{}), dataVersion: data.version, days: selectedDays, trades: selectedTrades, flows: selectedFlows, warnings: [...(data.warnings ?? []), ...(accountReport?.warnings??[]), ...(selectedDays.some(day => day.estimated) ? ['상장 전 추정 종가 체결 포함: 최초·정기 매수는 당일 추정 종가, LOC/MOC도 종가 판정, 지정가는 종가가 조건을 만족할 때 종가로만 체결합니다. 장중 가격을 생성하지 않습니다. 전일 장부 주문·가용 현금·매도금 잠금은 유지합니다. 상장 첫 실제일 이후 실제 OHLC를 사용합니다.'] : []), ...strategyWarnings, ...(infinite ? ['V3.0 T·별%·반복리·쿼터매도는 https://cafe.naver.com/infinitebuying/59826 원문과 대조했습니다(2026-11-13). 전일 장부로 하단 LOC 추가 주문을 예약하고 소진시1/4 MOC·당일 매수 금지, 손실시 회당 매수금 유지를 적용합니다. 정수주 쿼터 내림, 매수 LOC1틱 아래·추가 사다리 예산/n 호가 내림, 목표 지정가 갭 시가와 매도 우선 기장, 현금 부족 부분 체결은 재현 가정입니다. 이동평균 원가·고정 호가를 사용합니다. 원문의 시간외 지정가 매도는 확보한 정규장 OHLC로 근사하므로 시간외 전용 체결은 재현하지 않습니다. 국내 과거 동적 호가·실제 LOC 미체결·장중 순서도 재현하지 않습니다. QQQ·SPY·TIGER 등 원형 대상 외 종목 적용은 확장 실험입니다.'] : [])],
      metrics: { twr: final.growth - 1, mdd: selectedDays.reduce((minimum, day) => Math.min(minimum, day.drawdown), 0), maxCostLoss: selectedDays.reduce<CostLossPoint | undefined>((worst, day) => worseCostLoss(worst, day.costLoss), undefined), xirr: xirr([...selectedFlows, { date: end, amount: final.total }]),
        cagr: selectedFlows.length === 1 ? cagr(-selectedFlows[0].amount, final.total, start, end) : { available: false, reason: '추가 입출금이 있어 일반 CAGR을 적용하지 않습니다.' },
        returnOnContributions: final.profit / final.deposited } };
  }
  return { run, get calculatedDays() { return days.length; } };
}

export function runBacktest(data: ExecutionData, request: BacktestRequest): BacktestResult {
  return createBacktestRunner(data, request).run(request.end);
}

export function runSimpleBacktest(data: ExecutionData, request: BacktestRequest): BacktestResult {
  if (request.strategy.kind === 'infinite' || request.strategy.kind === 'vr') { throw new Error('단순 전략 실행 경로는 일시불·적립식·200일선 전략만 지원합니다.'); }
  return runBacktest(data, request);
}
