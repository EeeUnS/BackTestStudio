import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBars, aggregateEstimated, bucketKey, groupTrades, movingAverage, moveRange } from '../src/chart/data.ts';
import { profitSegments } from '../src/chart/profit.ts';
import { costZonePoints } from '../src/chart/zones.ts';
import { runSimpleBacktest } from '../src/engine/simpleBacktest.ts';
import type { MarketData, PriceBar } from '../src/data/market.ts';
import type { Trade } from '../src/engine/simpleBacktest.ts';
const bars: PriceBar[] = [
  { date: '2020-12-31', open: 100, high: 110, low: 90, close: 105, volume: 100 },
  { date: '2021-01-01', open: 106, high: 120, low: 100, close: 115, volume: 200 },
  { date: '2021-01-04', open: 116, high: 125, low: 111, close: 120, volume: 300 },
  { date: '2021-01-05', open: 120, high: 130, low: 119, close: 125 },
  { date: '2021-02-01', open: 125, high: 140, low: 120, close: 135, volume: 400 },
];
test('손익 영역은 실제 보유 평단을 사용하고 주봉은 마지막 계좌 상태로 집계한다', () => {
  const data: MarketData = { schema:1, symbol:'TQQQ', currency:'USD', timeZone:'America/New_York', source:'test', fetchedAt:'2021-02-02T00:00:00Z', priceBasis:'split-adjusted', version:'zones', bars, warnings:[], distributions:[], splits:[] };
  const result = runSimpleBacktest({ ...data, currency:'USD', distributions:[] }, { start:bars[0].date, end:bars.at(-1)!.date, strategy:{ kind:'hold', capital:1000 } });
  const daily = costZonePoints(data, result.days, aggregateBars(bars, 'day'));
  assert.equal(daily[0].cost, 100);
  assert.equal(daily[0].price, 105);
  assert.equal(daily[0].held, true);
  const weekly = costZonePoints(data, result.days, aggregateBars(bars, 'week'));
  assert.equal(weekly[0].price, 115);
  assert.equal(weekly[1].price, 125);
  const flat = result.days.map(day => ({ ...day, quantity:0, averageCost:0, stock:0 }));
  assert(costZonePoints(data, flat, aggregateBars(bars, 'day')).every(point => !point.held));
  const split = { ...data, splits:[{ date:'2021-02-01', ratio:2 }] };
  const restored = costZonePoints(split, result.days, aggregateBars(bars, 'day'));
  assert.equal(restored[0].cost, 50);
  assert.equal(restored[0].price, 52.5);
  assert.equal(restored.at(-1)!.cost, 100);
});
test('연도 경계를 넘는 주봉은 월요일 기준·첫 시가·최고/최저·마지막 종가·거래량 합계', () => {
  assert.equal(bucketKey('2021-01-01', 'week'), '2020-12-28');
  const result = aggregateBars(bars, 'week');
  assert.deepEqual(result[0], { date: '2020-12-31', endDate: '2021-01-01', open: 100, high: 120, low: 90, close: 115, volume: 300 });
  assert.equal(result.length, 3);
  assert.equal(result[1].volume, undefined);
});
test('월봉은 연도·월 경계로 집계하며 자료가 없는 거래량을 임의 생성하지 않음', () => {
  const result = aggregateBars(bars, 'month');
  assert.equal(result.length, 3);
  assert.equal(result[1].date, '2021-01-01');
  assert.equal(result[1].endDate, '2021-01-05');
  assert.equal(result[1].open, 106);
  assert.equal(result[1].close, 125);
  assert.equal(result[1].volume, undefined);
  assert.equal(bars[1].close, 115);
});
test('이평선은 현재 집계 봉 기준이며 충분한 봉 이후부터 계산', () => {
  const daily = aggregateBars(bars, 'day');
  assert.equal(movingAverage(daily, 2)[0].value, 110);
  const weekly = aggregateBars(bars, 'week');
  assert.deepEqual(movingAverage(weekly, 2)[0], { time: '2021-01-04', value: 120 });
  assert.equal(movingAverage(weekly, 20).length, 0);
  assert.equal(movingAverage(weekly, 0).length, 0);
  assert.equal(movingAverage(weekly, 1.5).length, 0);
});
test('같은 월봉의 여러 BUY/SELL은 묶되 실제 거래 내역·날짜·평균원가 손익을 보존', () => {
  const trades: Trade[] = [
    { date: '2021-01-01', side: 'BUY', price: 106, quantity: 2, amount: 212, realized: 0, reason: '정기 매수' },
    { date: '2021-01-04', side: 'BUY', price: 116, quantity: 1, amount: 116, realized: 0, reason: '정기 매수' },
    { date: '2021-01-05', side: 'SELL', price: 125, quantity: 1, amount: 125, realized: 15, reason: '사전 매도' },
  ];
  const grouped = groupTrades(trades, aggregateBars(bars, 'month'), 'month');
  assert.equal(grouped.size, 1);
  assert.deepEqual(grouped.get('2021-01-01'), trades);
  assert.equal(trades[2].realized, 15);
});
test('선택 영역 이동은 폭을 유지하며 양쪽 데이터 경계에서 멈춤', () => {
  assert.deepEqual(moveRange(2, 5, -100, 9), { start: 0, end: 3 });
  assert.deepEqual(moveRange(2, 5, 100, 9), { start: 6, end: 9 });
  assert.deepEqual(moveRange(0, 9, 2, 9), { start: 0, end: 9 });
});


