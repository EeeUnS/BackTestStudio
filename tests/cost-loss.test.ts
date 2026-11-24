import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyCostLoss } from '../src/engine/costLoss.ts';
import { createBacktestRunner, runBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData } from '../src/engine/simpleBacktest.ts';

const bar = (date: string, open: number, close = open) => ({date,open,high:Math.max(open,close),low:Math.min(open,close),close});
const source = (bars: ExecutionData['bars']): ExecutionData => ({version:'cost-loss-fixture',bars,splits:[],distributions:[]});
const near = (value: number, expected: number) => assert(Math.abs(value - expected) < 1e-9, `${value} != ${expected}`);

test('평단100→80의 -20%는 마지막 회복 후에도 보존되며 현금으로 희석하지 않음', () => {
  const data=source([bar('2026-01-02',100),bar('2026-01-05',80),bar('2026-01-06',120)]);
  const result=runBacktest(data,{start:'2026-01-02',end:'2026-01-06',strategy:{kind:'hold',capital:1050}});
  const loss=result.metrics.maxCostLoss!;
  near(loss.rate,-0.2); near(loss.amount,-200);
  assert.equal(loss.date,'2026-01-05'); assert.equal(loss.averageCost,100);
  near(result.days.at(-1)!.unrealized,200);
});
test('MDD가 있어도 평단을 밑돈 적 없으면 평가손실은0이며 보유 없음은 미산출', () => {
  const data=source([bar('2026-01-02',100),bar('2026-01-05',200),bar('2026-01-06',150)]);
  const result=runBacktest(data,{start:'2026-01-02',end:'2026-01-06',strategy:{kind:'hold',capital:1000}});
  near(result.metrics.mdd,-0.25); near(result.metrics.maxCostLoss!.rate,0);
  assert.equal(runBacktest(data,{start:'2026-01-02',end:'2026-01-06',strategy:{kind:'hold',capital:50}}).metrics.maxCostLoss,undefined);
});
test('적립 매수 후 변한 평단과 분할을 반영하며 기간 축소·연장·시작 변경을 재계산', () => {
  const data=source([bar('2026-01-02',100),bar('2026-02-02',50),bar('2026-03-02',30)]);
  const request={start:'2026-01-02',end:'2026-02-02',strategy:{kind:'dca' as const,contribution:100,interval:'monthly' as const}};
  const runner=createBacktestRunner(data,request);
  near(runner.run(request.end).metrics.maxCostLoss!.rate,-0.25); // 3주, 원가200, 평가150
  const extended=runner.run('2026-03-02');
  assert.deepEqual(extended,runBacktest(data,{...request,end:'2026-03-02'}));
  near(runner.run('2026-01-02').metrics.maxCostLoss!.rate,0);
  near(runBacktest(data,{...request,start:'2026-02-02'}).metrics.maxCostLoss!.rate,0);
  data.splits=[{date:'2026-02-02',ratio:2}];
  near(runBacktest(data,{...request,strategy:{kind:'hold',capital:1000}}).metrics.maxCostLoss!.rate,0);
});
test('전량 매도로 보유0이 되어도 매도 직전 전체 보유분의 손실을 남김', () => {
  const loss=dailyCostLoss({quantity:10,cost:1000},[
    {date:'2026-01-05',side:'SELL',quantity:10,price:70,amount:700,realized:-300,reason:'exit'},
  ],'2026-01-05',100,false)!;
  near(loss.rate,-0.3); near(loss.amount,-300); assert.equal(loss.basis,'sell');
  assert.equal(loss.quantity,10);
});
test('매도 후 재진입은 새 평단을 사용하고 추정 구간은 추정 종가로 구분', () => {
  const data=source([{kind:'estimated-close',date:'2026-01-02',close:100},{kind:'estimated-close',date:'2026-01-05',close:80}]);
  const result=runBacktest(data,{start:'2026-01-02',end:'2026-01-05',strategy:{kind:'hold',capital:1000}});
  assert(result.metrics.maxCostLoss!.estimated); near(result.metrics.maxCostLoss!.rate,-0.2);
  const reset=dailyCostLoss({quantity:2,cost:200},[
    {date:'2026-01-05',side:'SELL',quantity:2,price:120,amount:240,realized:40,reason:'exit'},
    {date:'2026-01-05',side:'BUY',quantity:4,price:50,amount:200,realized:0,reason:'entry'},
  ],'2026-01-05',40,false)!;
  near(reset.averageCost,50); near(reset.rate,-0.2); near(reset.amount,-40);
});
