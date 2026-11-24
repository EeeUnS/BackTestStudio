import { useEffect, useMemo, useState } from 'react';
import type { AccountReport } from '../accounts/types.ts';

export function Phase2WithdrawalLog({ report, onInspect, start, end }: {
  report?: AccountReport;
  onInspect?: (date: string) => void;
  start?: string;
  end?: string;
}) {
  const [source,setSource]=useState('all');
  const [page,setPage]=useState(0);
  useEffect(()=>{setPage(0);},[report,source]);
  const rows=useMemo(()=>report?.withdrawals.filter(row=>source==='all'||row.source===source)??[],[report,source]);
  const money=(value:number|undefined)=>value===undefined?'—':new Intl.NumberFormat('ko-KR',{style:'currency',currency:report?.currency??'KRW',currencyDisplay:'narrowSymbol',maximumFractionDigits:report?.currency==='USD'?2:0}).format(value);
  const maximum=Math.max(0,Math.ceil(rows.length/50)-1);
  const current=Math.min(page,maximum);
  const canInspect=(date:string|undefined)=>Boolean(onInspect&&date&&(!start||date>=start)&&(!end||date<=end));
  return <section className="panel phase2-withdraw-log" id="phase2-withdraw-log" aria-labelledby="withdraw-log-heading">
    <div className="panel-head"><div className="panel-title"><h2 id="withdraw-log-heading">인출 실행과 전후 상태</h2><small>금액 통화 {report?.currency??'—'}</small></div><select aria-label="인출 유형 필터" value={source} onChange={event=>{setSource(event.target.value);}}><option value="all">모든 인출</option><option value="scheduled">별도 일정</option><option value="vr">VR 정기 인출</option></select></div>
    {report?<><div className="phase-body phase-withdraw-totals"><span>계좌 차감 <strong>{money(report.withdrawnGross)}</strong></span><span>인출세액 <strong>{money(report.withdrawalTax)}</strong></span><span>실제 순수령 <strong>{money(report.withdrawnNet)}</strong></span><span>{report.kind==='pension'?'남은 과세제외 원금':report.kind==='isa'?'남은 중간 인출 가능 원금':'남은 납입원금'} <strong>{money(report.principalRemaining)}</strong></span></div>
      {rows.length?<><div className="table-scroll"><table className="phase-table"><thead><tr><th>요청 / 처리 / 지급</th><th>유형</th><th>요청 / 허용</th><th>재원 매도</th><th>계좌 차감</th><th>인출세액 / 순수령</th><th>미충족 / 대기</th><th>인출 전후 총자산</th><th>처리 근거</th></tr></thead><tbody>
        {rows.slice(current*50,(current+1)*50).map(row=><tr key={`${row.source}-${row.id}`}>
          <td>{canInspect(row.processedDate)?<button type="button" onClick={()=>{onInspect?.(row.processedDate!);}}>{row.requestedDate}</button>:row.requestedDate}<small>처리 {row.processedDate??'—'}<br />지급 {row.paidDate??'미지급'}{row.settlementDate&&<><br />결제 {row.settlementDate}{row.settlementExact===false?' · 추정':''}</>}</small>
            {row.payments.length>1&&<details><summary>실제 지급 {row.payments.length}회</summary><ul>{row.payments.map((payment,index)=><li key={`${payment.date}-${index}`}>{payment.date} · 계좌 차감 {money(payment.gross)} / 세금 {money(payment.tax)} / 수령 {money(payment.net)}</li>)}</ul></details>}
          </td><td>{row.source==='vr'?'VR 정기':'별도 일정'}{row.excluded&&<small>기간·통화 제외</small>}</td><td>{money(row.requested)}<small>허용 {money(row.allowed)}{row.restricted>0&&<><br />제한 {money(row.restricted)}</>}</small></td><td>{row.soldQuantity.toLocaleString()}주<small>{money(row.saleAmount)}</small></td><td>{money(row.grossPaid)}</td><td>{money(row.tax)}<small>순수령 {money(row.netPaid)}</small></td><td>{money(row.unpaid)}<small>{row.excluded?'실행 제외':row.pending?'결제·현금 지급 대기':row.unpaid>0?'미충족 금액 있음':'지급 완료'}</small></td><td>{money(row.beforeTotal)}<small>→ {money(row.afterTotal)}</small></td><td>{row.reason}</td>
        </tr>)}
      </tbody></table></div><div className="table-bottom"><span>{rows.length.toLocaleString()}건 · {current+1}/{maximum+1}페이지</span><button type="button" disabled={current===0} onClick={()=>{setPage(value=>value-1);}}>이전</button><button type="button" disabled={current>=maximum} onClick={()=>{setPage(value=>value+1);}}>다음</button></div></>:<p className="empty">선택한 유형의 인출 실행 내역이 없습니다.</p>}
      <p className="phase-note phase-log-note">인출은 투자 손실이 아닙니다. 세전 계좌 차감과 실제 순수령을 구분하며, 미지급액·결제 대기액은 수령 현금흐름에 넣지 않습니다. VR 정기 인출과 별도 일정을 각각 기록합니다.</p>
    </>:<p className="empty">백테스트 실행 후 인출 처리 내역을 표시합니다.</p>}
  </section>;
}
