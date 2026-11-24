import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountEligibility, validateWithdrawalDraft } from '../src/phase2/settings.ts';

test('계좌 선택: 해외 ETF는 일반계좌만, 국내 레버리지는 연금 금지',()=>{
  for(const symbol of ['TQQQ','QLD','QQQ','SPY','SOXL']) {
    assert(accountEligibility(symbol,'general').allowed);
    assert.equal(accountEligibility(symbol,'isa').allowed,false);
    assert.equal(accountEligibility(symbol,'pension').allowed,false);
  }
  assert(accountEligibility('418660.KS','isa').allowed);
  assert.equal(accountEligibility('418660.KS','pension').allowed,false);
  assert.match(accountEligibility('418660.KS','pension').reason,/레버리지/);
  assert.equal(accountEligibility('unknown','general').allowed,false);
});
test('확인된 국내 비레버리지 ETF는 일반·ISA·연금 선택 가능',()=>{
  for(const symbol of ['360750.KS','133690.KS'])for(const account of ['general','isa','pension'] as const)assert(accountEligibility(symbol,account).allowed);
});
test('인출 편집: 윤일·유효 금액은 허용하고 불가능 날짜·공백·비유한 금액은 거부',()=>{
  assert.equal(validateWithdrawalDraft('2024-02-29','1500.25'),undefined);
  assert.equal(validateWithdrawalDraft('2026-11-14','1'),undefined);
  for(const date of ['2026-02-29','2026-11-31','', '2026-1-01'])assert.match(validateWithdrawalDraft(date,'100')!,/요청일/);
  for(const amount of ['', ' ', '0', '-1', 'Infinity', 'NaN', '1e100'])assert.match(validateWithdrawalDraft('2026-11-14',amount)!,/금액/);
});
