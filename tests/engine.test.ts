import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accrueDividend, applySplit, buy, createAccount, deposit, payDividend, sell, settleSales, valueAccount, withdraw } from '../src/engine/account.ts';
import { cagr, xirr } from '../src/engine/metrics.ts';
import { contributionDates, runSimpleBacktest } from '../src/engine/simpleBacktest.ts';
import type { ExecutionData } from '../src/engine/simpleBacktest.ts';
import type { PriceBar } from '../src/data/market.ts';

function bar(date: string, open: number, close = open): PriceBar {
  return { date, open, close, high: Math.max(open, close), low: Math.min(open, close) };
}
function data(bars: PriceBar[]): ExecutionData { return { version: 'fixture', bars, splits: [], distributions: [] }; }
function near(actual: number, expected: number, tolerance = 1e-9) { assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`); }

test('원장: 이동평균 원가 부분매도, 매도금 다음 거래일 가용, 자산·손익 보존', () => {
  const account = createAccount();
  deposit(account, 1000);
  buy(account, 100, 200);
  buy(account, 80, 240);
  const sale = sell(account, 110, 2);
  assert.equal(sale.realized, 44);
  assert.equal(account.cost, 264);
  assert.equal(account.cash, 560);
  assert.equal(account.lockedCash, 220);
  assert.equal(valueAccount(account, 110).averageCost, 88);
  assert.equal(buy(account, 600, 1000).quantity, 0);
  settleSales(account);
  assert.equal(account.cash, 780);
  assert.equal(buy(account, 600, 1000).quantity, 1);
  near(valueAccount(account, 110).profit, account.realized + valueAccount(account, 110).unrealized);
});
test('원장: 차입·초과매도·단주 정산 미확보 거부, 외부 인출은 실제 지급액만', () => {
  const account = createAccount();
  deposit(account, 100);
  assert.equal(buy(account, 30, 1000).quantity, 3);
  assert.equal(account.cash, 10);
  assert.equal(withdraw(account, 100), 10);
  assert.equal(account.withdrawn, 10);
  assert.throws(() => sell(account, 30, 4), /수량/);
  assert.throws(() => applySplit(account, 0.5), /단주/);
  assert.throws(() => buy(account, 0, 10), /매수가/);
});
test('원장: 분할 시 원가 보존, 지급 전 분배금은 재사용 불가', () => {
  const account = createAccount();
  deposit(account, 240);
  buy(account, 80, 240);
  applySplit(account, 2);
  assert.equal(account.quantity, 6);
  assert.equal(valueAccount(account, 50).averageCost, 40);
  assert.equal(valueAccount(account, 50).total, 300);
  assert.equal(accrueDividend(account, 1), 6);
  assert.equal(account.cash, 0);
  assert.equal(buy(account, 1, 6).quantity, 0);
  assert.equal(valueAccount(account, 49).total, 300);
  payDividend(account, 6);
  assert.equal(account.cash, 6);
  assert.equal(account.receivable, 0);
});
test('일시불: 첫 시가 정수주·잔액·최종 종가 평가, 강제매도 없음', () => {
  const result = runSimpleBacktest(data([bar('2026-01-02', 300, 330)]), { start: '2026-01-02', end: '2026-01-02', strategy: { kind: 'hold', capital: 1000 } });
  const final = result.days[0];
  assert.equal(final.quantity, 3);
  assert.equal(final.cash, 100);
  assert.equal(final.total, 1090);
  assert.equal(final.profit, 90);
  assert.equal(final.realized, 0);
  assert.equal(result.trades.length, 1);
  near(result.metrics.twr, 0.09);
  assert.equal(result.metrics.cagr.available, false);
});
test('적립식: 초기금 없이 첫 납입, 잔액 이월, 추가 납입을 수익으로 계산하지 않음', () => {
  const result = runSimpleBacktest(data([bar('2026-01-02', 100), bar('2026-02-02', 120)]), { start: '2026-01-02', end: '2026-02-02', strategy: { kind: 'dca', contribution: 250, interval: 'monthly' } });
  assert.equal(result.days[0].quantity, 2);
  assert.equal(result.days[0].cash, 50);
  const final = result.days.at(-1)!;
  assert.equal(final.quantity, 4);
  assert.equal(final.cash, 60);
  assert.equal(final.deposited, 500);
  assert.equal(final.total, 540);
  near(result.metrics.twr, 0.16);
  assert.equal(result.metrics.cagr.available, false);
});
test('불변 가격 추가 납입: TWR·MDD·순손익 0', () => {
  const result = runSimpleBacktest(data([bar('2026-01-02', 100), bar('2026-02-02', 100)]), { start: '2026-01-02', end: '2026-02-02', strategy: { kind: 'dca', contribution: 1000, interval: 'monthly' } });
  assert.equal(result.days.at(-1)!.total, 2000);
  assert.equal(result.metrics.twr, 0);
  assert.equal(result.metrics.mdd, 0);
  assert.equal(result.days.at(-1)!.profit, 0);
});
test('TWR: 납입 전 시가 갭과 납입 후 장중 손익을 분리', () => {
  const result = runSimpleBacktest(data([bar('2026-01-02', 100), bar('2026-02-02', 200, 220)]), { start: '2026-01-02', end: '2026-02-02', strategy: { kind: 'dca', contribution: 1000, interval: 'monthly' } });
  assert.equal(result.days.at(-1)!.total, 3300);
  near(result.metrics.twr, 1.2);
});
test('적립 일정: 월 첫 거래일, 시작일 첫 납입 중복 없음, 격주와 윤일·휴장 이월', () => {
  const bars = ['2024-02-28', '2024-02-29', '2024-03-04', '2024-03-13', '2024-03-27', '2024-04-01'].map(date => bar(date, 100));
  assert.deepEqual([...contributionDates(bars, '2024-02-28', 'monthly')], ['2024-02-28', '2024-03-04', '2024-04-01']);
  assert.deepEqual([...contributionDates(bars, '2024-02-28', 'biweekly')], ['2024-02-28', '2024-03-13', '2024-03-27']);
  assert.deepEqual([...contributionDates(bars, '2024-03-02', 'weekly')], ['2024-03-04', '2024-03-13', '2024-03-27', '2024-04-01']);
});
test('시작일 변경은 보유량·원가·납입 일정을 재생성하며 휴장일은 다음 거래일', () => {
  const source = data([bar('2024-02-28', 100), bar('2024-03-04', 200), bar('2024-03-11', 100), bar('2024-03-18', 100)]);
  const full = runSimpleBacktest(source, { start: '2024-02-28', end: '2024-03-18', strategy: { kind: 'dca', contribution: 250, interval: 'weekly' } });
  const moved = runSimpleBacktest(source, { start: '2024-03-02', end: '2024-03-18', strategy: { kind: 'dca', contribution: 250, interval: 'weekly' } });
  assert.equal(moved.start, '2024-03-04');
  assert.equal(moved.days[0].quantity, 1);
  assert.equal(moved.days[0].cash, 50);
  assert.equal(moved.days[0].deposited, 250);
  assert.notEqual(moved.days.at(-1)!.total, full.days.at(-1)!.total);
});
test('분할과 분배금: 권리 수량으로 미수금, 지급일 현금 전환, 마지막 미수자산 포함', () => {
  const source = data([bar('2026-01-02', 80, 100), bar('2026-01-05', 50), bar('2026-01-06', 49), bar('2026-01-07', 49), bar('2026-01-08', 49)]);
  source.splits = [{ date: '2026-01-05', ratio: 2 }];
  source.distributions = [{ exDate: '2026-01-06', payDate: '2026-01-08', amount: 1 }];
  const result = runSimpleBacktest(source, { start: '2026-01-02', end: '2026-01-08', strategy: { kind: 'hold', capital: 240 } });
  assert.equal(result.days[1].quantity, 6);
  assert.equal(result.days[1].cost, 240);
  assert.equal(result.days[2].receivable, 6);
  assert.equal(result.days[2].cash, 0);
  assert.equal(result.days[2].total, 300);
  assert.equal(result.days[4].receivable, 0);
  assert.equal(result.days[4].cash, 6);
  assert.equal(result.days[4].total, 300);
  assert.equal(result.days[4].profit, 60);
  const shorter = runSimpleBacktest(source, { start: '2026-01-02', end: '2026-01-07', strategy: { kind: 'hold', capital: 240 } });
  assert.equal(shorter.days.at(-1)!.receivable, 6);
  assert.deepEqual(shorter.days, result.days.slice(0, -1));
});
test('권리락일 첫 진입은 그날 분배금 수령 대상이 아님', () => {
  const source = data([bar('2026-01-02', 100), bar('2026-01-05', 99), bar('2026-01-06', 99)]);
  source.distributions = [{ exDate: '2026-01-05', payDate: '2026-01-06', amount: 1 }];
  const result = runSimpleBacktest(source, { start: '2026-01-05', end: '2026-01-06', strategy: { kind: 'hold', capital: 1000 } });
  assert.equal(result.days.at(-1)!.dividendIncome, 0);
});
test('입금으로 낙폭 희석 금지: 운용 곡선 기준 MDD', () => {
  const result = runSimpleBacktest(data([bar('2026-01-02', 100), bar('2026-01-05', 50), bar('2026-02-02', 50)]), { start: '2026-01-02', end: '2026-02-02', strategy: { kind: 'dca', contribution: 1000, interval: 'monthly' } });
  near(result.metrics.mdd, -0.5);
  near(result.metrics.twr, -0.5);
  assert.equal(result.days.at(-1)!.total, 1500);
});
test('XIRR ACT/365 10%, 무해·다중 해 가능성은 사유 반환', () => {
  const rate = xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1100 }]);
  assert(rate.available);
  near(rate.value, 0.1);
  assert.equal(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: -100 }]).available, false);
  const multiple = xirr([{ date: '2023-01-01', amount: -100 }, { date: '2024-01-01', amount: 230 }, { date: '2025-01-01', amount: -132 }]);
  assert(!multiple.available);
  assert.match(multiple.reason, /다중/);
  assert.equal(cagr(1000, 1100, '2023-01-01', '2024-01-01').available, true);
});
test('반복 계산 일치, 데이터 범위·중복·분배금 미검증 입력 거부', () => {
  const source = data([bar('2026-01-02', 100), bar('2026-01-05', 120)]);
  const request = { start: '2026-01-02', end: '2026-01-05', strategy: { kind: 'hold' as const, capital: 1000 } };
  assert.deepEqual(runSimpleBacktest(source, request), runSimpleBacktest(source, request));
  assert.throws(() => runSimpleBacktest(source, { ...request, start: '1990-01-01' }), /범위/);
  assert.throws(() => runSimpleBacktest({ ...source, bars: [source.bars[0], source.bars[0]] }, request), /날짜/);
  assert.throws(() => runSimpleBacktest({ ...source, distributions: [{ exDate: '2026-01-05', payDate: '', amount: 1 }] }, request), /지급일/);
});

test('휴장일 지급 분배금은 다음 거래일 현금에 반영되며 자동 재투자하지 않음', () => {
  const source = data([bar('2026-01-02', 100), bar('2026-01-05', 99), bar('2026-01-09', 99), bar('2026-01-12', 99)]);
  source.distributions = [{ exDate: '2026-01-05', payDate: '2026-01-10', amount: 1 }];
  const result = runSimpleBacktest(source, { start: '2026-01-02', end: '2026-01-12', strategy: { kind: 'hold', capital: 1000 } });
  assert.equal(result.days[2].receivable, 10);
  assert.equal(result.days[2].cash, 0);
  assert.equal(result.days[3].cash, 10);
  assert.equal(result.days[3].quantity, 10);
  assert.equal(result.trades.length, 1);
  near(result.metrics.twr, 0);
});
test('권리락·분할일 가격 결측을 다음 거래일로 조용히 미루지 않음', () => {
  const source = data([bar('2026-01-02', 100), bar('2026-01-06', 99)]);
  source.distributions = [{ exDate: '2026-01-05', payDate: '2026-01-09', amount: 1 }];
  assert.throws(() => runSimpleBacktest(source, { start: '2026-01-02', end: '2026-01-06', strategy: { kind: 'hold', capital: 1000 } }), /거래 봉/);
});
