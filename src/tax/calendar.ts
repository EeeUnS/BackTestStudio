import { isDate } from '../data/market.ts';
import type { BusinessCalendar, DateResolution } from './types.ts';

const dayMs=86400000;
export function addCalendarDays(date: string, count: number) {
  if(!isDate(date)||!Number.isInteger(count))throw new Error('날짜 계산 입력 오류입니다.');
  return new Date(Date.parse(date)+count*dayMs).toISOString().slice(0,10);
}
export function anniversary(date: string, years: number) {
  const next=`${Number(date.slice(0,4))+years}${date.slice(4)}`;
  return isDate(next)?next:`${Number(date.slice(0,4))+years}-02-28`;
}
export function validateCalendar(calendar: BusinessCalendar) {
  if(!['US','KR'].includes(calendar.market)||!calendar.version||!calendar.source||!isDate(calendar.from)||!isDate(calendar.to)||calendar.from>calendar.to||!Array.isArray(calendar.businessDays))throw new Error('결제 달력 메타데이터 오류입니다.');
  let previous='';
  for(const date of calendar.businessDays){if(!isDate(date)||date<=previous||date<calendar.from||date>calendar.to)throw new Error('결제 달력 날짜·정렬 오류입니다.');previous=date;}
  return calendar;
}
export function resolveBusinessDate(date: string, market: 'US'|'KR', calendar?: BusinessCalendar): DateResolution {
  if(!isDate(date))throw new Error('영업일 입력 오류입니다.');
  if(calendar){validateCalendar(calendar);if(calendar.market!==market)throw new Error('결제 달력 시장이 다릅니다.');
    const found=calendar.businessDays.find(day=>day>=date);
    if(date>=calendar.from&&found&&found<=calendar.to)return {date:found,exact:true,source:calendar.source,version:calendar.version};
  }
  let next=date;
  while([0,6].includes(new Date(next).getUTCDay()))next=addCalendarDays(next,1);
  return {date:next,exact:false,source:'대표 영업일 근사: 주말만 제외, 현지 공휴일·결제기관 휴일 미검증',version:'weekday-estimate-v1'};
}
export function settlementDate(date: string, market: 'US'|'KR', calendar?: BusinessCalendar): DateResolution {
  if(!isDate(date))throw new Error('결제일 입력 오류입니다.');
  const count=market==='US'?1:2;
  if(calendar){validateCalendar(calendar);if(calendar.market!==market)throw new Error('결제 달력 시장이 다릅니다.');
    const eligible=calendar.businessDays.filter(day=>day>date);
    if(date>=calendar.from&&date<=calendar.to&&eligible.length>=count)return {date:eligible[count-1],exact:true,source:calendar.source,version:calendar.version};
  }
  let next=date;
  for(let i=0;i<count;i++)next=resolveBusinessDate(addCalendarDays(next,1),market).date;
  return {date:next,exact:false,source:`현행 ${market==='US'?'T+1':'T+2'} 고정 · 주말 제외 대표일 · 공휴일 미검증`,version:'weekday-estimate-v1'};
}
export function taxPaymentDate(year: number, calendar?: BusinessCalendar) {
  return resolveBusinessDate(`${year+1}-05-31`,'KR',calendar);
}
