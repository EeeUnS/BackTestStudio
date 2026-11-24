import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContributionLedger } from '../src/accounts/ledger.ts';
import { runBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData } from '../src/engine/simpleBacktest.ts';
const bar=(date:string,price=10000)=>({date,open:price,high:price,low:price,close:price});
function data(dates:string[],symbol:ExecutionData['symbol']='133690.KS'):ExecutionData { return {symbol,currency:'KRW',version:'account-limits',bars:dates.map(date=>bar(date)),splits:[],distributions:[]}; }
const near=(actual:number,expected:number)=>assert(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);

test('ISA 연간 일부 승인·미사용 이월·누적1억원 한도, 차단분 자동 재시도 없음',()=>{
  const ledger=createContributionLedger('isa','2026-11-14');
  assert.equal(ledger.approve('2026-11-16',10000000,'initial'),10000000);
  assert.equal(ledger.approve('2028-01-03',80000000,'dca'),50000000);
  assert.equal(ledger.approve('2029-01-02',20000000,'dca'),20000000);
  assert.equal(ledger.approve('2030-01-02',30000000,'dca'),20000000);
  assert.equal(ledger.approve('2031-01-02',1,'dca'),0);
  assert.equal(ledger.entries.reduce((sum,entry)=>sum+entry.approved,0),100000000);
  assert.equal(ledger.entries[1].blocked,30000000);
});
test('연금저축은 연1800만원·미사용한도 이월 없음',()=>{
  const ledger=createContributionLedger('pension','2026-11-14');
  assert.equal(ledger.approve('2026-11-16',10000000,'initial'),10000000);
  assert.equal(ledger.approve('2026-12-01',10000000,'dca'),8000000);
  assert.equal(ledger.approve('2028-01-03',30000000,'dca'),18000000);
  assert.equal(ledger.approve('2028-02-01',100,'dca'),0);
});
test('초기 일시금 초과는승인금만 원장·XIRR투입금·CAGR에 반영',()=>{
  const result=runBacktest(data(['2026-11-02','2026-11-03']),{start:'2026-11-02',end:'2026-11-03',account:'isa',strategy:{kind:'hold',capital:50000000}});
  assert.equal(result.days[0].deposited,20000000);
  assert.equal(result.days[0].quantity,2000);
  assert.equal(result.flows[0].amount,-20000000);
  assert.equal(result.accountReport!.blocked,30000000);
  assert.equal(result.days[0].contributionBlocked,30000000);
  assert(result.metrics.cagr.available); near(result.metrics.cagr.value,0);
});
test('월 적립 한도 소진 후 다음 해의 새 예정납입만 승인',()=>{
  const result=runBacktest(data(['2026-11-02','2026-12-01','2027-01-04']),{start:'2026-11-02',end:'2027-01-04',account:'isa',strategy:{kind:'dca',contribution:20000000,interval:'monthly'}});
  assert.deepEqual(result.days.map(day=>day.contribution),[20000000,0,20000000]);
  assert.equal(result.days.at(-1)!.deposited,40000000);
  assert.equal(result.accountReport!.blocked,20000000);
  assert.deepEqual(result.flows.map(flow=>flow.amount),[-20000000,-20000000]);
});
test('VR초기배분은 승인 초기금 기준, 주기 적립도 같은 한도 원장을 통과',()=>{
  const strategy={kind:'vr' as const,capital:30000000,mode:'accumulate' as const,advanced:false,initialStockFraction:.9,initialValue:0,gradient:10,annualGradientIncrease:1,band:.15,cycleDays:14,poolUse:.75,flowAmount:250000,flowDays:14,tick:5};
  const result=runBacktest(data(['2026-11-02','2026-11-16']),{start:'2026-11-02',end:'2026-11-16',account:'isa',strategy});
  assert.equal(result.days[0].stock,18000000); assert.equal(result.days[0].cash,2000000);
  assert.equal(result.days[1].deposited,20000000);
  assert.equal(result.days[1].contributionRequested,250000);
  assert.equal(result.days[1].contributionBlocked,250000);
  const state=result.days[1].strategyState;assert(state?.kind==='vr');near(state.value,18200000);
});
test('계좌 불가 상품과 잘못된 인출 일정은 엔진 실행 전 거부',()=>{
  const source=data(['2026-11-02']);
  const request={start:'2026-11-02',end:'2026-11-02',strategy:{kind:'hold' as const,capital:1000000}};
  assert.throws(()=>runBacktest({...source,currency:'USD',symbol:'TQQQ'},{...request,account:'isa'}),/해외 상장/);
  assert.throws(()=>runBacktest(data(['2026-11-02'],'418660.KS'),{...request,account:'pension'}),/비레버리지/);
  assert.throws(()=>runBacktest(source,{...request,withdrawals:[{id:'x',date:'2026-02-30',amount:1,currency:'KRW'}]}),/일정/);
  assert.throws(()=>runBacktest(source,{...request,withdrawals:{} as never}),/배열/);
});
