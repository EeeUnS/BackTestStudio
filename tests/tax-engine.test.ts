import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaxLots } from '../src/tax/lots.ts';
import { settlementDate, anniversary } from '../src/tax/calendar.ts';
import { analyzeTax } from '../src/tax/analyze.ts';
import type { TaxOptions, TaxBasisData, BusinessCalendar } from '../src/tax/types.ts';
import type { ExecutionData, Trade } from '../src/engine/simpleBacktest.ts';
import { runBacktest } from '../src/engine/simpleBacktest.ts';
import type { FxData } from '../src/data/fx.ts';

const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const options:TaxOptions={enabled:true,account:'general',costMethod:'fifo',scenario:'hold'};
const bar=(date:string,price:number)=>({date,open:price,high:price,low:price,close:price});
function fx(rate=1000):FxData {
  const observations=[];
  for(let time=Date.parse('2024-01-01');time<=Date.parse('2028-12-31');time+=86400000)observations.push({date:new Date(time).toISOString().slice(0,10),rate});
  return {schema:1,pair:'USD-KRW',unit:'KRW-per-USD',source:'test exchange-rate',sources:['https://www.federalreserve.gov/releases/h10/'],fetchedAt:'2026-11-14T00:00:00Z',version:'fx-test',observations,missingDates:[],warnings:[]};
}
function fixture(currency:'USD'|'KRW'='USD',capital=1000,initialPrice=10,finalPrice=110,account:'general'|'isa'|'pension'='general') {
  const data:ExecutionData&{symbol:string;currency:'USD'|'KRW'}={version:'tax-fixture',symbol:currency==='USD'?'TQQQ':'133690.KS',currency,bars:[bar('2025-01-02',initialPrice),bar('2025-01-06',finalPrice)],splits:[],distributions:[]};
  const result=runBacktest(data,{start:'2025-01-02',end:'2025-01-06',strategy:{kind:'hold',capital},account});
  return {data,result};
}
function sellAll(input:ReturnType<typeof fixture>) {
  const {result}=input;const final=result.days.at(-1)!;
  const sale:Trade={date:result.end,side:'SELL',price:final.stock/final.quantity,quantity:final.quantity,amount:final.stock,realized:final.unrealized,reason:'test sale'};
  const days=result.days.map((day,index)=>index===result.days.length-1?{...day,quantity:0,cost:0,stock:0,cash:day.total,lockedCash:0,unrealized:0,realized:day.profit}:day);
  return {...input,result:{...result,days,trades:[...result.trades,sale]}};
}
function basis(symbol='133690.KS',buy=10,sell=110):TaxBasisData {
  return {symbol,source:'https://example.com/official-basis',version:'basis-test',fetchedAt:'2026-11-14T00:00:00Z',points:[{date:'2025-01-02',value:buy},{date:'2025-01-06',value:sell}]};
}

