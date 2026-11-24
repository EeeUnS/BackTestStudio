import { isDate, instrumentFor } from '../data/market.ts';
import type { SymbolCode } from '../data/market.ts';
import { isEstimatedClose, openingPrice } from '../data/prices.ts';
import type { ExecutionBar } from '../data/prices.ts';
import { sell, withdraw, valueAccount } from '../engine/account.ts';
import type { Account } from '../engine/account.ts';
import type { Trade } from '../engine/simpleBacktest.ts';
import { settlementDate } from '../tax/calendar.ts';
import { TAX_POLICY } from '../tax/policy.ts';
import type { BusinessCalendar } from '../tax/types.ts';
import type { AccountKind, AccountReport, ContributionEntry, WithdrawalExecution, WithdrawalRequest } from './types.ts';

export function validateAccountChoice(kind: AccountKind, currency: 'USD' | 'KRW', symbol?: SymbolCode) {
  if (!['general','isa','pension'].includes(kind)) { throw new Error('지원하지 않는 계좌 유형입니다.'); }
  if (symbol && instrumentFor(symbol).currency !== currency) { throw new Error('계좌 계산의 종목과 통화가 일치하지 않습니다.'); }
  if (kind === 'general') { return; }
  if (!symbol) { throw new Error('절세계좌는 확인된 종목 메타데이터가 필요합니다.'); }
  if (currency !== 'KRW') { throw new Error('ISA·연금저축은 해외 상장 ETF를 직접 매수할 수 없습니다.'); }
  if (kind === 'pension' && (!symbol || instrumentFor(symbol).leverage !== 1)) { throw new Error('연금저축은 확인된 국내 상장 비레버리지 ETF만 지원합니다.'); }
}

export function createContributionLedger(kind: AccountKind, openedAt: string) {
  if (!isDate(openedAt)) { throw new Error('계좌 개설일 오류입니다.'); }
  const entries: ContributionEntry[] = [];
  const openedYear = Number(openedAt.slice(0,4));
  function remaining(date: string) {
    const year = Number(date.slice(0,4));
    if (!isDate(date) || date < openedAt) { throw new Error('납입일은 개설일 이후여야 합니다.'); }
    if (kind === 'general') { return Infinity; }
    const approved = entries.reduce((sum,entry)=>sum+entry.approved,0);
    if (kind === 'isa') { return Math.max(0, Math.min(TAX_POLICY.isaLifetimeLimit, TAX_POLICY.isaAnnualLimit*(year-openedYear+1))-approved); }
    return Math.max(0,TAX_POLICY.pensionAnnualLimit-entries.filter(entry=>Number(entry.date.slice(0,4))===year).reduce((sum,entry)=>sum+entry.approved,0));
  }
  function approve(date: string, requested: number, source: ContributionEntry['source']) {
    if (!Number.isFinite(requested) || requested < 0) { throw new Error('납입 요청액 오류입니다.'); }
    const approved = Math.min(requested,remaining(date));
    entries.push({date,source,requested,approved,blocked:requested-approved});
    return approved;
  }
  return { entries, remaining, approve };
}

interface WithdrawalState {
  value: WithdrawalExecution;
  terminal: boolean;
  history: { date: string; value: WithdrawalExecution }[];
}
interface ReservedPayment { request: WithdrawalState; amount: number; due: string }

