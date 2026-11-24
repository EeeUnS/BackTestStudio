import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBacktestRunner, runBacktest } from '../src/engine/simpleBacktest.ts';
import type { BacktestRequest, ExecutionData } from '../src/engine/simpleBacktest.ts';
import { createAccountController } from '../src/accounts/ledger.ts';
import { buy, createAccount, deposit } from '../src/engine/account.ts';
const bar=(date:string,price=100)=>({date,open:price,high:price,low:price,close:price});
const source=(bars:ExecutionData['bars'],currency:'USD'|'KRW'='USD'):ExecutionData=>({version:'withdrawal-fixture',symbol:currency==='USD'?'TQQQ':'133690.KS',currency,bars,splits:[],distributions:[]});
const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const schedule=(date:string,amount:number,currency:'USD'|'KRW'='USD',id='withdrawal')=>({id,date,amount,currency});

test('가용현금만 인출하면 매도하지 않고 순손익·TWR에 인출을 손실로 넣지 않음',()=>{
  const data=source([bar('2026-01-02'),bar('2026-01-05')]);
  const result=runBacktest(data,{start:'2026-01-02',end:'2026-01-05',strategy:{kind:'hold',capital:1050},withdrawals:[schedule('2026-01-05',30)]});
  assert.equal(result.trades.filter(trade=>trade.side==='SELL').length,0);
  assert.equal(result.days.at(-1)!.total,1020);assert.equal(result.days.at(-1)!.withdrawn,30);
  near(result.metrics.twr,0);near(result.days.at(-1)!.profit,0);
  assert.equal(result.accountReport!.withdrawals[0].paidDate,'2026-01-05');
});
test('1주 최소 매도·초과잔금 유지·미국T+1 결제 이전 지급 금지',()=>{
  const result=runBacktest(source([bar('2026-01-02'),bar('2026-01-05'),bar('2026-01-06')]),{start:'2026-01-02',end:'2026-01-06',strategy:{kind:'hold',capital:1050},withdrawals:[schedule('2026-01-05',125)]});
  const row=result.accountReport!.withdrawals[0];
  assert.equal(row.soldQuantity,1);assert.equal(row.saleAmount,100);
  assert.deepEqual(row.payments.map(payment=>[payment.date,payment.gross]),[['2026-01-05',50],['2026-01-06',75]]);
  assert.equal(result.days[1].lockedCash,100);assert.equal(result.days[1].withdrawal,50);
  assert.equal(result.days[2].cash,25);assert.equal(result.days[2].quantity,9);
  assert.equal(result.days[2].total,925);assert.equal(row.unpaid,0);assert.equal(row.pending,false);
  near(result.metrics.twr,0);
});
test('현재 시가를 관측해 최소 수량을 정하며 미래 종가로 더 많은 주식을 팔지 않음',()=>{
  const candle={date:'2026-01-05',open:200,high:200,low:20,close:20};
  const result=runBacktest(source([bar('2026-01-02'),candle,bar('2026-01-06',20)]),{start:'2026-01-02',end:'2026-01-06',strategy:{kind:'hold',capital:1000},withdrawals:[schedule('2026-01-05',600)]});
  const sale=result.trades.find(trade=>trade.side==='SELL')!;
  assert.equal(sale.quantity,3);assert.equal(sale.price,200);
  const down=runBacktest(source([bar('2026-01-02'),bar('2026-01-05',50),bar('2026-01-06',50)]),{start:'2026-01-02',end:'2026-01-06',strategy:{kind:'hold',capital:1000},withdrawals:[schedule('2026-01-05',125)]});
  assert.equal(down.accountReport!.withdrawals[0].soldQuantity,3);
  assert.equal(down.days.at(-1)!.cash,25);
});
test('국내T+2와 검증달력의 공휴일 제외·결제일까지 예약금 잠금',()=>{
  const data=source([bar('2026-01-02'),bar('2026-01-05'),bar('2026-01-06'),bar('2026-01-07'),bar('2026-01-08')],'KRW');
  data.settlementCalendar={market:'KR',version:'fixture-calendar',source:'test-calendar',from:'2026-01-01',to:'2026-01-09',businessDays:['2026-01-02','2026-01-05','2026-01-07','2026-01-08','2026-01-09']};
  const result=runBacktest(data,{start:'2026-01-02',end:'2026-01-08',account:'general',strategy:{kind:'hold',capital:1000},withdrawals:[schedule('2026-01-05',100,'KRW')]});
  const row=result.accountReport!.withdrawals[0];
  assert.equal(row.settlementDate,'2026-01-08');assert.equal(row.paidDate,'2026-01-08');assert.equal(row.settlementExact,true);
  assert.equal(result.days[2].withdrawal,0);assert.equal(result.days[3].withdrawal,0);
});
test('자산 전부 매도해도 부족하면 미지급액 표시·차입 없음',()=>{
  const result=runBacktest(source([bar('2026-01-02'),bar('2026-01-05'),bar('2026-01-06')]),{start:'2026-01-02',end:'2026-01-06',strategy:{kind:'hold',capital:1000},withdrawals:[schedule('2026-01-05',2000)]});
  const row=result.accountReport!.withdrawals[0];
  assert.equal(row.soldQuantity,10);assert.equal(row.grossPaid,1000);assert.equal(row.unpaid,1000);assert.equal(row.pending,false);
  assert.equal(result.days.at(-1)!.total,0);assert.equal(result.days.at(-1)!.cash,0);near(result.metrics.twr,0);
});
test('ISA중간 인출은 납입원금까지만, 매도·인출이 납입한도를 복원하지 않음',()=>{
  const controller=createAccountController({kind:'isa',openedAt:'2026-01-02',currency:'KRW',symbol:'133690.KS',requests:[schedule('2026-01-05',1500,'KRW')]});
  const account=createAccount();deposit(account,controller.depositApproval('2026-01-02',1000,'initial'));buy(account,100,1000);
  controller.process(account,bar('2026-01-05',200));
  controller.releaseNormalSales(account);controller.process(account,bar('2026-01-07',200));
  const report=controller.report('2026-01-07');
  assert.equal(report.withdrawals[0].allowed,1000);assert.equal(report.withdrawals[0].restricted,500);
  assert.equal(report.withdrawals[0].soldQuantity,5);assert.equal(report.withdrawnGross,1000);
  assert.equal(report.principalRemaining,0);assert.equal(controller.contributions.remaining('2026-01-08'),19999000);
});
test('연금저축 중간 인출의 비공제 원금 우선·수익 과세·실제net 현금흐름',()=>{
  const data=source([bar('2026-01-02'),...['2026-01-05','2026-01-06','2026-01-07','2026-01-08','2026-01-09','2026-01-12'].map(date=>bar(date,200))],'KRW');
  const result=runBacktest(data,{start:'2026-01-02',end:'2026-01-12',account:'pension',strategy:{kind:'hold',capital:1000},withdrawals:[schedule('2026-01-05',600,'KRW','a'),schedule('2026-01-08',1000,'KRW','b')]});
  const report=result.accountReport!;
  near(report.withdrawalTax,99);near(report.withdrawnNet,1501);assert.equal(report.withdrawnGross,1600);assert.equal(report.principalRemaining,0);
  assert.deepEqual(result.flows.filter(flow=>flow.amount>0).map(flow=>flow.amount),[600,901]);
  assert.equal(result.days.at(-1)!.total,400);assert.equal(result.days.at(-1)!.withdrawn,1600);
});
test('같은 지급일에 여러 연금 예약금이 만기면 결제일·요청일·ID 순서로 비공제 원금을 배분',()=>{
  const data=source([bar('2026-01-02'),bar('2026-01-05',200),bar('2026-01-06',200),bar('2026-01-08',200)],'KRW');
  for(const secondDate of ['2026-01-05','2026-01-06']) {
    const result=runBacktest(data,{start:'2026-01-02',end:'2026-01-08',account:'pension',strategy:{kind:'hold',capital:1000},
      withdrawals:[schedule(secondDate,800,'KRW','b'),schedule('2026-01-05',800,'KRW','a')]});
    const report=result.accountReport!;
    const first=report.withdrawals.find(row=>row.id==='a')!;
    const second=report.withdrawals.find(row=>row.id==='b')!;
    assert.equal(first.paidDate,'2026-01-08');assert.equal(second.paidDate,'2026-01-08');
    near(first.payments[0].principal!,800);near(first.tax,0);near(first.netPaid,800);
    near(second.payments[0].principal!,200);near(second.tax,99);near(second.netPaid,701);
    near(report.withdrawnGross,1600);near(report.withdrawnNet,1501);near(report.withdrawalTax,99);
    assert.equal(report.principalRemaining,0);
  }
});
test('같은 날 여러 요청·휴장일 이동·기간/통화 제외와 종료일까지 미결제 대기',()=>{
  const data=source([bar('2026-01-02'),bar('2026-01-05')]);
  const request:BacktestRequest={start:'2026-01-02',end:'2026-01-05',strategy:{kind:'hold',capital:1050},withdrawals:[schedule('2026-01-04',25,'USD','a'),schedule('2026-01-05',100,'USD','b'),schedule('2026-01-06',1,'USD','outside'),schedule('2026-01-05',1,'KRW','wrong')]};
  const result=runBacktest(data,request);const rows=result.accountReport!.withdrawals;
  assert.equal(rows.find(row=>row.id==='a')!.paidDate,'2026-01-05');
  assert.equal(rows.find(row=>row.id==='b')!.pending,true);assert.equal(rows.find(row=>row.id==='b')!.grossPaid,25);
  assert(rows.find(row=>row.id==='outside')!.excluded);assert(rows.find(row=>row.id==='wrong')!.excluded);
});
test('별도 인출매도일은 전략 주문을 취소하고 매도금 당일 재매수 금지',()=>{
  const result=runBacktest(source([bar('2026-01-02'),bar('2026-01-05'),bar('2026-01-06')]),{start:'2026-01-02',end:'2026-01-06',strategy:{kind:'infinite',capital:1000,splits:10,target:.1,reinvestment:.5,tick:.01},withdrawals:[schedule('2026-01-05',950)]});
  const trades=result.trades.filter(trade=>trade.date==='2026-01-05');
  assert.equal(trades.length,1);assert.equal(trades[0].side,'SELL');assert.match(trades[0].reason,/중간 인출/);
});
test('인출 원장도 종료일 축소·연장·재연장시 독립 실행과 일치하며 반환 결과를 변경하지 않음',()=>{
  const data=source([bar('2026-01-02'),bar('2026-01-05'),bar('2026-01-06'),bar('2026-01-07')]);
  const request:BacktestRequest={start:'2026-01-02',end:'2026-01-02',account:'general',strategy:{kind:'hold',capital:1050},withdrawals:[schedule('2026-01-05',125)]};
  const runner=createBacktestRunner(data,request);const first=runner.run(request.end);const preserved=JSON.stringify(first);
  for(const end of ['2026-01-05','2026-01-07','2026-01-02','2026-01-06'])assert.deepEqual(runner.run(end),runBacktest(data,{...request,end}));
  assert.equal(JSON.stringify(first),preserved);
});
