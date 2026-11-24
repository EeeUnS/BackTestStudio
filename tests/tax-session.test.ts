import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCalculationSession } from '../src/worker/session.ts';
import type { CalculationRequest } from '../src/worker/protocol.ts';
import type { MarketData } from '../src/data/market.ts';
import type { FxData } from '../src/data/fx.ts';
import type { TaxBasisData, TaxOptions } from '../src/tax/types.ts';
import { analyzeTax } from '../src/tax/analyze.ts';
import { prepareExecution } from '../src/data/execution.ts';

const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const tax:TaxOptions={enabled:true,account:'general',costMethod:'fifo',scenario:'hold'};
function market(domestic=false,prices=[10,80,140,90,180,110]):MarketData {
  const dates=['2025-01-02','2025-01-03','2025-01-06','2025-01-07','2025-01-08','2025-01-09'];
  return {schema:1,symbol:domestic?'133690.KS':'TQQQ',currency:domestic?'KRW':'USD',timeZone:domestic?'Asia/Seoul':'America/New_York',source:'tax-session-fixture',fetchedAt:'2025-01-10T00:00:00Z',priceBasis:'split-adjusted',version:'tax-session-market-v1',bars:dates.map((date,index)=>({date,open:prices[index],high:prices[index],low:prices[index],close:prices[index]})),splits:[],distributions:[],warnings:[]};
}
function exchange(rate=1000,version='fx-v1'):FxData {
  return {schema:1,pair:'USD-KRW',unit:'KRW-per-USD',source:'test',sources:['https://www.federalreserve.gov/releases/h10/'],fetchedAt:'2025-01-10T00:00:00Z',version,missingDates:[],warnings:[],observations:Array.from({length:20},(_,i)=>({date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),rate}))};
}
const request=(data:MarketData):CalculationRequest=>({start:data.bars[0].date,end:data.bars.at(-1)!.date,strategy:{kind:'hold',capital:1000},account:'general'});
function taxBasis(data:MarketData,endValue:number,version='basis-v1'):TaxBasisData {
  return {symbol:data.symbol,source:'https://example.com/official-tax-basis',version,fetchedAt:'2025-01-10T00:00:00Z',points:data.bars.map((bar,index)=>({date:bar.date,value:index===0?10:endValue})),warnings:[]};
}