export function createAccountController(options: {
  kind: AccountKind; openedAt: string; currency: 'USD' | 'KRW'; symbol?: SymbolCode;
  requests?: WithdrawalRequest[]; calendar?: BusinessCalendar;
}) {
  const {kind,openedAt,currency,symbol,calendar} = options;
  validateAccountChoice(kind,currency,symbol);
  const contributions=createContributionLedger(kind,openedAt);
  const requests=options.requests??[];
  if (!Array.isArray(requests)||requests.length>500) { throw new Error('중간 인출 일정은 최대500건입니다.'); }
  const ids=new Set<string>();
  const states: WithdrawalState[]=[];
  for(const request of requests) {
    if (!request || typeof request.id!=='string'||!request.id||request.id.length>100||ids.has(request.id)||!isDate(request.date)
      ||!Number.isFinite(request.amount)||request.amount<=0||!['USD','KRW'].includes(request.currency)) { throw new Error('중간 인출 일정의 날짜·금액·통화·고유ID를 확인하세요.'); }
    ids.add(request.id);
    const value: WithdrawalExecution={id:request.id,source:'scheduled',requestedDate:request.date,currency:request.currency,requested:request.amount,
      allowed:0,restricted:0,soldQuantity:0,saleAmount:0,grossPaid:0,tax:0,netPaid:0,unpaid:request.amount,pending:false,reason:'처리 대기',payments:[]};
    states.push({value,terminal:false,history:[]});
  }
  states.sort((a,b)=>a.value.requestedDate.localeCompare(b.value.requestedDate)||a.value.id.localeCompare(b.value.id));
  const reservations: ReservedPayment[]=[];
  let principal=0;
  let vrSequence=0;
  const copy=(value:WithdrawalExecution):WithdrawalExecution=>({...value,payments:value.payments.map(payment=>({...payment}))});
  function capture(state:WithdrawalState,date:string) {
    const record={date,value:copy(state.value)};
    if(state.history.at(-1)?.date===date)state.history[state.history.length-1]=record;else state.history.push(record);
  }
  function depositApproval(date:string,requested:number,source:ContributionEntry['source']) {
    const approved=contributions.approve(date,requested,source);principal+=approved;return approved;
  }
  function reservedPrincipal(except?:WithdrawalState) {
    return states.filter(state=>state!==except&&!state.terminal&&state.value.processedDate).reduce((sum,state)=>sum+Math.max(0,state.value.allowed-state.value.grossPaid),0);
  }
  function payment(account:Account,state:WithdrawalState,requested:number,date:string) {
    const gross=withdraw(account,requested);
    const usedPrincipal=Math.min(principal,gross);
    const tax=kind==='pension'?Math.max(0,gross-usedPrincipal)*TAX_POLICY.pensionWithdrawalRate:0;
    principal=Math.max(0,principal-usedPrincipal);
    state.value.grossPaid+=gross;state.value.tax+=tax;state.value.netPaid+=gross-tax;
    state.value.unpaid=Math.max(0,state.value.requested-state.value.grossPaid);
    if(gross>0){state.value.paidDate=date;state.value.payments.push({date,gross,tax,net:gross-tax,principal:usedPrincipal});}
    return {gross,net:gross-tax,tax};
  }
  function releaseNormalSales(account:Account) {
    const reserved=reservations.reduce((sum,item)=>sum+item.amount,0);
    const available=account.lockedCash-reserved;
    if(available< -1e-7*Math.max(1,account.lockedCash))throw new Error('인출 예약 현금이 잠금 현금을 초과했습니다.');
    account.cash+=Math.max(0,available);account.lockedCash=reserved;
  }
  function periodicWithdrawal(account:Account,date:string,requested:number) {
    const allowed=kind==='isa'?Math.min(requested,Math.max(0,principal-reservedPrincipal())):requested;
    const state:WithdrawalState={terminal:true,history:[],value:{id:`vr-${date}-${++vrSequence}`,source:'vr',requestedDate:date,currency,requested,processedDate:date,
      allowed,restricted:requested-allowed,soldQuantity:0,saleAmount:0,grossPaid:0,tax:0,netPaid:0,unpaid:requested,pending:false,
      reason:'VR 정기 인출 · 가용 현금만 지급',payments:[],beforeTotal:undefined,afterTotal:undefined}};
    states.push(state);
    const paid=payment(account,state,Math.min(allowed,account.cash),date);
    capture(state,date);
    return {gross:paid.gross,net:paid.net,tax:paid.tax};
  }
  function process(account:Account,bar:ExecutionBar) {
    const trades:Trade[]=[];let gross=0,net=0,tax=0;
    const touched=new Set<WithdrawalState>();
    const addPayment=(state:WithdrawalState,amount:number)=>{const paid=payment(account,state,amount,bar.date);gross+=paid.gross;net+=paid.net;tax+=paid.tax;touched.add(state);};
    // Resolve earlier settlements first. At the same payment date preserve
    // request date/ID order so pension principal is assigned deterministically.
    reservations.sort((first,second)=>first.due.localeCompare(second.due)
      ||first.request.value.requestedDate.localeCompare(second.request.value.requestedDate)
      ||first.request.value.id.localeCompare(second.request.value.id));
    for(let index=0;index<reservations.length;) {
      const reserved=reservations[index];
      if(reserved.due>bar.date){index++;continue;}
      account.lockedCash-=reserved.amount;account.cash+=reserved.amount;
      addPayment(reserved.request,reserved.amount);reservations.splice(index,1);
    }
    for(const state of states) {
      const value=state.value;
      if(state.terminal||value.source!=='scheduled'||value.requestedDate>bar.date||value.requestedDate<openedAt||value.currency!==currency)continue;
      if(!value.processedDate){
        value.processedDate=bar.date;value.beforeTotal=valueAccount(account,openingPrice(bar)).total;
        value.allowed=kind==='isa'?Math.min(value.requested,Math.max(0,principal-reservedPrincipal(state))):value.requested;
        value.restricted=value.requested-value.allowed;
        value.reason=value.restricted>0?'ISA 납입원금 범위 초과분 제한':'현금 우선 · 시가 관측 후 최소 정수주 시장가 매도를 시가로 근사';
      }
      touched.add(state);
      const reserved=reservations.filter(item=>item.request===state).reduce((sum,item)=>sum+item.amount,0);
      let remaining=Math.max(0,value.allowed-value.grossPaid-reserved);
      if(remaining>0&&account.cash>0){addPayment(state,Math.min(remaining,account.cash));remaining=Math.max(0,value.allowed-value.grossPaid-reserved);}
      if(remaining>0&&account.quantity>0) {
        // Observe the current opening quote before placing the market order,
        // approximating its fill at that quote. Never use today's future close.
        const reference=openingPrice(bar);
        if(Number.isFinite(reference)&&reference>0){
          const desired=Math.ceil(remaining/reference-1e-12);
          const quantity=Math.min(account.quantity,desired);
          const price=openingPrice(bar);
          const sale=sell(account,price,quantity);
          const amount=Math.min(remaining,sale.amount);
          const resolution=settlementDate(bar.date,currency==='USD'?'US':'KR',calendar);
          reservations.push({request:state,amount,due:resolution.date});
          value.soldQuantity+=sale.quantity;value.saleAmount+=sale.amount;
          value.settlementDate=resolution.date;value.settlementExact=(value.settlementExact??true)&&resolution.exact;
          trades.push({date:bar.date,side:'SELL',price,quantity:sale.quantity,amount:sale.amount,realized:sale.realized,
            orderType:isEstimatedClose(bar)?'CLOSE_ESTIMATE':'OPEN',...(isEstimatedClose(bar)?{estimated:true as const}:{}),reason:'중간 인출 재원 마련 · 시가 관측 최소 정수주 매도'});
        }
      }
      const stillReserved=reservations.some(item=>item.request===state);
      const left=Math.max(0,value.allowed-value.grossPaid);
      state.terminal=left<=1e-8||(!stillReserved&&account.quantity===0&&account.cash<=1e-8);
      value.pending=!state.terminal;
      value.afterTotal=valueAccount(account,openingPrice(bar)).total;
      if(state.terminal&&value.unpaid>1e-8&&value.restricted===0)value.reason='보유 자산 부족 · 미지급액 자동 차입/외부 보충 없음';
    }
    for(const state of touched){
      if(state.value.allowed-state.value.grossPaid<=1e-8){state.terminal=true;state.value.pending=false;}
      capture(state,bar.date);
    }
    return {gross,net,tax,trades,forcedSale:trades.length>0};
  }
  function report(end:string):AccountReport {
    const included=contributions.entries.filter(entry=>entry.date<=end).map(entry=>({...entry}));
    const approved=included.reduce((sum,entry)=>sum+entry.approved,0);
    const requested=included.reduce((sum,entry)=>sum+entry.requested,0);
    const withdrawals=states.filter(state=>state.value.source!=='vr'||state.value.requestedDate<=end).map(state=>{
      const historic=state.history.findLast(record=>record.date<=end);
      if(historic)return copy(historic.value);
      const value=copy(state.value);
      const excluded=value.currency!==currency||value.requestedDate<openedAt||value.requestedDate>end;
      return {...value,processedDate:undefined,paidDate:undefined,settlementDate:undefined,settlementExact:undefined,allowed:0,restricted:0,soldQuantity:0,saleAmount:0,
        grossPaid:0,tax:0,netPaid:0,unpaid:value.requested,payments:[],beforeTotal:undefined,afterTotal:undefined,pending:!excluded,excluded,
        reason:excluded?(value.currency!==currency?'선택 종목 통화와 달라 제외':'선택 기간 밖 일정 · 실행 제외'):'요청일 이후 첫 거래일 대기'};
    });
    const annualContributions=[...new Set(included.map(entry=>Number(entry.date.slice(0,4))))].sort((a,b)=>a-b).map(year=>{
      const entries=included.filter(entry=>Number(entry.date.slice(0,4))===year);
      const before=included.filter(entry=>Number(entry.date.slice(0,4))<year).reduce((sum,entry)=>sum+entry.approved,0);
      return {year,available:kind==='general'?0:kind==='isa'?Math.max(0,Math.min(TAX_POLICY.isaLifetimeLimit,TAX_POLICY.isaAnnualLimit*(year-Number(openedAt.slice(0,4))+1))-before):TAX_POLICY.pensionAnnualLimit,
        requested:entries.reduce((sum,entry)=>sum+entry.requested,0),approved:entries.reduce((sum,entry)=>sum+entry.approved,0),blocked:entries.reduce((sum,entry)=>sum+entry.blocked,0),
        cumulativeApproved:before+entries.reduce((sum,entry)=>sum+entry.approved,0)};
    });
    const withdrawnGross=withdrawals.reduce((sum,entry)=>sum+entry.grossPaid,0);
    const withdrawnNet=withdrawals.reduce((sum,entry)=>sum+entry.netPaid,0);
    const withdrawalTax=withdrawals.reduce((sum,entry)=>sum+entry.tax,0);
    const principalUsed=withdrawals.reduce((sum,entry)=>sum+entry.payments.reduce((subtotal,payment)=>subtotal+(payment.principal??0),0),0);
    return {kind,openedAt,currency,policyVersion:TAX_POLICY.version,contributions:included,annualContributions,withdrawals,requested,approved,blocked:requested-approved,
      withdrawnGross,withdrawnNet,withdrawalTax,principalRemaining:Math.max(0,approved-principalUsed),warnings:[
        '중간 인출 요청액은 세전 계좌 차감액입니다. 연금저축은 비공제 납입원금 우선, 초과 운용수익16.5%를 차감한 순수령을 현금흐름에 반영합니다.',
        '별도 중간 인출은 정기 입출금 후 처리하며, 재원 매도일의 전략 주문은 취소합니다. V3 회당 매수금은 유지하고 VR은 실제 인출액만큼 목표V를 낮춥니다.',
        '인출 재원 매도는 해당일 시가를 관측한 후 최소 정수주 시장가 주문을 제출하고 그 시가에 체결된 것으로 근사합니다. 당일 미래 종가로 수량을 결정하지 않으며 추정 구간은 종가 체결 규칙을 따릅니다.',
        ...(withdrawals.some(entry=>entry.settlementExact===false)?['중간 인출 지급일은 현행 T+1(미국)/T+2(국내) 고정·주말 제외 대표일 근사입니다. 현지 공휴일 결제 달력 미확보로 확정 결제일이 아닙니다.']:[]),
      ]};
  }
  return { contributions, depositApproval, periodicWithdrawal, releaseNormalSales, process, report };
}
