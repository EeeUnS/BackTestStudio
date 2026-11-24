import { useMemo, useState } from 'react';

export interface HoldingPoint { date: string; close: number }
export interface HoldingWindow { start: string; end: string; total: number; annual: number }

export function anniversary(date: string, years: number) {
  const result = new Date(`${date}T00:00:00Z`);
  const month = result.getUTCMonth();
  result.setUTCFullYear(result.getUTCFullYear() + years);
  if (result.getUTCMonth() !== month) { result.setUTCDate(0); }
  return result.toISOString().slice(0, 10);
}

export function holdingWindow(points: HoldingPoint[], start: string, years: number): HoldingWindow | undefined {
  const first = points.find(point => point.date >= start);
  if (!first) { return; }
  const last = points.find(point => point.date >= anniversary(first.date, years));
  if (!last || first.close <= 0 || last.close <= 0) { return; }
  const total = last.close / first.close - 1;
  const elapsedYears = (Date.parse(last.date) - Date.parse(first.date)) / (365.2425 * 86400000);
  return { start: first.date, end: last.date, total, annual: (1 + total) ** (1 / elapsedYears) - 1 };
}

function monthlyWindows(points: HoldingPoint[], years: number, latestStart?: string) {
  let month = '';
  const windows: HoldingWindow[] = [];
  for (const point of points) {
    if (latestStart && point.date > latestStart) { break; }
    if (point.date.slice(0, 7) === month) { continue; }
    month = point.date.slice(0, 7);
    const window = holdingWindow(points, point.date, years);
    if (window) { windows.push(window); }
  }
  return windows;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const middle = Math.floor(sorted.length / 2);
  return {
    mean,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1)!,
    deviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
    loss: values.filter(value => value < 0).length / values.length,
  };
}
const percent = (value: number) => `${(value * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`;

export function HoldingPeriodControls({ fixed, years, onMode, onYears, message }: {
  fixed: boolean; years: number; onMode: (fixed: boolean) => void;
  onYears: (years: number) => void; message: string;
}) {
  const [custom, setCustom] = useState('20');
  return <div className="holding-controls">
    <div className="holding-control-row">
      <div className="holding-mode" role="group" aria-label="기간 선택 방식">
        <button aria-pressed={!fixed} onClick={() => onMode(false)}>자유 기간</button>
        <button aria-pressed={fixed} onClick={() => onMode(true)}>고정 보유 기간</button>
      </div>
      <span className="holding-control-label">보유 기간</span>
      <div className="holding-years" role="group" aria-label="고정 보유 연수">
        {[10, 20, 30].map(value => <button key={value} aria-pressed={years === value} onClick={() => onYears(value)}>{value}년</button>)}
      </div>
      <label className="holding-custom">직접 입력 <input aria-label="고정 보유 연수 직접 입력" type="number" min="1" max="50" step="1" value={custom} onChange={event => setCustom(event.target.value)} />년</label>
      <button onClick={() => { const value = Number(custom); if (Number.isInteger(value) && value >= 1 && value <= 50) { onYears(value); } }}>적용</button>
    </div>
    <p className="hint" role="status">{message || (fixed ? `${years}년을 유지하며 매수 시점을 이동합니다. 종료일은 자동으로 결정됩니다.` : '시작일·종료일을 각각 조절합니다. 아래 전체 구간 분석의 보유 연수는 별도로 유지됩니다.')}</p>
  </div>;
}

