import { useMemo, useState } from 'react';
import type { TaxReport } from '../tax/types.ts';

export function Phase2TaxChart({ curve, onInspect }: { curve: TaxReport['curve']; onInspect?: (date: string) => void }) {
  const [selected, setSelected] = useState<number>();
  const chart = useMemo(() => {
    if (!curve.length) { return undefined; }
    let minimum=Infinity,maximum=-Infinity;
    for (const day of curve) { minimum=Math.min(minimum,day.accountValue); maximum=Math.max(maximum,day.accountValue); }
    const span=maximum-minimum || Math.max(1,maximum*.05);
    const x=(index:number)=>12+index/Math.max(1,curve.length-1)*976;
    const y=(value:number)=>15+(maximum-value)/span*160;
    const path=()=>curve.map((day,index)=>`${index?'L':'M'}${x(index).toFixed(2)},${y(day.accountValue).toFixed(2)}`).join(' ');
    return {account:path(),x};
  },[curve]);
  if (!chart) { return null; }
  const index=Math.max(0,Math.min(curve.length-1,selected ?? curve.length-1));
  const day=curve[index];
  const money=(value:number)=>new Intl.NumberFormat('ko-KR',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(value);
  function inspect(next:number) { const value=Math.max(0,Math.min(curve.length-1,next));setSelected(value);onInspect?.(curve[value].date); }
  return <div className="phase-tax-chart">
    <div className="phase-chart-legend"><span><i className="phase-key-account" />계좌 자산</span><small>원화 기준 · 계산 가능한 날짜</small></div>
    <svg viewBox="0 0 1000 195" preserveAspectRatio="none" role="img" aria-label="계좌 자산 곡선. 방향키로 날짜 조회" tabIndex={0}
      onPointerMove={event=>{const rect=event.currentTarget.getBoundingClientRect();const normalized=(event.clientX-rect.left)/rect.width;inspect(Math.round((normalized*1000-12)/976*(curve.length-1)));}}
      onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();inspect(index+(event.key==='ArrowLeft'?-1:1));}}}>
      <title>계좌 자산의 일별 원화 평가</title>
      {[15,55,95,135,175].map(y=><line key={y} x1="12" x2="988" y1={y} y2={y} stroke="#e8edf5" />)}
      <path d={chart.account} fill="none" stroke="#344cc1" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {selected!==undefined&&<line x1={chart.x(index)} x2={chart.x(index)} y1="10" y2="180" stroke="#7d8eb1" strokeDasharray="4 4" />}
    </svg>
    <div className="phase-chart-dates"><span>{curve[0].date}</span><span>{curve.at(-1)!.date}</span></div>
    <p className="phase-chart-quote"><strong>{day.date}</strong><span>계좌 {money(day.accountValue)}</span></p>
  </div>;
}
