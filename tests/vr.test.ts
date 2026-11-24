import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVrTrader, executeVrOrders, nextVrValue } from '../src/engine/vr.ts';
import type { VrStrategy } from '../src/engine/vr.ts';
import { buy, createAccount, deposit } from '../src/engine/account.ts';
import { runBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData, Trade } from '../src/engine/simpleBacktest.ts';
const settings: VrStrategy = { kind:'vr',capital:1000,mode:'hold',advanced:false,initialStockFraction:0.9,initialValue:0,gradient:10,annualGradientIncrease:1,band:0.15,cycleDays:14,poolUse:0.5,flowAmount:250,flowDays:14,tick:0.01 };
const bar=(date:string,open:number,high=open,low=open,close=open)=>({date,open,high,low,close});
const dataset=(bars:ExecutionData['bars']):ExecutionData=>({version:'vr-fixture',bars,splits:[],distributions:[]});
function near(actual:number,expected:number,tolerance=1e-7){assert(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);}
function account(){const value=createAccount();deposit(value,1000);return value;}

// Primary source: https://cafe.naver.com/infinitebuying/38944
// Public article JSON and embedded table inspected 2026-11-13.
test('VR5.0 원문 V=9000·Pool=1000·G=10·적립250 → V=9350', () => {
  near(nextVrValue(9000, 1000, 9000, 10, false) + 250, 9350);
  near(9350 * 0.85, 7947.5);
  near(9350 * 1.15, 10752.5);
});

test('VR5.0 원문 예약매수표 176→181주 가격 반올림·Pool 잔액 일치', () => {
  const ledger = createAccount();
  deposit(ledger, 176 * 60 + 383.14);
  buy(ledger, 60, 176 * 60);
  const result = executeVrOrders(ledger, bar('2026-01-05', 60, 60, 58.39, 60), 10509.46 / 0.85, settings, 383.14);
  assert.deepEqual(result.trades.map(trade => Number(trade.price.toFixed(2))), [59.71, 59.38, 59.04, 58.71, 58.39]);
  assert(result.trades.every(trade => trade.side === 'BUY' && trade.quantity === 1));
  assert.equal(ledger.quantity, 181);
  near(ledger.cash, 87.91);
  near(result.spent, 295.23);
});
// https://www.youtube.com/watch?v=cIp8G3AVtnM, formula at 55s and inputs at 65s.
test('VR 원저자 실력공식 영상의 마지막 평가금 E·V·Pool·G·적립금 대조',()=>{
  near(nextVrValue(900,100,800,10,false),910);
  near(nextVrValue(15205.76,76.73,5282.11,11,true)+250,13966.6889272359);
  assert.equal((nextVrValue(15205.76,76.73,5282.11,11,true)+250).toFixed(2),'13966.69');
  assert.throws(()=>nextVrValue(100,100,100,0,false),/입력 오류/);
});

test('VR 주기 내 매수·매도 사다리는 최초 예약 수량을 유지하고 체결한 줄을 재사용하지 않음', () => {
  const source = dataset([
    bar('2026-01-02',100), bar('2026-01-05',100,100,85,100),
    bar('2026-01-06',100,120,100,100), bar('2026-01-07',100,100,85,100),
  ]);
  const result = runBacktest(source, { start:'2026-01-02',end:'2026-01-07',strategy:{...settings,poolUse:1} });
  const purchases = result.trades.filter(trade=>trade.date==='2026-01-05');
  assert.equal(purchases.length,1); near(purchases[0].price,85);
  const sales = result.trades.filter(trade=>trade.date==='2026-01-06');
  assert.equal(sales.length,1); near(sales[0].price,115);
  assert.equal(result.trades.filter(trade=>trade.date==='2026-01-07').length,0);
});