export function HoldingPeriodDesign({ points, years, selectedStart, selectedEnd, estimated, onSelect }: {
  points: HoldingPoint[]; years: number; selectedStart: string; selectedEnd: string;
  estimated: boolean; onSelect: (window: HoldingWindow) => void;
}) {
  const [mode, setMode] = useState<'total' | 'annual'>('total');
  const [target, setTarget] = useState('30');
  const [spread, setSpread] = useState(3);
  const windows = useMemo(() => monthlyWindows(points, years), [points, years]);
  const value = (window: HoldingWindow) => window[mode];
  const comparison = useMemo(() => {
    const longest = monthlyWindows(points, years + spread);
    const lastStart = longest.at(-1)?.start;
    if (!lastStart) { return []; }
    return Array.from({ length: years + spread - Math.max(1, years - spread) + 1 }, (_, index) => {
      const period = Math.max(1, years - spread) + index;
      const samples = monthlyWindows(points, period, lastStart);
      return { years: period, count: samples.length, ...summarize(samples.map(window => window[mode])) };
    });
  }, [points, years, spread, mode]);
  if (!points.length) { return <section className="panel"><div className="panel-head"><h2>고정 기간 전체 구간 분석</h2></div><div className="empty">시세를 불러오면 보유 기간 분석을 시작합니다.</div></section>; }
  if (!windows.length) {
    return <section className="panel holding-analysis"><div className="panel-head"><h2>{years}년 보유 · 전체 구간 분석</h2></div><div className="holding-empty"><strong>{years}년을 완주한 구간이 없습니다.</strong><p>{points[0].date} ~ {points.at(-1)!.date}의 이력을 사용 중입니다. 보유 연수를 줄이거나 왼쪽에서 추정 데이터 포함을 선택하세요.</p></div></section>;
  }
  const summary = summarize(windows.map(value));
  const lowest = windows.reduce((a, b) => value(a) < value(b) ? a : b);
  const highest = windows.reduce((a, b) => value(a) > value(b) ? a : b);
  const threshold = Number(target) / 100;
  const validTarget = target !== '' && Number.isFinite(threshold);
  const hits = windows.filter(window => value(window) >= threshold).length;
  const rank = windows.filter(window => value(window) <= threshold).length;
  const bins = Array<number>(12).fill(0);
  const span = summary.max - summary.min || 1;
  windows.forEach(window => { bins[Math.min(11, Math.floor((value(window) - summary.min) / span * 12))]++; });
  const selected = windows.find(window => window.start === selectedStart && window.end === selectedEnd);
  const chartMin = Math.min(0, summary.min), chartMax = Math.max(0, summary.max);
  const chartSpan = chartMax - chartMin || 1;
  const x = (index: number) => 55 + index / Math.max(1, windows.length - 1) * 590;
  const y = (result: number) => 170 - (result - chartMin) / chartSpan * 145;
  return <section className="panel holding-analysis" aria-label="고정 기간 전체 구간 분석">
    <div className="panel-head"><div><h2>{years}년 보유 · 전체 구간 분석</h2><small>매월 첫 관측일에 매수한 {windows.length}개 구간 · {points[0].date} ~ {points.at(-1)!.date}</small></div>
      <label className="holding-display">표시 <select aria-label="집계 수익률 표시" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="total">누적 수익률</option><option value="annual">연환산 수익률</option></select></label></div>
    <p className="holding-basis">가격 기준 단순 보유 · {estimated ? '실제·추정 이력 포함' : '실제 이력'} · 분배금·환율·세금·정수주 잔액 미반영. 위쪽 선택 구간 성과는 기존 전략·계좌 설정으로 계산합니다.</p>
    <div className="holding-summary">{[
      ['평균', percent(summary.mean)], ['중앙값', percent(summary.median)],
      ['최저', percent(summary.min)], ['최고', percent(summary.max)],
      ['표준편차', `${(summary.deviation * 100).toFixed(1)}%p`], ['손실 구간', percent(summary.loss)],
    ].map(([label, result]) => <div key={label}><span>{label}</span><strong>{result}</strong></div>)}</div>
    <div className="holding-chart-grid"><div className="holding-chart-cell"><h3>매수 시점별 수익률</h3>
      <svg viewBox="0 0 670 205" role="img" aria-label="매수 시점별 고정 기간 수익률">
        {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1="55" x2="645" y1={170 - fraction * 145} y2={170 - fraction * 145} stroke="#e3eaf3" /><text x="48" y={174 - fraction * 145} textAnchor="end">{percent(chartMin + chartSpan * fraction)}</text></g>)}
        <polyline points={windows.map((window, index) => `${x(index)},${y(value(window))}`).join(' ')} fill="none" stroke="#344cc1" strokeWidth="2.5" />
        {[0, 0.5, 1].map(fraction => { const index = Math.round((windows.length - 1) * fraction); return <text key={fraction} x={x(index)} y="197" textAnchor="middle">{windows[index].start}</text>; })}
        {windows.map((window, index) => <circle key={window.start} cx={x(index)} cy={y(value(window))} r={selected === window ? 5 : 6} fill={selected === window ? '#344cc1' : 'transparent'} onClick={() => onSelect(window)} style={{ cursor: 'pointer' }}><title>{window.start} → {window.end} · {percent(value(window))}</title></circle>)}
      </svg>
      <div className="holding-extremes">{[['최저 구간', lowest], ['최고 구간', highest]].map(([label, item]) => {
        const window = item as HoldingWindow;
        return <button key={String(label)} onClick={() => onSelect(window)}><span>{String(label)} <strong>{percent(value(window))}</strong></span><small>{window.start} → {window.end}</small><span className="holding-action">이 구간 상세 보기 ↑</span></button>;
      })}</div>
      <label className="holding-window-picker">매수 시점 선택<select aria-label="분포에서 매수 구간 선택" value={selected?.start ?? ''} onChange={event => { const window = windows.find(item => item.start === event.target.value); if (window) { onSelect(window); } }}><option value="">구간을 고르면 위 차트·MDD·계좌에 반영됩니다</option>{windows.map(window => <option key={window.start} value={window.start}>{window.start} → {window.end} · {percent(value(window))}</option>)}</select></label>
    </div><div className="holding-chart-cell"><h3>수익률 분포</h3><div className="holding-histogram">{bins.map((count, index) => <div key={index} style={{ height: `${count / Math.max(...bins) * 100}%` }} title={`${percent(summary.min + index / 12 * span)} ~ ${percent(summary.min + (index + 1) / 12 * span)} · ${count}개`} />)}</div><div className="holding-axis"><span>{percent(summary.min)}</span><span>{percent(summary.max)}</span></div>
      <label className="holding-target">목표 {mode === 'annual' ? '연환산' : '누적'} 수익률 <input aria-label="목표 수익률" type="number" step="any" value={target} onChange={event => setTarget(event.target.value)} />% 이상</label>
      <div className="holding-target-result" aria-live="polite">{validTarget ? <><strong>{percent(hits / windows.length)}</strong><span>{windows.length}개 중 {hits}개가 목표 이상</span><small>목표 수익률은 하위 {percent(rank / windows.length)} 위치</small></> : '목표 수익률을 입력하세요.'}</div>
    </div></div>
    <div className="holding-comparison-head"><h3>보유 기간을 바꾸면</h3><label>비교 범위 <select aria-label="보유 기간 비교 범위" value={spread} onChange={event => setSpread(Number(event.target.value))}><option value="2">±2년</option><option value="3">±3년</option></select></label></div>
    {comparison.length ? <div className="table-scroll"><table className="trades"><thead><tr><th>보유 기간</th><th>평균</th><th>최저</th><th>최고</th><th>손실 구간</th><th>공통 매수 시점</th></tr></thead><tbody>{comparison.map(row => <tr key={row.years} className={row.years === years ? 'holding-selected-row' : ''}><td>{row.years}년 {row.years === years && '· 선택'}</td><td>{percent(row.mean)}</td><td>{percent(row.min)}</td><td>{percent(row.max)}</td><td>{percent(row.loss)}</td><td>{row.count}개</td></tr>)}</tbody></table></div> : <p className="holding-basis">{years + spread}년을 완주할 수 있는 데이터가 없어 주변 기간을 비교할 수 없습니다.</p>}
    <p className="holding-basis">기간 비교는 가장 긴 보유 기간까지 완주하는 동일 매수 시점만 사용합니다. 겹치는 과거 구간의 관측 비율이며, 미래 확률이나 예상 최대 수익률을 뜻하지 않습니다.</p>
  </section>;
}
