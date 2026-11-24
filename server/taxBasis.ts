import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { instrumentFor, isDate } from '../src/data/market.ts';
import { validateTaxBasis } from '../src/data/taxBasis.ts';
import { createDataStore } from './dataStore.ts';
import type { TaxBasisData } from '../src/tax/types.ts';

const funds:Record<string,string>={'418660.KS':'KR7418660007','360750.KS':'KR7360750004','133690.KS':'KR7133690008','225040.KS':'KR7225040005'};
export function taxBasisSource(symbol:string) {
  if(!funds[symbol]||instrumentFor(symbol).currency!=='KRW')throw new Error('과표기준가격을 지원하지 않는 종목입니다.');
  return `https://investments.miraeasset.com/tigeretf/ko/product/search/detail/price.ajax?ksdFund=${funds[symbol]}`;
}
export function parseTaxBasis(html:string,symbol:string,source:string,now=new Date()):TaxBasisData {
  taxBasisSource(symbol);
  if(!html.includes('과세기준가'))throw new Error('운용사 과세기준가 열이 없어 시세·NAV로 대체하지 않습니다.');
  const body=html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if(!body)throw new Error('과세기준가 표가 없습니다.');
  const points:{date:string;value:number}[]=[];
  for(const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell=>cell[1].replace(/<[^>]+>/g,'').replace(/&nbsp;|&#160;/g,' ').trim());
    if(cells.length===0)continue;
    const date=cells[0].replaceAll('.','-');
    if(!isDate(date)||cells.length!==8||!/^\d[\d,]*(?:\.\d+)?$/.test(cells[5]))throw new Error('과세기준가 표의 날짜·열·금액이 유효하지 않습니다.');
    points.push({date,value:Number(cells[5].replaceAll(',',''))});
  }
  points.sort((a,b)=>a.date.localeCompare(b.date));
  const version=createHash('sha256').update(JSON.stringify({symbol,points})).digest('hex');
  return validateTaxBasis({symbol,version,source,fetchedAt:now.toISOString(),points,warnings:[
    '운용사에서 공시한 일별 과세기준가입니다. 시장가격·NAV를 과표기준가격으로 대신하지 않습니다.',
    '상장 전 과표기준가격을 생성하지 않으며 매수·매도일 자료가 없으면 해당 세금은 산출 불가로 표시합니다. 분배금 과세·금융소득종합과세는 제외한 제한 모형입니다.',
  ]});
}
export async function fetchTaxBasis(symbol:string) {
  const source=taxBasisSource(symbol);
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
  const url=`${source}&startDate=19900101&endDate=${date}&period=`;
  const response=await fetch(url,{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`과표기준가격 조회 HTTP ${response.status}`);
  return parseTaxBasis(await response.text(),symbol,url);
}
export function createTaxBasisStore(directory:string,provider=fetchTaxBasis) {
  return createDataStore(join(directory,'tax-basis'),{validateKey:key=>{taxBasisSource(key);},validate:validateTaxBasis,fetch:provider,identity:(data,key)=>data.symbol===key});
}