test('VR 인출 주기 Pool 한도는 인출 후 잔액의 비율로 확정', () => {
  const source=dataset([bar('2026-01-02',100),bar('2026-01-16',100)]);
  const result=runBacktest(source,{start:'2026-01-02',end:'2026-01-16',strategy:{...settings,mode:'withdraw',flowAmount:50,poolUse:0.25}});
  const state=result.days[1].strategyState;
  assert(state?.kind==='vr'); near(state.cycleBudget,12.5);
});
test('VR 최초90% 정수주 배분·잔액 Pool·V자동·최초일 추가 사다리 없음',()=>{
  const result=runBacktest(dataset([bar('2026-01-02',100,200,50,100)]),{start:'2026-01-02',end:'2026-01-02',strategy:settings});
  assert.equal(result.trades.length,1);assert.equal(result.days[0].quantity,9);assert.equal(result.days[0].cash,100);
  const state=result.days[0].strategyState;assert(state?.kind==='vr');assert.equal(state.value,900);assert.equal(state.cycleBudget,50);
});
test('VR 주기 갱신은 종가를 미리 쓰지 않고 V갱신 후 적립금 적용',()=>{
  const source=dataset([bar('2026-01-02',100),bar('2026-01-16',100)]);
  const result=runBacktest(source,{start:'2026-01-02',end:'2026-01-16',strategy:{...settings,mode:'accumulate',poolUse:0.75}});
  const final=result.days.at(-1)!;const state=final.strategyState;assert(state?.kind==='vr');
  near(state.value,1160);assert.equal(final.deposited,1250);assert.equal(final.contribution,250);near(final.profit,0);near(result.metrics.twr,0);near(result.metrics.mdd,0);
  assert.equal(result.metrics.cagr.available,false);
});
test('VR 실제 인출·미지급 분리·당일 매도금으로 요청 인출 충당 금지',()=>{
  const result=runBacktest(dataset([bar('2026-01-02',100),bar('2026-01-16',200)]),{start:'2026-01-02',end:'2026-01-16',strategy:{...settings,mode:'withdraw',flowAmount:250}});
  const final=result.days.at(-1)!;const state=final.strategyState;assert(state?.kind==='vr');
  assert.equal(final.withdrawn,100);assert.equal(final.withdrawal,100);assert.equal(state.unfundedWithdrawals,150);
  assert.equal(result.flows.filter(flow=>flow.amount>0).reduce((sum,flow)=>sum+flow.amount,0),100);
  assert(final.lockedCash>0);near(final.profit,final.realized+final.unrealized);
});
test('VR 1주 사다리 양방향 체결은 전일 수량·현금 고정, 새 매수분 재매도·매도금 재매수 금지',()=>{
  const value=account();buy(value,100,900);
  const result=executeVrOrders(value,bar('2026-01-05',100,200,50,100),900,{...settings,poolUse:1},100);
  const sold=result.trades.filter(trade=>trade.side==='SELL').reduce((sum,trade)=>sum+trade.quantity,0);
  const bought=result.trades.filter(trade=>trade.side==='BUY').reduce((sum,trade)=>sum+trade.quantity,0);
  assert(sold<=9);assert.equal(bought,1);assert(result.spent<=100);assert(value.lockedCash>0);assert.equal(result.cashShortage,true);
  assert.equal(value.quantity,9-sold+bought);
});
test('VR Pool 사용 예산은 주기 중 매도금으로 늘리지 않고 다음 주기에서 재설정',()=>{
  const trader=createVrTrader(settings);const value=account();
  trader.tradeDay(value,bar('2026-01-02',100));
  const day=trader.tradeDay(value,bar('2026-01-05',200));
  assert(day.trades.some(trade=>trade.side==='SELL'));near(day.state.cycleBudget,50);
});
test('VR 윤일 시작·연간G 증가·미래 당일 종가 배제와 기간 재시작',()=>{
  const source=dataset([bar('2024-02-29',100),bar('2025-02-28',100,200,100,200)]);
  const result=runBacktest(source,{start:'2024-02-29',end:'2025-02-28',strategy:{...settings,advanced:true}});
  const state=result.days[1].strategyState;assert(state?.kind==='vr');assert.equal(state.gradient,11);near(state.value,900+100/11);
  const moved=runBacktest(source,{start:'2025-02-28',end:'2025-02-28',strategy:settings});
  assert.equal(moved.days[0].quantity,9);assert.equal(moved.days[0].withdrawn,0);
});
test('VR 매도 사다리 그룹 체결은 1주씩 수작업 기준과 동일',()=>{
  const original=account();buy(original,100,900);
  const candle=bar('2026-01-05',110,160,100,150);
  const optimized=executeVrOrders(original,candle,900,settings,50);
  let quantity=9;const expected:Trade[]=[];
  while(quantity>0){const limit=Math.round(1035/quantity*100)/100;if(limit>160){break;}expected.push({date:candle.date,side:'SELL',price:Math.max(110,limit),quantity:1,amount:Math.max(110,limit),realized:0,reason:'naive'});quantity--;}
  near(optimized.trades.filter(t=>t.side==='SELL').reduce((sum,t)=>sum+t.amount,0),expected.reduce((sum,t)=>sum+t.amount,0));
  assert.equal(original.quantity,quantity);
});
test('VR 큰 보유량·같은 틱·시가 갭 주문을 묶어 자산 보존·안전한 정수주',()=>{
  const value=createAccount();deposit(value,1000000000);buy(value,0.1,900000000);
  const before=value.quantity*0.1+value.cash;
  const result=executeVrOrders(value,bar('2026-01-05',0.1,0.2,0.05,0.1),900000000,settings,50000000);
  assert(result.trades.length<100);assert(Number.isSafeInteger(value.quantity));assert(value.cash>=0);
  near(value.quantity*0.1+value.cash+value.lockedCash-before,value.realized+(value.quantity*0.1-value.cost),1e-5);
});
test('VR 초기1주 불가·잘못된 설정은 명시적 오류, 반복 실행과 자산·입출금 손익 보존',()=>{
  const source=dataset([bar('2026-01-02',100),bar('2026-01-16',80,120,60,100),bar('2026-01-30',110)]);
  const request={start:'2026-01-02',end:'2026-01-30',strategy:{...settings,mode:'accumulate' as const}};
  const result=runBacktest(source,request);assert.deepEqual(result,runBacktest(source,request));
  for(const day of result.days){near(day.total,day.stock+day.cash+day.lockedCash);near(day.profit,day.total+day.withdrawn-day.deposited);assert(Number.isSafeInteger(day.quantity));}
  assert(result.warnings.some(warning=>warning.includes('원문')));
  assert.throws(()=>runBacktest(source,{...request,strategy:{...settings,capital:1}}),/1주/);
  assert.throws(()=>createVrTrader({...settings,cycleDays:0}),/설정 오류/);
});

