import {test} from 'node:test';
import assert from 'node:assert/strict';
import {instrumentFor,instruments,underlyingIndex} from '../src/data/market.ts';
import {prepareExecution} from '../src/data/execution.ts';
test('신규 TIGER 두 상품은 별도 티커·KRW·1배와 각각의 기초지수를 사용',()=>{
  assert.equal(instruments.length,12);
  for(const symbol of ['360750.KS','133690.KS'] as const){const item=instrumentFor(symbol);assert.equal(item.currency,'KRW');assert.equal(item.leverage,1);assert.equal(item.zone,'Asia/Seoul');}
  assert.equal(underlyingIndex('360750.KS'),'SP500');assert.equal(underlyingIndex('133690.KS'),'NDX');
  const item=instrumentFor('360750.KS');
  const data={schema:1 as const,symbol:item.symbol,currency:item.currency,timeZone:item.zone,source:'test',fetchedAt:'2026-11-14T00:00:00Z',priceBasis:'split-adjusted' as const,version:'test',bars:[{date:'2026-11-12',open:100,high:100,low:100,close:100}],splits:[],distributions:[],warnings:[]};
  const prepared=prepareExecution(data,'2026-11-12','2026-11-12');
  assert.equal(prepared.symbol,item.symbol);assert.equal(prepared.currency,'KRW');
});

test('S&P500 레버리지 세 종목은 올바른 배수와 기초지수를 사용',()=>{
  for(const [symbol,leverage,currency] of [['UPRO',3,'USD'],['SSO',2,'USD'],['225040.KS',2,'KRW']] as const){
    const item=instrumentFor(symbol);
    assert.equal(item.leverage,leverage);
    assert.equal(item.currency,currency);
    assert.equal(underlyingIndex(symbol),'SP500');
  }
});
