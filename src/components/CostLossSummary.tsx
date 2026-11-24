import { useEffect, useState } from 'react';
import type { CostLossPoint } from '../engine/costLoss.ts';

export function CostLossSummary({ point: currentPoint, pending, currency, onInspect }: { point?: CostLossPoint; pending: boolean; currency: string; onInspect: (date: string) => void }) {
  const [settledPoint, setSettledPoint] = useState(currentPoint);
  useEffect(() => { if (!pending) { setSettledPoint(currentPoint); } }, [currentPoint, pending]);
  const point = pending ? settledPoint : currentPoint;
  const money = (value: number) => new Intl.NumberFormat('ko-KR', { style:'currency', currencyDisplay:'narrowSymbol', currency,
    maximumFractionDigits:currency === 'USD' ? 2 : 0 }).format(value);
  const hasLoss = point !== undefined && point.rate < 0;
  return <section className="panel cost-loss-summary" aria-label="평단 대비 최대 평가손실" aria-busy={pending}>
    <div className="cost-loss-heading"><span className="metric-label">{pending ? '재계산 중' : '평단 대비 최대 평가손실'}</span>
      <strong className={hasLoss ? 'negative num' : 'num'} data-testid="max-cost-loss">{point ? `${(point.rate * 100).toFixed(2)}%` : '—'}</strong>
      <small>{point ? hasLoss ? '선택 기간 중 가장 깊었던 보유 원금 손실률' : '선택 기간에 관측된 평가손실 없음' : '보유 이력이 있어야 계산할 수 있습니다.'}</small>
    </div>
    <div className="cost-loss-detail">{hasLoss ? <>
      <p><span>발생일</span><button className="loss-date" disabled={pending} onClick={() => { onInspect(point.date); }}>{point.date} · 계좌 보기</button></p>
      <p><span>해당 시점 평가손실금</span><strong className="negative">{money(point.amount)}</strong></p>
      <p><span>평균 매입가 → 평가가격</span><strong>{money(point.averageCost)} → {money(point.price)}</strong></p>
      <small>{point.quantity.toLocaleString()}주 · {point.estimated ? '추정 종가' : point.basis === 'sell' ? '매도 직전 · 체결가 기준' : '일별 종가 기준'}</small>
    </> : <p className="hint">평균 매입가 100에 평가가격 80이면 −20%입니다. 현금 비중과 고점 대비 MDD에 관계없이 보유 주식의 손실 구간을 확인합니다.</p>}</div>
    <p className="cost-loss-note">계산: (평가가격 − 해당 시점 평단) ÷ 평단. 일별 종가와 실제 매도 체결 직전 보유분을 확인하며, 장중 저가 전체의 손실을 추정하지 않습니다. 손실금은 최대 손실률이 발생한 시점의 금액입니다.</p>
  </section>;
}