test('VR 그룹 사다리는 다양한 갭·가격 단위에서 1주 순회 원장과 동일',()=>{
  for(const tick of [0.01,0.1,1,5]){
  for(const opening of [70,100,100.005,160]){
    for(const targetValue of [300,900,2000]){
      for(const budget of [0,50,100]){
        const optimized=account();buy(optimized,100,900);
        const naive=account();buy(naive,100,900);
        const candle=bar('2026-01-05',opening,opening+60,Math.max(1,opening-40),opening);
        executeVrOrders(optimized,candle,targetValue,{...settings,tick},budget);
        const originalQuantity=naive.quantity;const originalCash=naive.cash;let sold=0,bought=0,spent=0;
        while(sold<originalQuantity){const limit=Math.round(targetValue*1.15/(originalQuantity-sold)/tick)*tick;if(limit<=0||limit>candle.high){break;}const price=Math.max(candle.open,limit);const average=naive.cost/naive.quantity;naive.quantity--;naive.cost=naive.quantity===0?0:naive.cost-average;naive.realized+=price-average;naive.lockedCash+=price;sold++;}
        while(true){const limit=Math.round(targetValue*.85/(originalQuantity+bought)/tick)*tick;if(limit<=0||candle.low>limit){break;}const price=Math.min(candle.open,limit);if(price>Math.min(budget-spent,originalCash-spent)){break;}buy(naive,price,price,1);spent+=price;bought++;}
        for(const key of ['quantity','cash','cost','lockedCash','realized'] as const){near(optimized[key],naive[key],1e-6);}
      }
    }
  }
  }
});
test('VR 실력공식 E는 분할일에도 직전 주식 평가금 보존',()=>{
  const source=dataset([bar('2026-01-02',100),bar('2026-01-16',50)]);source.splits=[{date:'2026-01-16',ratio:2}];
  const result=runBacktest(source,{start:'2026-01-02',end:'2026-01-16',strategy:{...settings,advanced:true}});
  const state=result.days[1].strategyState;assert(state?.kind==='vr');near(state.value,910);assert.equal(result.days[1].quantity,18);near(result.metrics.twr,0);
});

test('VR 무보유 사다리와 인출 시작일·휴장일 이월을 별도 처리',()=>{
  const value=account();const trade=executeVrOrders(value,bar('2026-01-05',100),900,settings,100);
  assert.equal(value.quantity,1);assert.equal(trade.spent,100);assert.equal(trade.cashShortage,true);
  const source=dataset([bar('2026-01-02',100),bar('2026-01-16',100),bar('2026-02-02',100)]);
  const result=runBacktest(source,{start:'2026-01-02',end:'2026-02-02',strategy:{...settings,mode:'withdraw',withdrawalStart:'2026-01-31'}});
  assert.equal(result.days[1].withdrawn,0);assert.equal(result.days[2].withdrawn,100);
  const state=result.days[2].strategyState;assert(state?.kind==='vr');assert.equal(state.unfundedWithdrawals,150);
});


test('VR 대규모 전액 인출 뒤 자산0일에도 누적 소수점 오차로 검산을 오판하지 않음', () => {
  const price = 123.45;
  const bars = Array.from({ length: 20 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 2 + index * 14)).toISOString().slice(0, 10);
    const value = price * (index ? 1.9 : 1);
    return bar(date, value);
  });
  const result = runBacktest(dataset(bars), { start: bars[0].date, end: bars.at(-1)!.date,
    strategy: { ...settings, capital: 10000000000, mode: 'withdraw', advanced: true, gradient: 20, poolUse: 0.25, flowAmount: 10000000000 } });
  const final = result.days.at(-1)!;
  assert.equal(final.total, 0);
  assert.equal(final.quantity, 0);
  assert.equal(final.deposited, 10000000000);
  near(final.withdrawn, 18099999919.945, 0.0001);
  near(final.profit, final.realized, 0.0001);
  near(final.profit, final.withdrawn - final.deposited, 0.0001);
});
