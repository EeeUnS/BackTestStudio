import type { AccountKind, AccountReport } from '../accounts/types.ts';
import type { TaxReport, TaxScenario } from '../tax/types.ts';
import type { Metric } from '../engine/metrics.ts';
import { accountNames, scenarioNames } from '../phase2/settings.ts';
import { Phase2TaxChart } from './Phase2TaxChart.tsx';

export interface Phase2ReportProps {
  initiallyOpen: boolean;
  report?: TaxReport;
  accountReport?: AccountReport;
  account?: AccountKind | '';
  enabled: boolean;
  loading: boolean;
  error?: string;
  scenario?: TaxScenario;
  onScenario?: (scenario: TaxScenario) => void;
  onInspect?: (date: string) => void;
}
const won=(value:number|undefined)=>value===undefined?'—':new Intl.NumberFormat('ko-KR',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(value);
const percentage=(metric:Metric|undefined)=>!metric?'—':metric.available?`${(metric.value*100).toFixed(2)}%`:metric.reason;

export function Phase2Report({initiallyOpen,report,accountReport,account:selectedAccount,enabled,loading,error,scenario,onScenario,onInspect}:Phase2ReportProps) {
  const ready=enabled&&!error&&(selectedAccount===undefined||selectedAccount===report?.account)&&(report?.status==='available'||report?.status==='estimated');
  const currentScenario=scenario??report?.scenario??'liquidate';
  const account=selectedAccount===undefined?accountReport?.kind??report?.account:selectedAccount||undefined;
  const title=account?accountNames[account]:'계좌 선택 전';
  const noSettlementNote=account!=='general'?'정산 자료와 결제 가능일을 확인하세요.':currentScenario==='liquidate'?'종료 보유분의 가상 매도와 세금을 별도로 계산했습니다. 원래 전략 원장은 바꾸지 않으며, 결제·납부일은 연도별 원장에서 확인하세요.':'보유 유지 결과입니다. 종료일 주식을 강제 매도하지 않습니다.';
  const reason=!enabled?'매매차익 세금 반영을 켜면 세금·정산 결과를 표시합니다.':error??report?.reason??(loading?'계좌·세금 결과를 계산하고 있습니다…':'백테스트 실행 후 세금·정산 결과를 표시합니다.');
  return <section className="phase2-report" aria-label="계좌·세금 정산 결과" aria-busy={loading}>
    <details className="section-disclosure" open={initiallyOpen}><summary>계좌 · 세금 정산 결과</summary><div className="section-disclosure-body">
    <nav className="phase-section-nav" aria-label="계좌 분석 항목"><a href="#phase2-tax-panel">계좌 · 세금 정산</a><a href="#withdrawals-panel">중간 인출 일정</a><a href="#phase2-withdraw-log">인출 실행 내역</a></nav>
    <div className="phase-warning"><strong>매매차익 과세 반영 · 분배금 과세 미반영 · 현재 규칙 고정 시뮬레이션</strong><span>현재 제도를 과거 전체 기간에 동일 적용하는 제한 모형입니다. 실제 신고서나 모든 세금이 반영된 실수령액이 아닙니다.</span></div>
    <div className="phase-summary">
      <div><span>선택 계좌</span><strong>{title}</strong><small>{accountReport?`${accountReport.openedAt} 신규 개설`:'선택 시작일에 신규 개설'}</small></div>
      <div><span>발생 세금 / 정산 세액</span><strong>{ready?won(report.accrued):'—'}</strong><small>세금용 통화 KRW</small></div>
      <div><span>{account==='general'?'외부 납부 / 미납':'정산 세액 / 수령액'}</span><strong>{ready?account==='general'?`${won(report.paid)} / ${won(report.unpaid)}`:`${won(report.settlement?.tax)} / ${won(report.settlement?.net)}`:'—'}</strong><small>{account==='general'?'전략의 가용 현금과 별도':'정산 원천징수는 수령액에서 차감'}</small></div>
      <div><span>{account==='general'?currentScenario==='liquidate'?'종료 전량 매도 후 세후 금액':'계좌 평가금액':'예상 정산 수령액'}</span><strong>{ready?won(account==='general'&&currentScenario!=='liquidate'?report.accountValueKrw:report.afterTaxValueKrw):'—'}</strong><small>{ready&&report.status==='estimated'?'자료·날짜 가정이 포함된 추정 결과':'계산 불가 항목은 0으로 대체하지 않음'}</small></div>
    </div>
    <div className="phase-results-grid">
      <section className="panel" id="phase2-tax-panel" aria-labelledby="phase2-tax-heading"><div className="panel-head"><div className="panel-title"><h2 id="phase2-tax-heading">계좌 · 세금 정산</h2><span className={`phase-pill ${report?.status==='unavailable'?'phase-pill-unavailable':''}`}>{!enabled?'세금 미적용':loading?'계산 중':report?.status==='available'?'계산 완료':report?.status==='estimated'?'추정 · 가정 포함':'계산 자료 확인'}</span></div><small>세금·정산 금액은 원화</small></div>
        <div className="phase-body">
          {(account==='general'||!account)&&<div className="phase-tabs" role="group" aria-label="일반계좌 종료 시나리오">{(['hold','liquidate'] as const).map(value=><button key={value} type="button" aria-pressed={currentScenario===value} disabled={!onScenario} onClick={()=>{onScenario?.(value);}}>{scenarioNames[value]}</button>)}</div>}
          {!ready?<p className={`phase-empty${error?' phase-inline-error':''}`} role={error||report?.status==='unavailable'?'alert':'status'}>{reason}</p>:<>
            {report.reason&&<p className="phase-note">{report.reason}</p>}
            <div className="phase-tax-cards">{account==='general'?<><div><span>발생 세금</span><strong>{won(report.accrued)}</strong><small>선택 시나리오의 과세 원장 합계</small></div><div><span>외부 납부 누계</span><strong>{won(report.paid)}</strong><small>계좌 자산에서 직접 차감하지 않음</small></div><div><span>미납 / 정산 예정</span><strong>{won(report.unpaid)}</strong><small>지급 예정일은 연도별 원장에서 확인</small></div></>:<><div><span>과세대상 손익</span><strong>{won(report.settlement?.taxable)}</strong><small>비공제 납입 원금과 구분</small></div><div><span>정산 공제 적용</span><strong>{won(report.settlement?.deduction)}</strong><small>계좌 정산 시 적용한 금액</small></div><div><span>정산 세액</span><strong>{won(report.settlement?.tax)}</strong><small>외부 납부가 아닌 수령액 원천징수</small></div></>}</div>
            <dl className="phase-performance"><div><dt>현재 시점 세후 XIRR</dt><dd>{percentage(report.afterTaxXirr)}</dd></div><div><dt>향후 납부·정산 포함 XIRR</dt><dd>{percentage(report.projectedAfterTaxXirr)}</dd></div></dl>
            {report.account==='general'&&<p className="phase-note">계좌 자산 {won(report.accountValueKrw)}{report.afterTaxValueKrw!==undefined?` · 선택 분기 세후 금액 ${won(report.afterTaxValueKrw)}`:''}. 세금용 원가와 전략의 평단은 별개입니다.</p>}
            {report.curve.length>0&&<Phase2TaxChart curve={report.curve} onInspect={onInspect} />}
          </>}
        </div>
        {ready&&<div className="table-scroll"><table className="phase-table"><caption>연도별 매매차익 과세 원장 · 원화</caption><thead><tr><th>귀속연도 / 유형</th><th>실현 이익</th><th>실현 손실</th><th>순손익</th><th>공제 적용</th><th>과세표준</th><th>발생 세금</th><th>납부일 / 납부액</th><th>미납액</th></tr></thead><tbody>
          {report.annual.length?report.annual.map((row,index)=><tr key={`${row.year}-${row.kind}-${index}`}><td>{row.year}{row.estimated?' · 추정':''}<small>{row.kind==='capital-gains'?'해외주식 양도세':row.kind==='withholding'?'국내 ETF 원천징수':'계좌 정산'}</small></td><td>{won(row.profit)}</td><td>{won(row.loss)}</td><td>{won(row.net)}</td><td>{won(row.deduction)}</td><td>{won(row.taxable)}</td><td>{won(row.tax)}</td><td>{row.paymentDate||'—'}<small>{won(row.paid)}</small></td><td>{won(row.unpaid)}</td></tr>):<tr><td colSpan={9}>해당 기간에 계상된 과세 원장이 없습니다.</td></tr>}
        </tbody></table></div>}
        {report&&<details className="phase-policy-details"><summary>정책 · 데이터 근거 · 계산 범위</summary><p>정책 버전 {report.policyVersion} · 원가 {report.costMethod==='fifo'?'선입선출':'이동평균'} · {scenarioNames[report.scenario]}</p><ul>{report.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>{report.sources.length>0&&<ul>{report.sources.map((source,index)=><li key={`${source}-${index}`}><a href={source} target="_blank" rel="noreferrer">공식 근거 {index+1}</a></li>)}</ul>}{report.fxVersion&&<p className="phase-version">환율 버전 {report.fxVersion}</p>}{report.taxBasisVersion&&<p className="phase-version">과표기준가격 버전 {report.taxBasisVersion}</p>}</details>}
      </section>
      <section className="panel phase-settlement" aria-label="종료와 정산 타임라인"><div className="panel-head"><h2>종료 후의 흐름</h2><small>{account==='general'?scenarioNames[currentScenario]:account==='isa'?'정상 해지':account==='pension'?'전액 중도인출':'정산 미계산'}</small></div><div className="phase-body">
        {ready&&report.settlement?<><ol className="phase-timeline"><li><strong>투자 종료</strong><time>{report.settlement.investmentEnd}</time><small>이 날짜 이후 추가 투자·현금 이자는 없습니다.</small></li><li><strong>전량 매도</strong><time>{report.settlement.liquidationDate}</time><small>종료 시나리오의 별도 매도 원장</small></li>{report.settlement.minimumHoldingDate&&<li><strong>의무기간 충족</strong><time>{report.settlement.minimumHoldingDate}</time><small>종료일 이후 무조건 3년을 더 기다리는 방식이 아닙니다.</small></li>}<li><strong>{account==='isa'?'정상 해지·수령':'결제 후 수령'}</strong><time>{report.settlement.settlementDate}</time><small>{report.settlement.waitingDays}일 대기 · {report.settlement.exactDate?'확보한 결제일 기준':'결제 달력의 추정 가정 포함'}</small></li></ol><div className="phase-settlement-values"><p><span>정산 전 금액</span><strong>{won(report.settlement.gross)}</strong></p><p><span>과세표준 / 공제</span><strong>{won(report.settlement.taxable)} / {won(report.settlement.deduction)}</strong></p><p><span>적용 세율</span><strong>{(report.settlement.rate*100).toFixed(1)}%</strong></p><p><span>정산 세액</span><strong>{won(report.settlement.tax)}</strong></p><p><span>최종 수령액</span><strong>{won(report.settlement.net)}</strong></p></div></>:<p className="phase-empty">{ready?noSettlementNote:reason}</p>}
        {accountReport&&<Phase2ContributionSummary report={accountReport} />}
      </div></section>
    </div>
    {ready&&report.events.length>0&&<details className="panel phase-events"><summary>세금 발생 · 납부 · 정산 이벤트 ({report.events.length}건)</summary><div className="table-scroll"><table className="phase-table"><thead><tr><th>날짜</th><th>유형</th><th>금액 · KRW</th><th>귀속연도</th><th>근거</th></tr></thead><tbody>{report.events.map((event,index)=><tr key={`${event.date}-${event.kind}-${index}`}><td><button type="button" onClick={()=>{onInspect?.(event.date);}} disabled={!onInspect || !report.curve.some(day => day.date === event.date)} title={report.curve.some(day => day.date === event.date) ? '해당일 계좌 조회' : '투자 기간 밖 또는 거래일 외 이벤트'}>{event.date}</button>{event.estimated&&<small>추정 날짜·자료 포함</small>}</td><td>{event.kind==='payment'?'외부 납부':event.kind==='withholding'?'원천징수':event.kind==='settlement'?'계좌 정산':'세금 발생'}</td><td>{won(event.amount)}</td><td>{event.year}</td><td>{event.reason}</td></tr>)}</tbody></table></div></details>}
    </div></details>
  </section>;
}

export function Phase2ContributionSummary({report}:{report:AccountReport}) {
  const money=(value:number)=>new Intl.NumberFormat('ko-KR',{style:'currency',currency:report.currency,currencyDisplay:'narrowSymbol',maximumFractionDigits:report.currency==='KRW'?0:2}).format(value);
  return <div className="phase-contribution-summary"><h3>납입한도 · 승인 원장</h3><div className="phase-limit-row"><span>요청 납입액</span><strong>{money(report.requested)}</strong></div><div className="phase-limit-row"><span>승인 납입액</span><strong>{money(report.approved)}</strong></div><div className="phase-limit-row"><span>납입 불가 금액</span><strong>{money(report.blocked)}</strong></div><p className="phase-note">차단액은 계좌 현금·투자 원금·XIRR 지출에 포함하지 않습니다. 매도·중간 인출로 납입한도를 복원하지 않습니다.</p><details className="phase-policy-details"><summary>연도별 납입 원장</summary><div className="table-scroll"><table className="phase-table"><thead><tr><th>연도</th><th>당해·이월 가능액</th><th>요청액</th><th>승인 / 차단</th><th>누적 승인</th></tr></thead><tbody>{report.annualContributions.map(row=><tr key={row.year}><td>{row.year}</td><td>{report.kind==='general'||!Number.isFinite(row.available)?'제한 없음':money(row.available)}</td><td>{money(row.requested)}</td><td>{money(row.approved)} / {money(row.blocked)}</td><td>{money(row.cumulativeApproved)}</td></tr>)}</tbody></table></div></details>{report.warnings.length>0&&<ul className="phase-account-warnings">{report.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}</div>;
}
