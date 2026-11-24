import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buy, createAccount, deposit, settleSales, withdraw } from '../src/engine/account.ts';
import { createInfiniteTrader, planInfinite } from '../src/engine/infinite.ts';
import type { InfiniteStrategy } from '../src/engine/infinite.ts';
import { runBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData } from '../src/engine/simpleBacktest.ts';
const settings: InfiniteStrategy = { kind: 'infinite', capital: 1000, splits: 4, target: 0.1, reinvestment: 0.5, tick: 0.01 };
const candle = (date: string, open: number, high: number, low: number, close: number) => ({ date, open, high, low, close });
function funded() { const account=createAccount(); deposit(account,1000); return account; }
function near(actual: number, expected: number) { assert(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`); }
test('V3 주문은 당일 가격 없이 전일 원가·T·현금으로 생성, 전반 두 LOC 수량 고정', () => {
  const account=funded(); buy(account,100,200);
  const plan=planInfinite(account,250,false,settings);
  near(plan.round,0.8); near(plan.starPercent,0.06); near(plan.locPrice,106); near(plan.targetPrice,110);
  assert.equal(plan.quarterQuantity,0); assert.equal(plan.limitQuantity,2);
  assert.deepEqual(plan.buys.map(order=>order.quantity),[1,1]);
  assert.equal(account.quantity,2); assert.equal(account.cash,800);
});
test('V3 최초 시가 한 회분 매수·LOC는 저가 통과만으로 체결하지 않고 종가 조건 적용', () => {
  const trader=createInfiniteTrader(settings); const account=funded();
  const first=trader.tradeDay(account,candle('2026-01-02',100,100,90,100));
  assert.equal(first.trades[0].orderType,'OPEN'); assert.equal(account.quantity,2); assert.equal(account.cash,800);
  const second=trader.tradeDay(account,candle('2026-01-05',100,108,80,108));
  assert.equal(second.trades.filter(trade=>trade.side==='BUY').length,0);
  assert.equal(second.trades.length,0); // floor(2/4)=0: no fractional quarter sale.
});
test('V3 반액 두 LOC는 종가에 각 고정 수량 매수하고 T는 남은 원가에서 산출', () => {
  const trader=createInfiniteTrader(settings); const account=funded();
  trader.tradeDay(account,candle('2026-01-02',100,100,100,100));
  const next=trader.tradeDay(account,candle('2026-01-05',100,100,90,90));
  assert.equal(next.trades.length,2); assert(next.trades.every(trade=>trade.orderType==='LOC'&&trade.quantity===1&&trade.price===90));
  assert.equal(account.quantity,4); assert.equal(account.cost,380); assert.equal(account.cash,620);
  near(planInfinite(account,250,false,settings).round,1.6);
});
test('V3 목표 지정가·별 LOC 전량 매도 뒤 당일 재진입 금지, 양의 이익만 재투입', () => {
  const trader=createInfiniteTrader(settings); const account=funded();buy(account,100,400);
  const sold=trader.tradeDay(account,candle('2026-01-05',100,120,100,120));
  assert.deepEqual(sold.trades.map(trade=>trade.orderType),['LIMIT','LOC']);
  assert.equal(account.quantity,0);near(account.lockedCash,450);near(sold.state.oneBuy,256.25);
  settleSales(account);
  const next=trader.tradeDay(account,candle('2026-01-06',100,100,100,100));
  assert.equal(next.trades[0].orderType,'OPEN'); assert.equal(account.quantity,2);
});
test('V3 원금 소진은 사전 예약MOC·진입일 매수 없음·잔금 재소진시 다시 MOC', () => {
  const strategy = { ...settings, capital: 10000, splits: 20 };
  const trader=createInfiniteTrader(strategy); const account=createAccount();deposit(account,10000);buy(account,100,10000);
  const exhausted=trader.tradeDay(account,candle('2026-01-05',90,100,70,80));
  assert.equal(exhausted.trades.length,1);assert.equal(exhausted.trades[0].orderType,'MOC');assert.equal(exhausted.trades[0].quantity,25);
  assert.equal(account.cash,0);assert.equal(account.lockedCash,2000);assert.equal(exhausted.state.mode,'quarter');near(exhausted.state.oneBuy,500);
  settleSales(account);
  const quarter=trader.tradeDay(account,candle('2026-01-06',80,85,75,80));
  assert.equal(quarter.trades[0].side,'BUY');assert.equal(quarter.trades.reduce((sum,trade)=>sum+trade.quantity,0),6);assert.equal(account.cash,1520);
  withdraw(account,1520);
  const recovered=trader.tradeDay(account,candle('2026-01-07',90,100,90,100));
  assert.equal(recovered.trades[0].orderType,'MOC');assert.equal(recovered.state.mode,'normal');
});

// Primary source: https://cafe.naver.com/infinitebuying/59826, inspected 2026-11-13.
test('V3 원문 수익200의 절반을20분할 매수금에 즉시 반영: 1000→1005', () => {
  const strategy = { ...settings, capital: 20000, splits: 20, target: 0.15 };
  const trader = createInfiniteTrader(strategy);
  const ledger = createAccount(); deposit(ledger, 20000); buy(ledger, 100, 1000);
  const day = trader.tradeDay(ledger, candle('2026-01-05', 120, 120, 120, 120));
  assert.equal(ledger.realized, 200);
  near(day.state.oneBuy, 1005);
});

test('V3 원문 쿼터모드에서도 T에 따라 별%가 변하며 고정 -목표%를 쓰지 않음', () => {
  const ledger = createAccount(); deposit(ledger, 20000); buy(ledger, 100, 15000);
  const strategy = { ...settings, capital: 20000, splits: 20, target: 0.15 };
  const plan = planInfinite(ledger, 1000, true, strategy);
  near(plan.round, 15);
  near(plan.starPercent, -0.075);
  near(plan.locPrice, 92.5);
});

test('V3 원문 매도표: 125주에서 쿼터31주·목표94주 배분', () => {
  const ledger = createAccount(); deposit(ledger, 20000); buy(ledger, 60, 7500);
  const plan = planInfinite(ledger, 1000, false, { ...settings, splits: 20 });
  assert.equal(plan.quarterQuantity, 31);
  assert.equal(plan.limitQuantity, 94);
});

test('V3 소진시4주 미만은 임의1주 매도 없이 정수주·자금 부족 상태를 표시', () => {
  const trader = createInfiniteTrader({ ...settings, splits: 2 });
  const ledger = funded(); buy(ledger, 500, 1000);
  const day = trader.tradeDay(ledger, candle('2026-01-05', 400, 400, 400, 400));
  assert.equal(day.trades.length, 0);
  assert.equal(day.state.cashShortage, true);
  assert.equal(ledger.quantity, 2);
  assert.equal(ledger.cash, 0);
});

test('V3 큰 하락의 사전 예약 하단 LOC는 정액 예산 안에서 추가 체결', () => {
  const trader = createInfiniteTrader(settings); const ledger = funded(); buy(ledger, 100, 200);
  const day = trader.tradeDay(ledger, candle('2026-01-05', 100, 100, 40, 40));
  const buys = day.trades.filter(trade => trade.side === 'BUY');
  // Two base shares, then common 1-share limits 83.33, 62.50, 50, 41.66.
  assert.deepEqual(buys.map(trade => trade.quantity), [1, 1, 4]);
  near(buys.reduce((sum, trade) => sum + trade.amount, 0), 240);
  near(ledger.cash, 560);
  assert(buys.at(-1)!.reason.includes('사전 예약'));
});
test('V3 당일 지정가 매도금은 LOC 매수에 재사용하지 않고 현금 부족 표시', () => {
  const trader=createInfiniteTrader(settings);const account=funded();buy(account,100,700);withdraw(account,290);
  const day=trader.tradeDay(account,candle('2026-01-05',100,110,90,90));
  assert(day.trades.some(trade=>trade.side==='SELL'));assert(!day.trades.some(trade=>trade.side==='BUY'));
  assert.equal(account.cash,10);assert(account.lockedCash>0);assert.equal(day.state.cashShortage,true);
});
test('V3 지정가 갭 상승은 시가 체결, 새로 매수한 주식의 당일 재매도 없음', () => {
  const trader=createInfiniteTrader(settings);const account=funded();buy(account,100,200);
  const day=trader.tradeDay(account,candle('2026-01-05',120,120,90,90));
  assert.equal(day.trades[0].price,120);assert.equal(day.trades[0].quantity,2);
  assert.equal(day.trades.filter(trade=>trade.side==='SELL').reduce((sum,trade)=>sum+trade.quantity,0),2);
  assert(day.trades.some(trade=>trade.side==='BUY'));
});
test('V3 공통 일별 원장과 지표·기간 재시작·반복 일치·원문과 체결 가정 안내', () => {
  const data: ExecutionData={version:'fixture',splits:[],distributions:[],bars:[candle('2026-01-02',100,100,100,100),candle('2026-01-05',100,100,90,90),candle('2026-01-06',100,120,90,95),candle('2026-01-07',100,100,90,90)]};
  const request={start:'2026-01-02',end:'2026-01-07',strategy:settings};
  const result=runBacktest(data,request);
  assert.deepEqual(result,runBacktest(data,request));
  for(const day of result.days){near(day.total,day.stock+day.cash+day.lockedCash);assert(Number.isSafeInteger(day.quantity));near(day.profit,day.realized+day.unrealized);}
  assert(result.warnings.some(warning=>warning.includes('원문')));
  const moved=runBacktest(data,{...request,start:'2026-01-06'});
  assert.equal(moved.days[0].quantity,2);assert.equal(moved.days[0].cost,200);assert.equal(moved.days[0].realized,0);
  assert.equal(moved.days[0].strategyState?.kind,'infinite');
  if(moved.days[0].strategyState?.kind==='infinite'){assert.equal(moved.days[0].strategyState.round,0);}
  assert.throws(()=>createInfiniteTrader({...settings,target:1}),/설정 오류/);
});
