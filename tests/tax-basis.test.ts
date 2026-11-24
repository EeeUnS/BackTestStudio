import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTaxBasis,taxBasisSource} from '../server/taxBasis.ts';
const row=(date:string,tax:string)=>`<tr><td>${date}</td><td>25,000</td><td>1.00</td><td>25,116.07</td><td>1.09</td><td>${tax}</td><td>3500</td><td>1.09</td></tr>`;
const html=(rows:string)=>`<table><thead><th>과세기준가(원)</th></thead><tbody>${rows}</tbody></table>`;
test('운용사 과세기준가 열을 시장가격·NAV와 구분하고 날짜 오름차순·출처·버전을 보존',()=>{
  const symbol='360750.KS';const source=taxBasisSource(symbol);
  const data=parseTaxBasis(html(row('2026.11.12','25,129.13')+row('2026.11.11','24,859.37')),symbol,source);
  assert.deepEqual(data.points,[{date:'2026-11-11',value:24859.37},{date:'2026-11-12',value:25129.13}]);
  assert.equal(data.version,parseTaxBasis(html(row('2026.11.11','24,859.37')+row('2026.11.12','25,129.13')),symbol,source).version);
  assert.equal(data.source,source);
});
test('과표기준가의 누락·중복·잘못된 날짜와 해외상품은 거부하고 가격으로 메우지 않음',()=>{
  const symbol='133690.KS';const source=taxBasisSource(symbol);
  for(const text of [html(row('2026.11.12','-')),html(row('2026.02.30','100')),html(row('2026.11.12','100')+row('2026.11.12','200')),'<p>로그인</p>'])assert.throws(()=>parseTaxBasis(text,symbol,source));
  assert.throws(()=>taxBasisSource('TQQQ'));
});