test('Worker 세션 세금 on/off·원가 방식·종료 보기 변경은 기본 계산 캐시와 거래 원장을 유지',()=>{
  const data=market(false,[100,80,140,90,180,110]);const session=createCalculationSession();session.load(data);session.loadFx(exchange());
  const baseRequest:CalculationRequest={...request(data),strategy:{kind:'infinite',capital:10000,splits:20,target:.15,reinvestment:.5,tick:.01}};
  const base=session.run(baseRequest);assert.equal(base.cached,false);
  const original=JSON.stringify(base.result);
  const enabled=session.run({...baseRequest,tax});assert(enabled.cached);assert.equal(enabled.result.tax!.status,'estimated');
  const average=session.run({...baseRequest,tax:{...tax,costMethod:'average'}});assert(average.cached);
  const disabled=session.run({...baseRequest,tax:{...tax,enabled:false}});assert(disabled.cached);assert.equal(disabled.result.tax!.status,'disabled');
  for(const reply of [enabled,average,disabled]){assert.strictEqual(reply.result.days,base.result.days);assert.strictEqual(reply.result.trades,base.result.trades);assert.strictEqual(reply.result.flows,base.result.flows);}
  const fifoSale=enabled.result.tax!.trades.find(trade=>trade.side==='SELL')!;
  const averageSale=average.result.tax!.trades.find(trade=>trade.side==='SELL')!;
  assert.notEqual(fifoSale.costKrw,averageSale.costKrw);
  assert.equal(JSON.stringify(base.result),original);
  const hold=session.run({...request(data),tax});
  const liquidate=session.run({...request(data),tax:{...tax,scenario:'liquidate'}});assert(liquidate.cached);
  assert.strictEqual(liquidate.result.trades,hold.result.trades);assert(liquidate.result.tax!.trades.some(trade=>trade.hypothetical));
});
test('환율 버전을 바꾸면 세금만 새로 계산하고 기존 전략·기본통화 원장은 재사용',()=>{
  const data=market(false,[10,30,50,70,90,110]);const session=createCalculationSession();session.load(data);session.loadFx(exchange());
  const value={...request(data),tax:{...tax,scenario:'liquidate' as const}};
  const first=session.run(value);near(first.result.tax!.accrued,1650000);
  session.loadFx(exchange(2000,'fx-v2'));const second=session.run(value);assert(second.cached);
  near(second.result.tax!.accrued,3850000);assert.equal(second.result.tax!.fxVersion,'fx-v2');
  assert.strictEqual(first.result.days,second.result.days);assert.strictEqual(first.result.trades,second.result.trades);
  session.loadFx(undefined);const missing=session.run(value);assert(missing.cached);assert.equal(missing.result.tax!.status,'unavailable');
  assert.strictEqual(missing.result.trades,first.result.trades);
});
test('과표기준가격 버전 변경·누락은 세금만 갱신하며 국내ETF에 해외주식 공제를 적용하지 않음',()=>{
  const data=market(true,[10,30,50,70,90,110]);const session=createCalculationSession();session.load(data);session.loadTaxBasis(taxBasis(data,60));
  const value={...request(data),tax:{...tax,scenario:'liquidate' as const}};
  const first=session.run(value);near(first.result.tax!.accrued,770);near(first.result.tax!.annual[0].deduction,0);
  session.loadTaxBasis(taxBasis(data,30,'basis-v2'));const second=session.run(value);assert(second.cached);
  near(second.result.tax!.accrued,308);assert.equal(second.result.tax!.taxBasisVersion,'basis-v2');assert.strictEqual(first.result.days,second.result.days);
  session.loadTaxBasis(undefined);const missing=session.run(value);assert(missing.cached);assert.equal(missing.result.tax!.status,'unavailable');assert.match(missing.result.tax!.reason!,/과표기준가격/);
  assert.strictEqual(missing.result.trades,first.result.trades);
});
test('계좌 변경과 인출 일정 변경은 서로 다른 실행기를 사용하고 이전 캐시를 오염시키지 않음',()=>{
  const data=market(true,[10000,20000,20000,20000,20000,20000]);const session=createCalculationSession();session.load(data);
  const value:CalculationRequest={...request(data),strategy:{kind:'hold',capital:30000000},tax:{...tax,enabled:false}};
  const general=session.run(value);near(general.result.accountReport!.approved,30000000);
  const isa=session.run({...value,account:'isa',tax:{...tax,enabled:false,account:'isa'}});assert(!isa.cached);near(isa.result.accountReport!.approved,20000000);near(isa.result.accountReport!.blocked,10000000);
  const pension=session.run({...value,account:'pension',tax:{...tax,enabled:false,account:'pension'}});assert(!pension.cached);near(pension.result.accountReport!.approved,18000000);near(pension.result.accountReport!.blocked,12000000);
  const original=session.run(value);assert(original.cached);assert.deepEqual(original.result,general.result);
  const schedule=[{id:'withdraw-a',date:'2025-01-03',amount:1000000,currency:'KRW' as const}];
  const withdrawalRequest={...value,withdrawals:schedule};const changed=session.run(withdrawalRequest);assert(!changed.cached);
  const fresh=createCalculationSession();fresh.load(data);assert.deepEqual(changed.result,fresh.run(withdrawalRequest).result);
  const edited=session.run({...withdrawalRequest,withdrawals:[{...schedule[0],amount:2000000}]});assert(!edited.cached);
  assert.notEqual(edited.result.days.at(-1)!.total,changed.result.days.at(-1)!.total);
  const returned=session.run(withdrawalRequest);assert(returned.cached);assert.deepEqual(returned.result,changed.result);
});
test('한도 승인 납입·pension중간 순수령·원천세·최종 정산을 하나의 보고서에서 보존',()=>{
  const data=market(true,[10000,20000,20000,20000,20000,20000]);const session=createCalculationSession();session.load(data);
  const value:CalculationRequest={...request(data),account:'pension',strategy:{kind:'hold',capital:10000000},withdrawals:[{id:'pension-flow',date:'2025-01-03',amount:11000000,currency:'KRW'}],tax:{...tax,account:'pension'}};
  const reply=session.run(value);const account=reply.result.accountReport!;const report=reply.result.tax!;
  near(account.approved,10000000);near(account.withdrawnGross,11000000);near(account.withdrawnNet,10835000);near(account.withdrawalTax,165000);near(account.principalRemaining,0);
  near(reply.result.flows.filter(flow=>flow.amount>0).reduce((sum,flow)=>sum+flow.amount,0),account.withdrawnNet);
  near(report.paid,account.withdrawalTax);near(report.settlement!.tax,1485000);near(report.accrued,1650000);
  near(report.annual.reduce((sum,row)=>sum+row.tax,0),report.accrued);
  near(report.annual.reduce((sum,row)=>sum+row.paid,0),report.paid);
  assert(reply.result.trades.some(trade=>trade.reason.includes('중간 인출 재원 마련')));
  const short=session.run({...value,end:'2025-01-03'});
  near(short.result.accountReport!.withdrawnNet,0);near(short.result.tax!.paid,0);
  const restored=session.run(value);assert(restored.cached);assert.deepEqual(restored.result,reply.result);
});
test('원장 계좌와 세금 계좌가 다르면 세션이 거부하고 직접 분석도 계산 불가를 표시',()=>{
  const data=market(true);const session=createCalculationSession();session.load(data);
  const value={...request(data),tax:{...tax,account:'isa' as const}};
  assert.throws(()=>session.run(value),/계좌/);
  const core=session.run(request(data)).result;
  const report=analyzeTax(core,prepareExecution(data,data.bars[0].date,data.bars.at(-1)!.date),value.tax);
  assert.equal(report.status,'unavailable');assert.match(report.reason!,/계좌/);
});
