import { instrumentFor, isDate, record } from './market.ts';
import type { TaxBasisData } from '../tax/types.ts';

export function validateTaxBasis(value: unknown): TaxBasisData {
  const data=record(value);
  if(typeof data.symbol!=='string'||instrumentFor(data.symbol).currency!=='KRW'||typeof data.version!=='string'||!data.version
    ||typeof data.source!=='string'||!data.source.startsWith('https://')||typeof data.fetchedAt!=='string'||!Number.isFinite(Date.parse(data.fetchedAt))
    ||!Array.isArray(data.points)||data.points.length===0||data.points.length>30000
    ||(data.warnings!==undefined&&(!Array.isArray(data.warnings)||data.warnings.some(item=>typeof item!=='string'))))throw new Error('과표기준가격 메타데이터 오류입니다.');
  let previous='';
  for(const raw of data.points){const point=record(raw);if(!isDate(point.date)||point.date<=previous||typeof point.value!=='number'||!Number.isFinite(point.value)||point.value<0)throw new Error('과표기준가격 날짜·중복·금액 오류입니다.');previous=point.date;}
  return data as unknown as TaxBasisData;
}