test('손익 구간은 매도 원가·금액을 사용하고 분할 전후 수량을 같은 차트 단위로 가중 집계', () => {
  const data: MarketData = { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'test', fetchedAt: '2021-02-02T00:00:00Z', priceBasis: 'split-adjusted', version: 'profit-test', bars, warnings: [], distributions: [], splits: [{ date: '2021-01-04', ratio: 2 }] };
  const trades: Trade[] = [
    { date: '2021-01-01', side: 'SELL', price: 120, quantity: 2, amount: 240, realized: 40, reason: '매도1' },
    { date: '2021-01-05', side: 'SELL', price: 70, quantity: 4, amount: 280, realized: 80, reason: '매도2' },
    { date: '2021-01-05', side: 'SELL', price: 30, quantity: 1, amount: 30, realized: -10, reason: '손실' },
    { date: '2021-01-05', side: 'BUY', price: 30, quantity: 100, amount: 3000, realized: 0, reason: '짝짓기 금지' },
  ];
  const before = JSON.stringify(trades);
  const result = profitSegments(data, groupTrades(trades, aggregateBars(bars, 'month'), 'month'));
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { date: '2021-01-01', sign: 1, quantity: 8, price: 65, cost: 50, realized: 120, count: 2 });
  assert.deepEqual(result[1], { date: '2021-01-01', sign: -1, quantity: 1, price: 30, cost: 40, realized: -10, count: 1 });
  assert.equal(JSON.stringify(trades), before);
});
test('매수만 있으면 실현 구간 없음·본전 매도는 평균원가와 체결가 일치', () => {
  const data: MarketData = { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'test', fetchedAt: '2021-02-02T00:00:00Z', priceBasis: 'split-adjusted', version: 'profit-test', bars, warnings: [], distributions: [], splits: [] };
  const buy: Trade = { date: '2021-01-05', side: 'BUY', price: 100, quantity: 1, amount: 100, realized: 0, reason: '매수' };
  assert.deepEqual(profitSegments(data, new Map([['2021-01-05', [buy]]])), []);
  const result = profitSegments(data, new Map([['2021-01-05', [{ ...buy, side: 'SELL' }]]]));
  assert.equal(result[0].cost, 100);
  assert.equal(result[0].price, 100);
  assert.equal(result[0].sign, 0);
});


test('추정 주·월봉은 마지막 종가만 집계하고 OHLC·거래량을 만들지 않음', () => {
  const points = [{ date:'2021-01-04',close:100 },{ date:'2021-01-05',close:120 },{ date:'2021-01-11',close:110 }];
  const weekly = aggregateEstimated(points, 'week');
  assert.deepEqual(weekly[0], { kind:'estimated-close',date:'2021-01-04',endDate:'2021-01-05',close:120 });
  assert.equal(weekly.length,2);
  assert.deepEqual(aggregateEstimated(points, 'month'), [{ kind:'estimated-close',date:'2021-01-04',endDate:'2021-01-11',close:110 }]);
  assert(weekly.every(point => !('open' in point) && !('high' in point) && !('low' in point) && !('volume' in point)));
});