test('과세 원가: FIFO/이동평균·부분매도·분할은 원가총액을 보존',()=>{
  for(const method of ['fifo','average'] as const){const ledger=createTaxLots(method);
    for(const [quantity,cost] of [[2,200],[2,400]])ledger.buy({quantity,cost,acquired:'2025-01-02',settlementDate:'2025-01-03',rate:1,observationDate:'2025-01-03'});
    const sold=ledger.sell(1);near(sold.cost,method==='fifo'?100:150);
    ledger.split(2);assert.equal(ledger.quantity,6);near(ledger.cost,600-sold.cost);
    const final=ledger.sell(6);near(final.cost,600-sold.cost);assert.equal(ledger.quantity,0);
  }
});
test('결제: 확인 달력의 공휴일·연말을 반영하고 미확보 날짜는 추정으로 구분',()=>{
  const calendar:BusinessCalendar={market:'US',from:'2025-12-30',to:'2026-01-05',version:'verified-fixture',source:'test confirmed calendar',businessDays:['2025-12-30','2025-12-31','2026-01-02','2026-01-05']};
  assert.deepEqual(settlementDate('2025-12-31','US',calendar),{date:'2026-01-02',exact:true,source:calendar.source,version:calendar.version});
  assert.equal(settlementDate('2026-01-02','KR').date,'2026-01-06');assert.equal(settlementDate('2026-01-02','KR').exact,false);
  assert.equal(anniversary('2024-02-29',3),'2027-02-28');
});
test('미국 ETF 원화 순이익1000만원−250만원×22%=165만원·미납·원장 불변',()=>{
  const {result,data}=sellAll(fixture());const before=JSON.stringify(result);
  const report=analyzeTax(result,data,options,fx());
  assert.equal(report.status,'estimated');near(report.annual[0].net,10000000);near(report.accrued,1650000);
  near(report.paid,0);near(report.unpaid,1650000);near(report.accountValueKrw!,11000000);
  assert.equal(report.annual[0].paymentDate,'2026-06-01');
  assert.equal(report.trades[0].exchangeObservationDate,'2025-01-03');
  assert.equal(JSON.stringify(result),before);
});
test('US 손실·기본공제 이내·환율 미확보와 비적용을 구분',()=>{
  for(const finalPrice of [5,20]){const {result,data}=sellAll(fixture('USD',1000,10,finalPrice));const report=analyzeTax(result,data,options,fx());near(report.accrued,0);}
  const {result,data}=fixture();assert.equal(analyzeTax(result,data,options).status,'unavailable');
  assert.equal(analyzeTax(result,data,{...options,enabled:false}).status,'disabled');
});
test('취득·매도 결제일별 환율을 사용하고 연말 매도는 다음해 결제 귀속',()=>{
  const {result,data}=sellAll(fixture());
  data.bars=[bar('2025-12-30',10),bar('2025-12-31',110)];
  result.start='2025-12-30';result.end='2025-12-31';result.days=result.days.map((day,i)=>({...day,date:data.bars[i].date}));
  result.flows=[{date:'2025-12-30',amount:-1000}];result.trades=result.trades.map((trade,i)=>({...trade,date:data.bars[i].date}));
  const rates=fx();for(const observation of rates.observations)if(observation.date>='2026-01-02')observation.rate=1200;
  const calendar:BusinessCalendar={market:'US',from:'2025-12-30',to:'2026-01-05',version:'verified-fixture',source:'test confirmed calendar',businessDays:['2025-12-30','2025-12-31','2026-01-02','2026-01-05']};
  const report=analyzeTax(result,data,options,rates,undefined,calendar);
  assert.equal(report.annual[0].year,2026);near(report.annual[0].net,12200000);
  assert.equal(report.trades.at(-1)!.exchangeRate,1200);
});
test('전량 매도 가정은 기존 연도손익과 공제1회를 다시 계산하며 기존 거래를 변경하지 않음',()=>{
  const {result,data}=fixture();const before=JSON.stringify(result);
  const hold=analyzeTax(result,data,options,fx());const liquidate=analyzeTax(result,data,{...options,scenario:'liquidate'},fx());
  near(hold.accrued,0);near(liquidate.accrued,1650000);assert(liquidate.trades.at(-1)!.hypothetical);
  assert.equal(JSON.stringify(result),before);
});
test('연간 손실은 다음해로 이월하지 않고 다음해5월 납부 후 paid/unpaid를 구분',()=>{
  const {result,data}=fixture();
  const trades:Trade[]=[
    {date:'2025-01-02',side:'BUY',quantity:100,price:10,amount:1000,realized:0,reason:'entry'},
    {date:'2025-01-06',side:'SELL',quantity:100,price:5,amount:500,realized:-500,reason:'loss'},
    {date:'2026-01-02',side:'BUY',quantity:50,price:10,amount:500,realized:0,reason:'entry'},
    {date:'2026-01-06',side:'SELL',quantity:50,price:70,amount:3500,realized:3000,reason:'gain'},
  ];
  result.trades=trades;result.end='2027-06-02';
  result.days=[result.days[0],{...result.days.at(-1)!,date:result.end,quantity:0,cost:0,total:3500,stock:0,cash:3500,lockedCash:0,unrealized:0,profit:2500,realized:2500}];
  const report=analyzeTax(result,data,options,fx());
  near(report.annual[0].net,-500000);near(report.annual[0].tax,0);
  near(report.annual[1].net,3000000);near(report.annual[1].tax,110000);
  near(report.paid,110000);near(report.unpaid,0);
  assert(report.flows.some(flow=>flow.date==='2027-05-31'&&flow.amount===-110000));
});
test('같은연도 손실통산은 중간 발생세금도 줄여 최종 부담 곡선과 일치',()=>{
  const {result,data}=fixture('USD',1000,10,110);
  result.trades=[
    {date:'2025-01-02',side:'BUY',quantity:100,price:10,amount:1000,realized:0,reason:'entry'},
    {date:'2025-01-06',side:'SELL',quantity:50,price:110,amount:5500,realized:5000,reason:'gain'},
    {date:'2025-01-07',side:'SELL',quantity:50,price:5,amount:250,realized:-250,reason:'loss'},
  ];
  result.end='2025-01-08';result.days.push({...result.days.at(-1)!,date:result.end,quantity:0,cost:0,total:5750,cash:5750,stock:0});
  const report=analyzeTax(result,data,options,fx());
  near(report.accrued,(4750000-2500000)*.22);
  assert(report.events.some(event=>event.kind==='accrual'&&event.amount<0));
  near(report.curve.at(-1)!.accountValue,report.accountValueKrw!);
});
test('국내ETF 실제차익·과표증분의 작은 양수에15.4% 적용·자료없음은불가',()=>{
  const {result,data}=sellAll(fixture('KRW',1000,10,110));
  const report=analyzeTax(result,data,options,undefined,basis('133690.KS',10,60));
  near(report.accrued,770);near(report.annual[0].taxable,5000);near(report.annual[0].deduction,0);
  assert.equal(analyzeTax(result,data,options).status,'unavailable');
  const loss=sellAll(fixture('KRW',1000,10,5));near(analyzeTax(loss.result,loss.data,options).accrued,0);
});
test('ISA는가입일부터3년·결제후정산하고사용자지정공제0원으로수익전체과세',()=>{
  const {result,data}=fixture('KRW',10000000,10000,20000,'isa');
  const report=analyzeTax(result,data,{...options,account:'isa'},undefined,basis('133690.KS',10000,20000));
  assert.equal(report.status,'estimated');assert.equal(report.settlement!.minimumHoldingDate,'2028-01-02');
  assert.equal(report.settlement!.settlementDate,'2028-01-03');near(report.settlement!.tax,990000);
  near(report.settlement!.deduction,0);near(report.settlement!.net,19010000);
  assert(report.warnings.some(warning=>warning.includes('사용자 지정 가정')));
  assert(report.settlement!.waitingDays>1000);assert.equal(report.flows.at(-1)!.date,'2028-01-03');
  assert.equal(report.trades.at(-1)!.hypothetical,true);
});
test('연금저축 비공제 원금은 과세제외·수익만16.5%·손실0세금',()=>{
  const {result,data}=fixture('KRW',10000000,10000,20000,'pension');
  const report=analyzeTax(result,data,{...options,account:'pension'});
  near(report.settlement!.principal!,10000000);near(report.settlement!.tax,1650000);near(report.settlement!.net,18350000);
  const loss=fixture('KRW',10000000,10000,5000,'pension');
  near(analyzeTax(loss.result,loss.data,{...options,account:'pension'}).settlement!.tax,0);
});
test('종료 이전에 모두 매도·결제된 현금에는 종료일의 불필요한 T+2를 더하지 않음',()=>{
  const {result,data}=sellAll(fixture('KRW',10000000,10000,20000,'pension'));
  result.end='2025-01-10';result.days.push({...result.days.at(-1)!,date:result.end});
  const report=analyzeTax(result,data,{...options,account:'pension'});
  assert.equal(report.settlement!.settlementDate,'2025-01-10');
  assert.equal(report.settlement!.waitingDays,0);
});
test('pension 중간 net수령·이미 원천세 납부·잔여 비공제 원금은 최종과세와 중복하지 않음',()=>{
  const {result,data}=fixture('KRW',10000000,10000,20000,'pension');
  result.accountReport={...result.accountReport!,kind:'pension',principalRemaining:0,withdrawalTax:165000,withdrawnGross:11000000,withdrawnNet:10835000};
  result.flows.push({date:'2025-01-06',amount:10835000});
  const report=analyzeTax(result,data,{...options,account:'pension'});
  near(report.settlement!.tax,3300000);near(report.paid,165000);near(report.accrued,3465000);
  assert.equal(report.flows.filter(flow=>flow.amount===10835000).length,1);
});
