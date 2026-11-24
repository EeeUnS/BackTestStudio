import { isDate } from '../data/market.ts';
import { validateFx } from '../data/fx.ts';
import type { FxData } from '../data/fx.ts';
import { xirr } from '../engine/metrics.ts';
import type { CashFlow, Metric } from '../engine/metrics.ts';
import type { BacktestResult, ExecutionData, Trade } from '../engine/simpleBacktest.ts';
import { anniversary, resolveBusinessDate, settlementDate, taxPaymentDate } from './calendar.ts';
import { createTaxLots } from './lots.ts';
import { TAX_POLICY, TAX_SCOPE_NOTICE } from './policy.ts';
import type { AnnualTaxRow, BusinessCalendar, TaxBasisData, TaxOptions, TaxReport, TaxTrade } from './types.ts';

export type TaxCalendars={US?:BusinessCalendar;KR?:BusinessCalendar};
type TaxExecutionData=ExecutionData & {symbol?:string;currency?:string};
const unavailable=(reason:string):Metric=>({available:false,reason});
const daysBetween=(a:string,b:string)=>(Date.parse(b)-Date.parse(a))/86400000;
function baseReport(options:TaxOptions):TaxReport {
  return {status:options.enabled?'unavailable':'disabled',account:options.account,scenario:options.scenario,costMethod:options.costMethod,policyVersion:TAX_POLICY.version,
    warnings:[TAX_SCOPE_NOTICE,'현재 세율·공제·결제주기를 전체 과거 기간에 고정합니다. 과거 세법이나 실제 신고서를 재현하지 않습니다.'],sources:[...TAX_POLICY.sources],annual:[],events:[],trades:[],paid:0,unpaid:0,accrued:0,
    afterTaxXirr:unavailable('세후 현금흐름 계산 전입니다.'),projectedAfterTaxXirr:unavailable('세후 현금흐름 계산 전입니다.'),curve:[],flows:[],projectedFlows:[]};
}
function calendarFor(calendars:TaxCalendars|BusinessCalendar|undefined,market:'US'|'KR') {
  if(!calendars)return undefined;
  return 'market' in calendars?(calendars.market===market?calendars:undefined):calendars[market];
}
function validateBasis(data:TaxBasisData,symbol:string) {
  if(data.symbol!==symbol||!data.version||!data.source||!Number.isFinite(Date.parse(data.fetchedAt))||!Array.isArray(data.points))throw new Error('과표기준가격 메타데이터 오류입니다.');
  let previous='';for(const point of data.points){if(!isDate(point.date)||point.date<=previous||!Number.isFinite(point.value)||point.value<0)throw new Error('과표기준가격 날짜·값 오류입니다.');previous=point.date;}
}
export function analyzeTax(result:BacktestResult,data:TaxExecutionData,options:TaxOptions,fx?:FxData,taxBasis?:TaxBasisData,calendars?:TaxCalendars|BusinessCalendar):TaxReport {
  const report=baseReport(options);
  if(options.account==='isa')report.warnings.push('사용자 지정 가정: ISA 공제액을 0원으로 적용합니다. 실제 ISA 비과세 제도를 적용한 결과가 아닙니다.');
  if(!options.enabled){report.reason='세금 계산을 적용하지 않았습니다.';report.afterTaxXirr=unavailable(report.reason);report.projectedAfterTaxXirr=unavailable(report.reason);return report;}
  try{return calculate(result,data,options,report,fx,taxBasis,calendars);}catch(error){
    report.status='unavailable';report.reason=error instanceof Error?error.message:'세금 계산 자료가 부족합니다.';
    report.afterTaxXirr=unavailable(report.reason);report.projectedAfterTaxXirr=unavailable(report.reason);
    report.annual=[];report.events=[];report.curve=[];report.flows=[];report.projectedFlows=[];
    delete report.accountValueKrw;delete report.afterTaxValueKrw;delete report.settlement;
    return report;
  }
}
function calculate(result:BacktestResult,data:TaxExecutionData,options:TaxOptions,report:TaxReport,fx?:FxData,taxBasis?:TaxBasisData,calendars?:TaxCalendars|BusinessCalendar) {
  if (data.symbol === 'QQQ5.L') { throw new Error('QQQ5의 런던 거래소 결제일 기반 세금 계산은 지원하지 않습니다.'); }
  if(!['general','isa','pension'].includes(options.account)||!['fifo','average'].includes(options.costMethod)||!['hold','liquidate'].includes(options.scenario))throw new Error('계좌·원가·종료 시나리오 설정 오류입니다.');
  if(result.accountReport&&result.accountReport.kind!==options.account)throw new Error('계산 원장의 계좌와 과세 설정의 계좌가 다릅니다. 계좌를 일치시켜 다시 계산하세요.');
  const currency=data.currency??(data.symbol?.endsWith('.KS')?'KRW':'USD');
  const domestic=currency==='KRW';const market=domestic?'KR':'US';
  if(!domestic&&options.account!=='general')throw new Error('해외 상장 ETF는 ISA·연금저축에서 직접 거래할 수 없습니다.');
  if((data.symbol==='418660.KS'||data.symbol==='225040.KS')&&options.account==='pension')throw new Error('레버리지 ETF는 연금저축에서 거래할 수 없습니다.');
  if(!result.days.length)throw new Error('분석할 계좌 원장이 없습니다.');
  let estimated=false;
  if(!domestic){if(!fx)throw new Error('미국 ETF 세금 계산에는 표시 설정과 관계없이 거래별 환율 자료가 필요합니다.');validateFx(fx);report.fxVersion=fx.version;report.sources.push(...fx.sources);
    estimated=true;report.warnings.push('세금용 법정 기준환율의 전수 대조가 없어 입력 환율을 대용치로 사용하는 추정 세액입니다. 환율 관측일과 결제 대표일을 원장에 보존합니다.');}
  if(taxBasis){validateBasis(taxBasis,data.symbol??taxBasis.symbol);report.taxBasisVersion=taxBasis.version;report.sources.push(taxBasis.source);report.warnings.push(...taxBasis.warnings??[]);}
  const basisMap=new Map(taxBasis?.points.map(point=>[point.date,point.value]));
  function rateAt(date:string,settlement=false) {
    if(domestic)return {rate:1,observationDate:date};
    const observations=fx!.observations;let left=0,right=observations.length;
    while(left<right){const middle=(left+right)>>>1;if(observations[middle].date<=date)left=middle+1;else right=middle;}
    if(left===0)throw new Error(`${date}: 취득·매도 환산에 쓸 과거 환율이 없습니다.`);
    const observation=observations[left-1];
    if(daysBetween(observation.date,date)>14)throw new Error(`${date}: 환율 관측이14일 넘게 오래되어 세금을 계산하지 않습니다.`);
    // Actual observations beyond valuation end may be absent. Do not invent a future FX rate.
    if(settlement&&date>result.end&&date>observations.at(-1)!.date)estimated=true;
    return {rate:observation.rate,observationDate:observation.date};
  }
  const final=result.days.at(-1)!;
  const selectedTrades=result.trades.map(trade=>({...trade,hypothetical:false}));
  const needsLiquidation=options.account!=='general'||options.scenario==='liquidate';
  if(needsLiquidation&&final.quantity>0)selectedTrades.push({date:result.end,side:'SELL',price:final.stock/final.quantity,quantity:final.quantity,amount:final.stock,realized:final.unrealized,reason:'종료 전량 매도 가정',hypothetical:true});
  const lots=createTaxLots(domestic?'average':options.costMethod);
  const splits=data.splits.filter(split=>split.date>=result.start&&split.date<=result.end).toSorted((a,b)=>a.date.localeCompare(b.date));let splitIndex=0;
  let unknownBasis=false;let totalTaxable=0;const rawRows=new Map<number,AnnualTaxRow>();
  function yearRow(year:number,kind:AnnualTaxRow['kind']) {
    let row=rawRows.get(year);if(!row){row={year,profit:0,loss:0,net:0,deduction:0,taxable:0,tax:0,paid:0,unpaid:0,paymentDate:'',kind,estimated:false};rawRows.set(year,row);}return row;
  }
  const settlementCalendar=calendarFor(calendars,market);
  let exactDates=true;
  for(const trade of selectedTrades){
    while(splitIndex<splits.length&&splits[splitIndex].date<=trade.date)lots.split(splits[splitIndex++].ratio);
    const settlement=settlementDate(trade.date,market,settlementCalendar);
    if(!settlement.exact){estimated=true;exactDates=false;}
    const observation=rateAt(settlement.date,true);
    const amountKrw=trade.amount*observation.rate;
    const entry:TaxTrade={date:trade.date,settlementDate:settlement.date,side:trade.side,quantity:trade.quantity,price:trade.price,amountKrw,exchangeRate:observation.rate,exchangeObservationDate:observation.observationDate,exactSettlement:settlement.exact,estimated:!settlement.exact||Boolean(trade.estimated)||!domestic,hypothetical:trade.hypothetical};
    const basis=trade.estimated?undefined:basisMap.get(trade.date);
    if(trade.side==='BUY')lots.buy({quantity:trade.quantity,cost:amountKrw,basisCost:basis===undefined?undefined:basis*trade.quantity,acquired:trade.date,settlementDate:settlement.date,rate:observation.rate,observationDate:observation.observationDate});
    else {
      const removed=lots.sell(trade.quantity);const realized=amountKrw-removed.cost;
      entry.costKrw=removed.cost;entry.realizedKrw=realized;
      const year=Number(settlement.date.slice(0,4));
      const row=yearRow(year,domestic?'withholding':'capital-gains');
      row.profit+=Math.max(0,realized);row.loss+=Math.min(0,realized);row.net+=realized;row.estimated ||= entry.estimated;
      if(domestic){
        if(realized<=0){entry.taxable=options.account==='isa'?realized:0;}
        else if(basis===undefined||removed.basisCost===undefined){unknownBasis=true;}
        else entry.taxable=Math.min(realized,Math.max(0,basis*trade.quantity-removed.basisCost));
        if(entry.taxable!==undefined){totalTaxable+=entry.taxable;row.taxable+=Math.max(0,entry.taxable);}
        if(options.account==='general'&&entry.taxable!==undefined){
          const tax=Math.max(0,entry.taxable)*TAX_POLICY.domesticRate;row.tax+=tax;
          const paid=settlement.date<=result.end?tax:0;row.paid+=paid;row.unpaid+=tax-paid;row.paymentDate=settlement.date;
          if(tax>0)report.events.push({date:settlement.date,kind:'withholding',amount:tax,year,estimated:entry.estimated,reason:'국내 ETF 보유기간 과세 · 실제 원천징수 상당액의 외부 보전 지출'});
        }
      }
    }
    report.trades.push(entry);
  }
  const accountReport=(result as BacktestResult&{accountReport?:{principalRemaining:number;withdrawalTax:number;withdrawnGross:number;withdrawnNet:number;openedAt:string;withdrawals?:{tax:number;paidDate?:string;payments?:{date:string;tax:number}[]}[]}}).accountReport;
  if(domestic&&options.account!=='pension'&&unknownBasis)throw new Error('양(+)의 매도차익이 있으나 해당 취득·매도일 과표기준가격이 없습니다. 세금을0으로 대체하지 않습니다.');
  if(options.account==='general'&&!domestic){
    for(const row of rawRows.values()){
      row.deduction=Math.min(Math.max(0,row.net),TAX_POLICY.overseasDeduction);row.taxable=Math.max(0,row.net-row.deduction);row.tax=row.taxable*TAX_POLICY.overseasRate;
      const due=taxPaymentDate(row.year,calendarFor(calendars,'KR'));row.paymentDate=due.date;row.estimated ||= !due.exact;
      if(!due.exact)estimated=true;
      row.paid=due.date<=result.end?row.tax:0;row.unpaid=row.tax-row.paid;
      if(row.tax>0)report.events.push({date:due.date,kind:'payment',amount:row.tax,year:row.year,estimated:row.estimated,reason:'다음 해5월 대표 납부일·외부 자금 납부'});
    }
    const running=new Map<number,{net:number;tax:number}>();
    for(const entry of report.trades.filter(entry=>entry.side==='SELL')){
      const year=Number(entry.settlementDate.slice(0,4));const previous=running.get(year)??{net:0,tax:0};
      const net=previous.net+entry.realizedKrw!;const tax=Math.max(0,net-TAX_POLICY.overseasDeduction)*TAX_POLICY.overseasRate;
      const delta=tax-previous.tax;if(delta!==0)report.events.push({date:entry.settlementDate,kind:'accrual',amount:delta,year,estimated:entry.estimated,reason:'연도 내 실현 손익 누계로 갱신한 예상 세금·연간 공제1회'});
      running.set(year,{net,tax});
    }
  }
  const finalRate=rateAt(result.end);const accountValue=final.total*finalRate.rate;
  report.accountValueKrw=accountValue;
  const flows:CashFlow[]=result.flows.map(flow=>({date:flow.date,amount:flow.amount*rateAt(flow.date).rate}));
  if(options.account!=='general'){
    const opened=accountReport?.openedAt??result.start;
    let lastSettlement={date:result.end,exact:true,source:'추가 매도·미결제 거래 없음',version:TAX_POLICY.version};
    for(const entry of report.trades){if(entry.side==='SELL'&&entry.settlementDate>lastSettlement.date)lastSettlement={date:entry.settlementDate,exact:entry.exactSettlement,source:'거래 원장 최종 결제',version:TAX_POLICY.version};}
    const minimum=options.account==='isa'?anniversary(opened,TAX_POLICY.isaYears):undefined;
    const target=[lastSettlement.date,minimum??lastSettlement.date].sort().at(-1)!;
    const resolved=resolveBusinessDate(target,'KR',calendarFor(calendars,'KR'));
    const principal=accountReport?.principalRemaining??Math.max(0,final.deposited-final.withdrawn);
    const taxable=options.account==='isa'?Math.max(0,totalTaxable):Math.max(0,accountValue-principal);
    const deduction=options.account==='isa'?Math.min(taxable,TAX_POLICY.isaDeduction):0;
    const rate=options.account==='isa'?TAX_POLICY.isaRate:TAX_POLICY.pensionWithdrawalRate;
    const tax=Math.max(0,taxable-deduction)*rate;
    const previousTax=options.account==='pension'?(accountReport?.withdrawalTax??0):0;
    report.settlement={investmentEnd:result.end,liquidationDate:result.end,settlementDate:resolved.date,minimumHoldingDate:minimum,waitingDays:Math.max(0,daysBetween(result.end,resolved.date)),gross:accountValue,tax,net:accountValue-tax,taxable,deduction,rate,principal,exactDate:lastSettlement.exact&&resolved.exact};
    estimated ||= !report.settlement.exactDate;
    report.events=[...report.events,{date:resolved.date,kind:'settlement',amount:tax,year:Number(resolved.date.slice(0,4)),estimated:!report.settlement.exactDate,reason:options.account==='isa'?'가입3년 충족·매도결제 후 정상해지':'세액공제 없는 원금 우선·전액 중도인출'}];
    const row:AnnualTaxRow={year:Number(resolved.date.slice(0,4)),profit:Math.max(0,final.profit),loss:Math.min(0,final.profit),net:final.profit,deduction,taxable:Math.max(0,taxable-deduction),tax,paid:0,unpaid:tax,paymentDate:resolved.date,kind:'settlement',estimated:!report.settlement.exactDate};
    const pensionRows=new Map<number,AnnualTaxRow>();
    if(options.account==='pension'){
      let recordedTax=0;
      const pensionPayments=(accountReport?.withdrawals??[]).flatMap(withdrawal=>withdrawal.payments?.length?withdrawal.payments:withdrawal.paidDate?[{date:withdrawal.paidDate,tax:withdrawal.tax}]:[]);
      for(const payment of pensionPayments){
        if(payment.tax<=0)continue;
        recordedTax+=payment.tax;const year=Number(payment.date.slice(0,4));
        const previous=pensionRows.get(year)??{year,profit:0,loss:0,net:0,deduction:0,taxable:0,tax:0,paid:0,unpaid:0,paymentDate:payment.date,kind:'withholding' as const,estimated:false};
        const income=payment.tax/TAX_POLICY.pensionWithdrawalRate;previous.taxable+=income;previous.profit+=income;previous.net+=income;previous.tax+=payment.tax;previous.paid+=payment.tax;previous.paymentDate=payment.date;pensionRows.set(year,previous);
        report.events.push({date:payment.date,kind:'withholding',amount:payment.tax,year,estimated:false,reason:'연금 중간 인출 수익 부분 원천세·순수령 현금흐름에 이미 반영'});
      }
      if(previousTax-recordedTax>1e-7){row.tax+=previousTax-recordedTax;row.paid+=previousTax-recordedTax;row.taxable+=(previousTax-recordedTax)/TAX_POLICY.pensionWithdrawalRate;row.estimated=true;estimated=true;report.warnings.push('중간 연금 세액 합계의 지급일별 상세가 일부 없어 정산 연도 표에 구분 합산했습니다. 세후 현금흐름은 기존 순수령 기록을 사용합니다.');}
    }
    const existing=pensionRows.get(row.year);
    if(existing){row.tax+=existing.tax;row.paid+=existing.paid;row.taxable+=existing.taxable;pensionRows.delete(row.year);}
    report.annual=[...pensionRows.values(),row].sort((a,b)=>a.year-b.year);report.paid=previousTax;report.unpaid=tax;report.accrued=tax+previousTax;
    report.afterTaxValueKrw=accountValue-tax;
    report.flows=[...flows,{date:resolved.date,amount:accountValue-tax}];report.projectedFlows=report.flows;
    report.afterTaxXirr=xirr(report.flows);report.projectedAfterTaxXirr=report.afterTaxXirr;
    report.warnings.push('절세계좌는 종료일 전량 매도 후 정산합니다. 현금 대기 이자·추가 거래·추가 납입은0이며, 인출 시 이미 납부한 세액은 최종 원금·수익에서 중복 차감하지 않습니다.');
  }else{
    report.annual=[...rawRows.values()].sort((a,b)=>a.year-b.year);
    report.paid=report.annual.reduce((sum,row)=>sum+row.paid,0);report.unpaid=report.annual.reduce((sum,row)=>sum+row.unpaid,0);report.accrued=report.paid+report.unpaid;
    report.afterTaxValueKrw=options.scenario==='hold'?accountValue:accountValue-report.accrued;
    const payments=report.events.filter(event=>['payment','withholding'].includes(event.kind)&&event.date<=result.end).map(event=>({date:event.date,amount:-event.amount}));
    report.flows=[...flows,...payments,{date:result.end,amount:accountValue}];report.afterTaxXirr=xirr(report.flows);
    const future=report.events.filter(event=>['payment','withholding'].includes(event.kind)&&event.date>result.end).map(event=>({date:event.date,amount:-event.amount}));
    report.projectedFlows=[...report.flows,...future];report.projectedAfterTaxXirr=xirr(report.projectedFlows);
    report.warnings.push('외부 납세는 전략 현금·수량을 줄이지 않습니다. 미납세액의 향후 지출은 이미 계산한 원화 금액을 사용하며 미래 환율을 생성하지 않습니다.');
  }
  report.curve=result.days.map(day=>({date:day.date,accountValue:day.total*rateAt(day.date).rate}));
  if(!exactDates)report.warnings.push('공식 결제영업일 달력 미확보 구간은 주말만 제외한 대표일 근사입니다. 공휴일에 따라 결제·연말 귀속·인출·납부일이 달라질 수 있으므로 확정 세액이 아닙니다.');
  if(result.days.some(day=>day.estimated))estimated=true;
  report.warnings.push('세액은 제한 모형의 세율 곱 계산값을 소수까지 보존합니다. 실무의 국세·지방세별 원단위 절사·과세유보금액 및 분배금 조정은 별도로 검증된 신고 계산이 아닙니다.');
  report.status=estimated?'estimated':'available';
  return report;
}
