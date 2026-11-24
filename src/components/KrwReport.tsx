import { AssetChart } from './AssetChart.tsx';
import type { KrwResult } from '../engine/fx.ts';
import type { Metric } from '../engine/metrics.ts';
export function KrwReport({ report, loading, error, accountDate, onInspect, onRefresh }: {
  report?: KrwResult;
  loading: boolean;
  error?: string;
  accountDate?: string;
  onInspect: (date: string) => void;
  onRefresh: () => void;
}) {
  const money = (value: number) => new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value);
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  const metric = (value: Metric) => value.available ? percent(value.value) : value.reason;
  const final = report?.days.at(-1);
  const selected = report?.days.find(day => day.date === accountDate) ?? final;
  return <section className="panel krw-report" aria-label="환율 반영 원화 성과"><div className="panel-head"><h2>원화 성과 · 환율 반영</h2><button onClick={onRefresh} disabled={loading}>환율 새로 조회</button></div>
  <div className="chart-meta">USD 전략은 그대로 유지합니다. 관측일 기준 사후 환산이며 당시 실시간 환전가·환전 비용을 재현하지 않습니다.</div>
  {report && error && <div className="empty error" role="alert">{error}</div>}
  {!report || !final ? <div className={`empty${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{loading ? '환율 조회 또는 원화 성과 계산 중…' : error ?? '백테스트 실행 후 원화 결과를 표시합니다.'}</div> : <>
   <div className="metrics krw-metrics">{[
        ['원화 최종 자산', money(final.total), `누적 납입 ${money(final.deposited)}`],
        ['원화 순손익 · 환차 포함', money(final.profit), `실제 인출 ${money(final.withdrawn)}`],
        ['원화 TWR', percent(report.metrics.twr), `납입 대비 ${percent(report.metrics.returnOnContributions)}`],
        ['원화 MDD', percent(report.metrics.mdd), '입출금을 제거한 원화 운용곡선'],
      ].map(([label, value, detail]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>)}</div>
   <div className="performance-details krw-details"><span>원화 XIRR: {metric(report.metrics.xirr)}</span><span>원화 CAGR: {metric(report.metrics.cagr)}</span></div>
   <AssetChart result={report} onInspect={onInspect} accountDate={accountDate}/>
   {selected && <div className="krw-account"><strong>{selected.date} · 원화 계좌 평가</strong><span>주식 {money(selected.stock)} · 현금 {money(selected.cash + selected.lockedCash)} · 총자산 {money(selected.total)}</span><span>USD1 = {money(selected.rate)} · 관측일 {selected.observationDate} · {selected.carriedDays}일 전 관측</span><span>당일 납입 {money(selected.contribution)} · 인출 {money(selected.withdrawal)}</span></div>}
   <details className="data-notes"><summary>환율 출처·관측 시차·계산 기준</summary><p>{report.source} · 조회 {new Date(report.fetchedAt).toLocaleString('ko-KR')} · 버전 {report.fxVersion.slice(0, 12)}</p><ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul><a href="https://www.federalreserve.gov/releases/h10/hist/dat00_ko.htm" target="_blank" rel="noreferrer">연준 H.10 원자료</a></details>
  </>}
 </section>;
}
