import { fetchAppData } from './data/fetchAppData.ts';
import { useEstimate } from './hooks/useEstimate.ts';
import { validateFx } from './data/fx.ts';
import type { FxData } from './data/fx.ts';
import { KrwReport } from './components/KrwReport.tsx';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { instruments, validateMarket } from './data/market.ts';
import type { MarketResponse, SymbolCode } from './data/market.ts';
import { validateReference } from './data/reference.ts';
import type { ReferenceData } from './data/reference.ts';
import type { BacktestRequest } from './engine/simpleBacktest.ts';
import { HistoryNavigator } from './components/HistoryNavigator.tsx';
import { PriceChart } from './components/PriceChart.tsx';
import { AssetChart } from './components/AssetChart.tsx';
import { TradeHistory } from './components/TradeHistory.tsx';
import { CostLossSummary } from './components/CostLossSummary.tsx';
import { useBacktest } from './hooks/useBacktest.ts';
import type { Metric } from './engine/metrics.ts';
import { Phase2Settings } from './components/Phase2Settings.tsx';
import { Phase2Withdrawals } from './components/Phase2Withdrawals.tsx';
const Phase2Report = lazy(() => import('./components/Phase2Report.tsx').then(module => ({ default: module.Phase2Report })));
import { Phase2WithdrawalLog } from './components/Phase2WithdrawalLog.tsx';
import { accountEligibility } from './phase2/settings.ts';
import type { Phase2SettingsValue } from './phase2/settings.ts';
import type { WithdrawalRequest } from './accounts/types.ts';
import type { CalculationRequest } from './worker/protocol.ts';
import { useTaxBasis } from './hooks/useTaxBasis.ts';
import type { TimelineEvent } from './chart/events.ts';
import { anniversary, holdingWindow, HoldingPeriodControls, HoldingPeriodDesign } from './components/HoldingPeriodDesign.tsx';
import type { HoldingWindow } from './components/HoldingPeriodDesign.tsx';

export function App({ holdingPreview = false }: { holdingPreview?: boolean }) {
  const [symbol, setSymbol] = useState<SymbolCode>('TQQQ');
  const [response, setResponse] = useState<MarketResponse>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [phaseSettings,setPhaseSettings]=useState<Phase2SettingsValue>({account:'general',taxEnabled:true,costMethod:'fifo',scenario:'liquidate'});
  const [withdrawals,setWithdrawals]=useState<WithdrawalRequest[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(''); setResponse(undefined);
    async function load() {
      try {
        const result = await fetchAppData('market', symbol, revision > 0, abort.signal);
        const body = await result.json();
        if (!result.ok) { throw new Error(body.error ?? `HTTP ${result.status}`); }
        const data = validateMarket(body.data);
        if (data.symbol !== symbol) { throw new Error('조회한 시세의 종목이 선택 종목과 다릅니다.'); }
        if (!abort.signal.aborted) { setResponse({ data, cache: body.cache, stale: import.meta.env.MODE === 'pages' ? Date.now() - Date.parse(data.fetchedAt) > 86400000 : body.stale }); }
      } catch (cause) {
        if (!abort.signal.aborted) { setError(cause instanceof Error ? cause.message : '시세 조회 실패'); }
      } finally { if (!abort.signal.aborted) { setLoading(false); } }
    }
    void load();
    return () => { abort.abort(); };
  }, [symbol, revision]);
  return <Workspace key={symbol} holdingPreview={holdingPreview} symbol={symbol} response={response} loading={loading} error={error} phaseSettings={phaseSettings} onPhaseSettings={patch=>setPhaseSettings(value=>({...value,...patch}))} withdrawals={withdrawals} onWithdrawals={setWithdrawals}
    onSymbol={value => { setSymbol(value); setRevision(0); }} onRefresh={() => { setRevision(value => value + 1); }} />;
}
function Workspace({ symbol, response, loading, error, onSymbol, onRefresh, phaseSettings,onPhaseSettings,withdrawals,onWithdrawals, holdingPreview }: {
  holdingPreview: boolean;
  symbol: SymbolCode; response?: MarketResponse; loading: boolean; error: string;
  onSymbol: (value: SymbolCode) => void; onRefresh: () => void;
  phaseSettings:Phase2SettingsValue;onPhaseSettings:(patch:Partial<Phase2SettingsValue>)=>void;
  withdrawals:WithdrawalRequest[];onWithdrawals:(items:WithdrawalRequest[])=>void;
}) {
  const instrument = instruments.find(item => item.symbol === symbol)!;
  const data = response?.data;
  const isQqq5 = symbol === 'QQQ5.L';
  const accountValid=isQqq5 || phaseSettings.account!==''&&accountEligibility(symbol,phaseSettings.account).allowed;
  const taxBasis=useTaxBasis(data,phaseSettings.taxEnabled&&instrument.currency==='KRW');
  const [estimatedEnabled, setEstimatedEnabled] = useState(false);
  const estimated = useEstimate(data, estimatedEnabled);
  const estimate = estimated.model;
  const timeline = useMemo(() => [...(estimate?.points ?? []), ...(data?.bars ?? [])], [data, estimate]);
  const timelineData = useMemo(() => ({ bars: timeline }), [timeline]);
  const [kind, setKind] = useState('hold');
  const [nasdaq, setNasdaq] = useState<{ data: ReferenceData; stale: boolean }>();
  const [nasdaqError, setNasdaqError] = useState('');
  const [nasdaqRevision, setNasdaqRevision] = useState(0);
  const usesNasdaq = kind === 'nasdaq-sma200';
  useEffect(() => {
    if (!usesNasdaq) { return; }
    const abort = new AbortController();
    setNasdaq(undefined);
    setNasdaqError('');
    async function loadNasdaq() {
      try {
        const response = await fetchAppData('reference', 'NDX', nasdaqRevision > 0, abort.signal);
        const body = await response.json();
        if (!response.ok) { throw new Error(body.error ?? `HTTP ${response.status}`); }
        const data = validateReference(body.data);
        if (data.id !== 'NDX') { throw new Error('나스닥100 지수 시세가 필요합니다.'); }
        if (!abort.signal.aborted) { setNasdaq({ data, stale: import.meta.env.MODE === 'pages' ? Date.now() - Date.parse(data.fetchedAt) > 86400000 : body.stale === true }); }
      } catch (error) {
        if (!abort.signal.aborted) { setNasdaqError(error instanceof Error ? error.message : '나스닥100 지수 조회 실패'); }
      }
    }
    void loadNasdaq();
    return () => { abort.abort(); };
  }, [usesNasdaq, nasdaqRevision]);
  const [fxEnabled, setFxEnabled] = useState(false);
  const [fxData, setFxData] = useState<FxData>();
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState('');
  const [fxRevision, setFxRevision] = useState(0);
  const loadedFxRevision = useRef(-1);
  const needsFx=fxEnabled||(!isQqq5&&phaseSettings.taxEnabled);
  useEffect(() => {
    if (!needsFx || instrument.currency !== 'USD') { setFxLoading(false); return; }
    if(fxData && loadedFxRevision.current === fxRevision) { return; }
    const abort = new AbortController();
    setFxLoading(true); setFxError(''); setFxData(undefined);
    async function loadFx() {
      try {
        const response = await fetchAppData('fx', undefined, fxRevision > 0, abort.signal);
        const body = await response.json();
        if (!response.ok) { throw new Error(body.error ?? `HTTP ${response.status}`); }
        const data = validateFx(body.data);
        if (!abort.signal.aborted) { setFxData({ ...data, warnings: [...data.warnings, ...((import.meta.env.MODE === 'pages' ? Date.now() - Date.parse(data.fetchedAt) > 86400000 : body.stale) ? ['24시간 이상 지난 파일 캐시입니다. 필요하면 환율을 새로 조회하세요.'] : [])] }); loadedFxRevision.current = fxRevision; }
      } catch (error) {
        if (!abort.signal.aborted) { setFxError(error instanceof Error ? error.message : '환율 조회 실패'); }
      } finally { if (!abort.signal.aborted) { setFxLoading(false); } }
    }
    void loadFx();
    return () => { abort.abort(); };
  }, [needsFx, fxRevision, instrument.currency]);
  const [splits, setSplits] = useState('20');
  const [target, setTarget] = useState(symbol === 'SOXL' ? '20' : '15');
  const [reinvestment, setReinvestment] = useState('50');
  const [tick, setTick] = useState(instrument.currency === 'USD' ? '0.01' : '5');
  const [vrMode, setVrMode] = useState<'hold' | 'accumulate' | 'withdraw'>('hold');
  const [vrAdvanced, setVrAdvanced] = useState(false);
  const [vrStock, setVrStock] = useState('90');
  const [vrValue, setVrValue] = useState('0');
  const [vrGradient, setVrGradient] = useState('10');
  const [vrAnnual, setVrAnnual] = useState('1');
  const [vrBand, setVrBand] = useState('15');
  const [vrCycle, setVrCycle] = useState('14');
  const [vrPool, setVrPool] = useState('50');
  const [vrFlow, setVrFlow] = useState(instrument.currency === 'USD' ? '250' : '250000');
  const [vrFlowDays, setVrFlowDays] = useState('14');
  const [vrWithdrawalStart, setVrWithdrawalStart] = useState('');
  const [vrTick, setVrTick] = useState(instrument.currency === 'USD' ? '0.01' : '5');
  const [capital, setCapital] = useState(instrument.currency === 'USD' ? '10000' : '10000000');
  const [contribution, setContribution] = useState(instrument.currency === 'USD' ? '250' : '250000');
  const [interval, setInterval] = useState<'weekly' | 'biweekly' | 'monthly'>('monthly');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [holdingYears, setHoldingYears] = useState(20);
  const [fixedHolding, setFixedHolding] = useState(false);
  const [holdingMessage, setHoldingMessage] = useState('');
  const [quickYears, setQuickYears] = useState(0);
  const [active, setActive] = useState(false);
  const [run, setRun] = useState(0);
  const [markers, setMarkers] = useState(true);
  const [inspected, setInspected] = useState('');
  const [pinned, setPinned] = useState(false);
  const firstDate = timeline[0]?.date ?? '';
  const lastDate = data?.bars.at(-1)?.date ?? '';
  const marketToday = new Intl.DateTimeFormat('en-CA', { timeZone: instrument.zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  useEffect(() => {
    setActive(false);
    if (!data) { return; }
    const latest = data.bars.at(-1)!.date;
    const date = new Date(marketToday);
    date.setUTCFullYear(date.getUTCFullYear() - 5);
    setStart([data.bars[0].date, date.toISOString().slice(0, 10), latest].sort()[1]);
    setEnd(latest);
  }, [data]);
  useEffect(() => { if (firstDate) { setStart(value => value && value < firstDate ? firstDate : value); } }, [firstDate]);
  const request = useMemo<CalculationRequest | undefined>(() => {
    if (!active || !data || !start || !end || !accountValid || (!isQqq5 && !phaseSettings.account) || (usesNasdaq && !nasdaq) || !['hold', 'dca', 'sma200', 'nasdaq-sma200', 'infinite', 'vr'].includes(kind)) { return undefined; }
    const account = phaseSettings.account || 'general';
    return { start, end, ...(isQqq5 ? {} : { account, withdrawals,
      tax:{enabled:phaseSettings.taxEnabled,account,costMethod:phaseSettings.costMethod,scenario:phaseSettings.scenario} }),
      reportInKrw: fxEnabled && Boolean(fxData) && instrument.currency === 'USD', strategy: kind === 'hold' || kind === 'sma200' || kind === 'nasdaq-sma200' ? { kind, capital: Number(capital) }
      : kind === 'dca' ? { kind: 'dca', contribution: Number(contribution), interval }
      : kind === 'infinite' ? { kind: 'infinite', capital: Number(capital), splits: Number(splits), target: Number(target) / 100,
                reinvestment: Number(reinvestment) / 100, tick: Number(tick) }
      : { kind: 'vr', capital: Number(capital), mode: vrMode, advanced: vrAdvanced, initialStockFraction: Number(vrStock) / 100,
        initialValue: Number(vrValue), gradient: Number(vrGradient), annualGradientIncrease: Number(vrAnnual), band: Number(vrBand) / 100,
        cycleDays: Number(vrCycle), poolUse: Number(vrPool) / 100, flowAmount: Number(vrFlow), flowDays: Number(vrFlowDays),
        ...(vrWithdrawalStart ? { withdrawalStart: vrWithdrawalStart } : {}), tick: Number(vrTick) } };
  }, [active, data, start, end, kind, capital, contribution, interval, run, splits, target, reinvestment, tick, vrMode, vrAdvanced, vrStock, vrValue, vrGradient, vrAnnual, vrBand, vrCycle, vrPool, vrFlow, vrFlowDays, vrWithdrawalStart, vrTick, fxEnabled, fxData, instrument.currency,phaseSettings,withdrawals,accountValid,usesNasdaq,nasdaq,isQqq5]);
  const calculation = useBacktest(data, request, fxData, estimate,taxBasis.data, usesNasdaq ? nasdaq?.data : undefined);
  const result = calculation.result;
  const timelineEvents=useMemo<TimelineEvent[]>(()=>[
    ...(result?.accountReport?.withdrawals.flatMap(request=>request.payments.filter(payment=>payment.gross>0).map(payment=>({date:payment.date,label:'인출 지급',color:'#7456b2'})))??[]),
    ...(phaseSettings.taxEnabled?result?.tax?.events.filter(event=>event.amount!==0&&event.date<=result.end).map(event=>({date:event.date,label:event.kind==='accrual'?'세금 발생':event.kind==='settlement'?'계좌 정산':'세금 납부',color:'#b47a26'}))??[]:[]),
  ],[result,phaseSettings.taxEnabled]);
  const final = result?.days.at(-1);
  const coverage = useMemo(() => {
    if (!result) { return []; }
    return [true, false].flatMap(estimated => {
      const days = result.days.filter(day => Boolean(day.estimated) === estimated);
      return days.length ? [{ estimated, start: days[0].date, end: days.at(-1)!.date, count: days.length,
        fraction: days.length / result.days.length }] : [];
    });
  }, [result]);
  const account = result?.days.find(day => day.date === inspected) ?? final;
  const pinnedRef = useRef(pinned);
  useEffect(() => { pinnedRef.current = pinned; }, [pinned]);
  const inspect = useCallback((date: string) => { if (!pinnedRef.current) { setInspected(date); } }, []);
  const money = (value: number | undefined) => value === undefined ? '—' : new Intl.NumberFormat('ko-KR', { style: 'currency', currencyDisplay:'narrowSymbol', currency: instrument.currency, maximumFractionDigits: instrument.currency === 'USD' ? 2 : 0 }).format(value);
  const percent = (value: number | undefined) => value === undefined ? '—' : `${(value * 100).toFixed(2)}%`;
  const metric = (value: Metric | undefined) => !value ? '—' : value.available ? percent(value.value) : value.reason;
  const startIndex = data ? Math.max(0, timeline.findIndex(bar => bar.date >= start)) : 0;
  const endIndex = data ? Math.max(0, timeline.findLastIndex(bar => bar.date <= end)) : 0;
  const requestedQuickStart = useMemo(() => {
    if (!lastDate || !quickYears) { return ''; }
    const date = new Date(lastDate);
    date.setUTCFullYear(date.getUTCFullYear() - quickYears);
    return date.toISOString().slice(0, 10);
  }, [lastDate, quickYears]);
  function quickPeriod(years: number) {
    if (!data) { return; }
    if (holdingPreview) { setFixedHolding(false); setHoldingMessage(''); }
    setQuickYears(years);
    const date = new Date(lastDate);
    date.setUTCFullYear(date.getUTCFullYear() - years);
    setStart(years === 0 ? firstDate : [firstDate, date.toISOString().slice(0, 10)].sort().at(-1)!);
    setEnd(lastDate);
  }
  function movePeriod(amount: number) {
    if (!data) { return; }
    const offset = Math.max(-startIndex, Math.min(amount, timeline.length - 1 - endIndex));
    changeRange(timeline[startIndex + offset].date, timeline[endIndex + offset].date);
  }
  function selectHolding(window: HoldingWindow) {
    setFixedHolding(true);
    setHoldingMessage('');
    setStart(window.start);
    setEnd(window.end);
    setInspected(window.end);
    setKind('hold');
    setActive(true);
  }
  function chooseHoldingYears(years: number) {
    setHoldingYears(years);
    const latestStart = timeline.findLast(point => anniversary(point.date, years) <= lastDate)?.date;
    const anchor = latestStart && start > latestStart ? latestStart : start;
    const window = holdingWindow(timeline, anchor, years);
    if (window) { selectHolding(window); }
    else {
      setFixedHolding(false);
      setHoldingMessage(`${years}년을 완주할 수 있는 이력이 없습니다. 추정 이력을 포함하거나 보유 연수를 줄여주세요.`);
    }
  }
  function changeRange(nextStart: string, nextEnd: string) {
    if (!holdingPreview || !fixedHolding) { setStart(nextStart); setEnd(nextEnd); return; }
    const latestStart = timeline.findLast(point => anniversary(point.date, holdingYears) <= lastDate)?.date;
    const anchor = nextStart !== start ? nextStart : anniversary(nextEnd, -holdingYears);
    const bounded = latestStart && anchor > latestStart ? latestStart : anchor;
    const window = holdingWindow(timeline, bounded, holdingYears);
    if (window) { setStart(window.start); setEnd(window.end); setHoldingMessage(''); }
    else { setHoldingMessage('현재 이력으로 고정 보유 기간을 채울 수 없습니다.'); }
  }
  return <div className="shell">
    <a className="skip-link" href="#workspace">차트와 결과로 이동</a>
    <aside className="sidebar" aria-label="백테스트 설정"><div className="brand">Backtest<span>Studio</span></div>
      <h2><b>01</b> 투자 대상</h2>
      <label className="field">종목<select aria-label="종목" value={symbol} onChange={event => { onSymbol(event.target.value as SymbolCode); }}>
        {instruments.map(item => <option key={item.symbol} value={item.symbol}>{item.currency === 'KRW' ? item.name : item.symbol}</option>)}
      </select></label>
      <div className="instrument"><strong className="ticker">{symbol === '418660.KS' ? 'TG' : symbol.slice(0,2)}</strong><span><strong>{instrument.name}</strong><small>일간 {instrument.leverage}배 · {instrument.currency}</small></span></div>
      <label className="check"><input aria-label="추정 데이터 포함" type="checkbox" checked={estimatedEnabled} disabled={!data || isQqq5} onChange={event => { setEstimatedEnabled(event.target.checked); }} /> 추정 데이터 포함</label><p className="hint">{isQqq5 ? 'QQQ5는 실제 시세로 백테스트합니다.' : '상장 전 연구용 종가 · 분배금 제외 · 실제/추정 구간을 구분합니다.'}</p>
      {estimated.loading && <p role="status">지수·금리 기반 추정 모델을 불러오고 있습니다…</p>}
      {estimated.error && <p className="error" role="alert">{estimated.error}</p>}
      {estimatedEnabled && <button type="button" disabled={estimated.loading} onClick={estimated.refresh}>{import.meta.env.MODE === 'pages' ? '배포된 추정 모델 다시 읽기' : '추정 모델 다시 생성'}</button>}
      <label className="check"><input aria-label="환율 고려 원화 성과" type="checkbox" checked={fxEnabled} disabled={instrument.currency !== 'USD'} onChange={event => { setFxEnabled(event.target.checked); }} />환율 고려 · 원화 성과</label><p className="hint">{instrument.currency === 'KRW' ? 'TIGER는 원화 가격이므로 환율을 중복 적용하지 않습니다.' : '날짜별 관측 환율로 납입·인출·평가액을 별도 환산합니다.'}</p>
      <h2><b>02</b> 투자 전략</h2>
      <form onSubmit={event => { event.preventDefault(); setActive(true); setRun(value => value + 1); }}>
        <label className="field">전략 선택<select aria-label="전략 선택" value={kind} onChange={event => { setKind(event.target.value); }}><option value="hold">일시불 장기투자</option><option value="dca">일반 적립식 투자</option><option value="sma200">200일 이동평균선 돌파</option><option value="nasdaq-sma200">나스닥100 200일 이동평균선 돌파</option><option value="infinite">무한매수법 V3.0 · 참고 재현</option><option value="vr">VR 5.0 · 참고 재현</option></select></label>
        <label className="field">초기 투자금 · {instrument.currency}<input aria-label="초기 투자금" type="number" min="1" step="any" required value={capital} onChange={event => { setCapital(event.target.value); }} disabled={kind === 'dca'} /></label>
        {kind === 'sma200' && <p className="hint">종가가 200거래일 단순이동평균선 위로 올라가면 매수하고 아래로 내려가면 전량 매도합니다. 다음 거래일 시가에 체결하며, 추정 구간에서는 다음 거래일 추정 종가를 사용합니다.</p>}
        {usesNasdaq && <>
          <p className="hint">나스닥100 종가가 지수의 200일선 위로 올라가면 선택 종목을 매수하고, 아래로 내려가면 전량 매도합니다. 지수 신호일 이후 첫 종목 거래일의 시가로 체결합니다. 추정 구간은 추정 종가로 체결합니다.</p>
          {nasdaqError ? <p className="hint" role="alert">{nasdaqError} <button type="button" onClick={() => setNasdaqRevision(value => value + 1)}>지수 다시 조회</button></p>
            : <p className="hint" role="status">{nasdaq ? `나스닥100 마지막 일봉 ${nasdaq.data.points.at(-1)?.date}${nasdaq.stale ? ' · 최신 시세 조회 실패로 기존 캐시 사용' : ''}` : '나스닥100 지수 조회 중…'}</p>}
        </>}
        {kind === 'dca' && <><label className="field">회당 납입금<input aria-label="회당 납입금" type="number" min="1" step="any" required value={contribution} onChange={event => { setContribution(event.target.value); }} /></label>
          <label className="field">납입 주기<select aria-label="납입 주기" value={interval} onChange={event => { setInterval(event.target.value as typeof interval); }}><option value="monthly">매월 첫 거래일</option><option value="weekly">매주</option><option value="biweekly">격주</option></select></label></>}
        {kind === 'infinite' && <div className="infinite-settings strategy-block">
          <label className="field">분할 수<input aria-label="V3 분할 수" type="number" min="2" max="1000" step="1" required value={splits} onChange={event => { setSplits(event.target.value); }} /></label>
          <label className="field">목표 수익률 · %<input aria-label="V3 목표 수익률" type="number" min="0.01" max="99.99" step="any" required value={target} onChange={event => { setTarget(event.target.value); }} /></label>
          <label className="field">양의 실현수익 재투입 · %<input aria-label="V3 재투입 비율" type="number" min="0" max="100" step="any" required value={reinvestment} onChange={event => { setReinvestment(event.target.value); }} /></label>
          <label className="field">고정 주문 가격 단위 · {instrument.currency}<input aria-label="V3 가격 단위" type="number" min="0.0001" step="any" required value={tick} onChange={event => { setTick(event.target.value); }} /></label>
          <p className="hint">입력 가격 단위의 고정 반올림 실험입니다. 국내 ETF 저가 구간·과거 제도의 동적 호가 단위는 자동 재현하지 않습니다.</p>
          <p className="hint"><a href="https://cafe.naver.com/infinitebuying/59826" target="_blank" rel="noreferrer">V3.0 원문</a>의 T·별%·반복리·쿼터매도와 대조했습니다. 정수주 배분·하단 LOC 가격 단위·장중 순서는 아래 체결 가정을 적용합니다.</p>
        </div>}
        {kind === 'vr' && <div className="vr-settings strategy-block">
          <label className="field">VR 운용 유형<select aria-label="VR 운용 유형" value={vrMode} onChange={event => { const mode = event.target.value as typeof vrMode; setVrMode(mode); setVrPool(mode === 'accumulate' ? '75' : mode === 'withdraw' ? '25' : '50'); setVrGradient(mode === 'withdraw' ? '20' : '10'); }}><option value="hold">거치식</option><option value="accumulate">적립식</option><option value="withdraw">인출식</option></select></label>
          <label className="check"><input aria-label="VR 실력공식 사용" type="checkbox" checked={vrAdvanced} onChange={event => { setVrAdvanced(event.target.checked); }} />실력공식 사용</label>
          <label className="field">초기 주식 배분 · %<input aria-label="VR 초기 주식 배분" type="number" min="0.01" max="100" step="any" required value={vrStock} onChange={event => { setVrStock(event.target.value); }} /></label>
          <label className="field">초기 목표 V · 0은 자동<input aria-label="VR 초기 V" type="number" min="0" step="any" required value={vrValue} onChange={event => { setVrValue(event.target.value); }} /></label>
          <label className="field">G 값<input aria-label="VR G 값" type="number" min="1" max="10000" step="any" required value={vrGradient} onChange={event => { setVrGradient(event.target.value); }} /></label>
          <label className="field">밴드 · ±%<input aria-label="VR 밴드" type="number" min="0.01" max="99.99" step="any" required value={vrBand} onChange={event => { setVrBand(event.target.value); }} /></label>
          {vrMode !== 'hold' && <><label className="field">VR 회당 {vrMode === 'withdraw' ? '인출' : '납입'} · {instrument.currency}<input aria-label="VR 입출금액" type="number" min="0" step="any" required value={vrFlow} onChange={event => { setVrFlow(event.target.value); }} /></label><label className="field">VR 입출금 주기 · 달력 일<input aria-label="VR 입출금 주기" type="number" min="1" max="366" step="1" required value={vrFlowDays} onChange={event => { setVrFlowDays(event.target.value); }} /></label></>}
          {vrMode === 'withdraw' && <label className="field">인출 시작일 · 공란은 첫 정기일<input aria-label="VR 인출 시작일" type="date" value={vrWithdrawalStart} onChange={event => { setVrWithdrawalStart(event.target.value); }} /></label>}
          <details className="strategy-details"><summary>주기 · Pool · 가격 단위</summary>
            <label className="field">V 갱신 주기 · 달력 일<input aria-label="VR V 갱신 주기" type="number" min="1" max="366" step="1" required value={vrCycle} onChange={event => { setVrCycle(event.target.value); }} /></label>
            <label className="field">주기별 Pool 사용 한도 · %<input aria-label="VR Pool 한도" type="number" min="0" max="100" step="any" required value={vrPool} onChange={event => { setVrPool(event.target.value); }} /></label>
            <label className="field">연간 G 증가<input aria-label="VR 연간 G 증가" type="number" min="0" max="100" step="any" required value={vrAnnual} onChange={event => { setVrAnnual(event.target.value); }} /></label>
            <label className="field">고정 주문 가격 단위 · {instrument.currency}<input aria-label="VR 가격 단위" type="number" min="0.0001" step="any" required value={vrTick} onChange={event => { setVrTick(event.target.value); }} /></label>
          </details><p className="hint"><a href="https://cafe.naver.com/infinitebuying/38944" target="_blank" rel="noreferrer">VR5.0 원문</a>의 기본공식·Pool 한도·예약매수표를 대조했습니다. <a href="https://www.youtube.com/watch?v=cIp8G3AVtnM&amp;t=55s" target="_blank" rel="noreferrer">원저자 영상 55~65초</a>에서 실력공식과 마지막 평가금 E도 대조했습니다. VR 입출금은 일반 적립식 납입금과 별도입니다.</p>
        </div>}
        {isQqq5 ? <p className="hint">QQQ5는 USD 기준 세전 일반계좌 백테스트를 지원합니다.</p> : <Phase2Settings symbol={symbol} currency={instrument.currency} value={phaseSettings} onChange={onPhaseSettings} />}
        {!isQqq5 && phaseSettings.taxEnabled && <div className="phase-data-controls"><button type="button" disabled={instrument.currency==='USD'?fxLoading:taxBasis.loading} onClick={()=>{if(instrument.currency==='USD')setFxRevision(value=>value+1);else taxBasis.refresh();}}>{instrument.currency==='USD'?'세금용 환율 다시 조회':'과표기준가격 다시 조회'}</button><a href="#withdrawals-panel">중간 인출 일정 ↓</a></div>}
        <button className="run" disabled={!data || loading || !accountValid || (usesNasdaq && !nasdaq) || !['hold', 'dca', 'sma200', 'nasdaq-sma200', 'infinite', 'vr'].includes(kind)}>{calculation.status === 'working' ? '계산 중…' : '백테스트 시작'}</button>
      </form>
      <p className="hint">실행 후 기간·설정 변경 시 초기 조건으로 다시 계산합니다. V3·VR은 참고 재현이며 원화 성과는 사후 관측 환산입니다.</p>
    </aside>
    <main className="main" id="workspace" data-calculating={calculation.status === 'working'} aria-busy={calculation.status === 'working'}><header className="topbar"><div className="mobile-brand">BacktestStudio</div><div className="crumb">백테스트 워크벤치 <span>/</span> <strong>투자 분석</strong></div><div className="top-actions"><a className="text-link" href="#data-notes">데이터 · 계산 기준</a><span className="badge">로컬 · 연구용 데이터</span></div></header>
      <div className="content">
      {holdingPreview && <div className="holding-preview-banner"><span>고정 보유 기간 UI 검토 · 실제 앱의 차트·계산·계좌 화면을 사용합니다.</span><a href="/">기존 화면</a></div>}
      <div className="heading"><div><h1>가격에서 계좌까지, 한눈에.</h1><p>차트에서 기간을 고르고, 매매가 자산과 현금에 남긴 변화를 확인합니다.</p></div><span className="badge">{(isQqq5||phaseSettings.taxEnabled)?'운용 성과 · 세전':'백테스트 워크스페이스'}</span></div>
      <div className="notice">분배금 제외 · 가격수익·매매·입출금 기준입니다. 실제 가격은 연구용 공급원이며 추정 가격은 상장 후 자료로 보정한 가상 결과입니다.</div>



      <div className="metrics">{[
          ['최종 총자산', money(final?.total), `순손익 ${money(final?.profit)}`],
          ['납입금 대비 수익률', percent(result?.metrics.returnOnContributions), `누적 납입 ${money(final?.deposited)}`],
          ['시간가중 수익률 · TWR', percent(result?.metrics.twr), `CAGR ${metric(result?.metrics.cagr)}`],
        ['최대 낙폭 · MDD', percent(result?.metrics.mdd), '입출금을 제거한 운용곡선 기준'],
        ].map(([label, value, detail], index) => <div className="metric" key={label} style={{ '--metric-chars': value.length } as CSSProperties}><span>{label}</span><strong className={index === 1 ? (final?.profit ?? 0) < 0 ? 'negative' : 'positive' : index === 2 ? (result?.metrics.twr ?? 0) < 0 ? 'negative' : 'positive' : index === 3 ? 'negative' : undefined}>{value}</strong><small>{detail}</small></div>)}</div>
      <CostLossSummary point={result?.metrics.maxCostLoss} pending={calculation.status === 'working'} currency={instrument.currency} onInspect={date => { setInspected(date); setPinned(true); }} />
      {result && <div className="performance-details">{result.days.some(day => day.estimated) && <strong>상장 전 추정 종가 체결 포함 · 가상 결과</strong>}<span>XIRR: {metric(result.metrics.xirr)}</span><span>CAGR: {metric(result.metrics.cagr)}</span><span>외부 인출 {money(final?.withdrawn)}</span></div>}
      {result && <div className="performance-details" aria-label="선택 기간 데이터 구성">{coverage.map(part => <span key={String(part.estimated)}>{part.estimated ? '추정 종가' : '실제 OHLC'} {part.start} ~ {part.end} · {part.count.toLocaleString()}거래일 ({percent(part.fraction)})</span>)}</div>}
      {final&&result?.accountReport?.withdrawals.some(request=>!request.excluded)&&<div className="phase-withdrawal-summary"><span>잔여 계좌자산 <strong>{money(final.total)}</strong></span><span>누적 인출 순수령 <strong>{money(result.accountReport.withdrawnNet)}</strong></span><span>자산 + 누적 순수령 <strong>{money(final.total+result.accountReport.withdrawnNet)}</strong></span><small>납부 세금과 최종 정산 세액은 아래 세금 보고서에서 별도로 확인합니다.</small></div>}
      <section className="panel price-panel"><div className="panel-head"><div className="panel-title"><h2>가격과 매매</h2><small>{start && end ? `${start} — ${end}` : '종목을 선택해 시작하세요'}</small></div><div className="checkbox-row"><label className="check"><input type="checkbox" checked={markers} onChange={event => { setMarkers(event.target.checked); }} />차트에 매매 표시</label><button disabled={loading} onClick={onRefresh}>시세 새로 조회</button></div></div>
        {holdingPreview && <HoldingPeriodControls fixed={fixedHolding} years={holdingYears} message={holdingMessage} onYears={chooseHoldingYears} onMode={fixed => { if (fixed) { chooseHoldingYears(holdingYears); } else { setFixedHolding(false); setHoldingMessage(''); } }} />}
        {loading && <div className="empty" role="status">가격 이력을 조회하고 있습니다…</div>}
        {error && <div className="empty error" role="alert">{error}<p>새로 조회 버튼으로 재시도할 수 있습니다.</p></div>}
        {data && <><PriceChart data={data} estimate={estimate} result={result} markers={markers} start={start} end={end} onInspect={inspect} accountDate={account?.date} events={timelineEvents} onRange={changeRange} />
          <HistoryNavigator data={timelineData} start={start} end={end} onRange={changeRange} />
          <div className="period-controls"><div className="quick-periods">{[1, 3, 5, 10, 0].map(years => <button key={years} onClick={() => { quickPeriod(years); }}>{years ? `${years}년` : '전체'}</button>)}</div>
            {requestedQuickStart && requestedQuickStart < firstDate && start === firstDate && end === lastDate && <p className="hint" role="status">요청한 {quickYears}년의 시작일 {requestedQuickStart}보다 현재 데이터가 늦게 시작하므로 {firstDate}부터 선택했습니다. {estimate ? '확보된 기초지수·환율·거래일 이전의 추정 가격은 생성하지 않습니다.' : '현재 실제 시세만 사용 중입니다. 추정 데이터 포함을 선택하면 확보 가능한 상장 전 구간을 추가합니다.'}</p>}
            <div className="date-fields"><label>시작일<input aria-label="시작일" type="date" min={firstDate} max={end || lastDate} value={start} onChange={event => { changeRange(event.target.value, end); }} /></label><label>종료일<input aria-label="종료일" type="date" min={start || firstDate} max={lastDate} value={end} disabled={holdingPreview && fixedHolding} onChange={event => { changeRange(start, event.target.value); }} /></label></div>
            <div className="range-fields"><label>시작 범위<input aria-label="시작 범위" type="range" min="0" max={Math.max(0, endIndex)} value={startIndex} onChange={event => { changeRange(timeline[Number(event.target.value)].date, end); }} /></label><label>종료 범위<input aria-label="종료 범위" type="range" min={startIndex} max={timeline.length - 1} value={endIndex} disabled={holdingPreview && fixedHolding} onChange={event => { changeRange(start, timeline[Number(event.target.value)].date); }} /></label></div>
            <div className="quick-periods"><button onClick={() => { movePeriod(-22); }}>← 22거래일</button><button onClick={() => { movePeriod(22); }}>22거래일 →</button><small>확대·이동은 표시만 변경합니다. 데이터가 부족한 빠른 기간은 실제 시작일까지만 선택합니다.</small></div>
          </div><div className="chart-meta">{firstDate} ~ {lastDate} · {timeline.length.toLocaleString()} 거래일 · {import.meta.env.MODE === 'pages' ? '배포 데이터' : response?.cache === 'cached' ? '파일 캐시' : '신규 조회'}{response?.stale ? (import.meta.env.MODE === 'pages' ? ' · 오래된 캐시' : ' · 최신 시세 조회 실패로 기존 캐시 표시') : ''}<br />거래소 기준일 {marketToday} · 마지막 일봉 {lastDate}<br />수집: {new Date(data.fetchedAt).toLocaleString('ko-KR')} · 버전 {data.version.slice(0, 12)} · 차트는 분할수정 가격, 거래 내역은 당시 체결 단위입니다.</div></>}
      </section>
      <div className="lower-grid"><section className="panel"><div className="panel-head"><h2>자산 · 현금 흐름</h2><small>총자산 · 주식 · 현금</small></div>{result ? <AssetChart result={result} onInspect={inspect} accountDate={account?.date} events={timelineEvents} /> : <div className="empty">백테스트 실행 후 자산 곡선을 표시합니다.</div>}</section>
        <section className="panel"><div className="panel-head"><h2>그날의 계좌{account?.estimated ? ' · 추정 종가' : ''}</h2><button aria-pressed={pinned} onClick={() => { setPinned(value => !value); }}>{pinned ? '고정 해제' : '날짜 고정'}</button></div><div className="account"><label className="field">조회일<input aria-label="계좌 조회일" type="date" min={result?.start} max={result?.end} value={account?.date ?? ''} disabled={!result} onChange={event => { setInspected(event.target.value); }} /></label>{[
          ['보유 수량', account ? `${account.quantity.toLocaleString()}주` : '—'], ['평균 매입가', money(account?.averageCost)], ['매입 원금', money(account?.cost)], ['주식 평가금액', money(account?.stock)], ['가용 현금', money(account?.cash)], ['당일 매도 잠금', money(account?.lockedCash)], ['실현손익', money(account?.realized)], ['평가손익', money(account?.unrealized)], ['누적 납입금', money(account?.deposited)], ['당일 납입금', money(account?.contribution)], ['누적 인출금', money(account?.withdrawn)], ['당일 인출금', money(account?.withdrawal)], ['총자산', money(account?.total)],
          ...(account?.strategyState?.kind === 'infinite' ? [
            ['V3 진행 T', account.strategyState.round.toFixed(1)],
            ['전략 모드', account.strategyState.mode === 'quarter' ? '쿼터모드' : '일반모드'],
            ['주문 별%', percent(account.strategyState.starPercent)],
            ['다음 회당 매수액', money(account.strategyState.oneBuy)],
            ['현금/단위 부족', account.strategyState.cashShortage ? '발생' : '없음'],
          ] : []),
          ...(account?.strategyState?.kind === 'vr' ? [
            ['VR 목표 V', money(account.strategyState.value)], ['VR 하단', money(account.strategyState.lower)], ['VR 상단', money(account.strategyState.upper)],
            ['VR 적용 G', account.strategyState.gradient.toFixed(2)], ['VR 잔여 매수 예산', money(account.strategyState.cycleBudget)],
            ['VR 공식', account.strategyState.advanced ? '실력공식' : '기본공식'], ['VR 누적 미지급 인출', money(account.strategyState.unfundedWithdrawals)],
            ['VR Pool/현금 부족', account.strategyState.cashShortage ? '발생' : '없음'],
          ] : []),
        ].map(([label, value]) => <p key={label}><span>{label}</span><strong>{value}</strong></p>)}</div></section></div>
      {holdingPreview && <HoldingPeriodDesign points={timeline} years={holdingYears} selectedStart={start} selectedEnd={end} estimated={Boolean(estimate)} onSelect={selectHolding} />}
      {fxEnabled && instrument.currency === 'USD' && <KrwReport report={result?.krw} loading={fxLoading || calculation.status === 'working'} error={fxError || result?.krwError} accountDate={account?.date} onInspect={inspect} onRefresh={() => { setFxRevision(value => value + 1); }} />}
      <div className="calculation-status" role="status" aria-live="polite">{calculation.status === 'working' ? '선택 기간을 새로 계산하고 있습니다…' : calculation.status === 'error' ? calculation.error : result ? `${result.start} ~ ${result.end} · ${result.days.length.toLocaleString()} 거래일 · ${calculation.milliseconds?.toFixed(1)}ms${calculation.cached ? ' · 기본 계산 캐시' : ''}` : '기간과 설정을 확인하고 백테스트를 시작하세요.'}</div>
      <TradeHistory result={result} working={calculation.status === 'working'} currency={instrument.currency} onInspect={setInspected} />
      {!isQqq5 && <><Suspense fallback={<div className="empty">세금 보고서를 불러오고 있습니다.</div>}><Phase2Report account={phaseSettings.account} report={result?.tax} accountReport={result?.accountReport} enabled={phaseSettings.taxEnabled}
        loading={calculation.status==='working'||(phaseSettings.taxEnabled&&(instrument.currency==='USD'?fxLoading:taxBasis.loading))}
        error={!accountValid?'현재 종목에서 사용할 계좌를 다시 선택하세요.':calculation.error||(instrument.currency==='USD'?fxError:taxBasis.error)||undefined}
        scenario={phaseSettings.scenario} onScenario={scenario=>onPhaseSettings({scenario})} onInspect={inspect} /></Suspense>
      <section aria-label="중간 인출 일정과 실행 결과">
        <details className="section-disclosure"><summary>중간 인출 일정 · 실행 결과</summary><div className="section-disclosure-body">
          <Phase2Withdrawals items={withdrawals} onChange={onWithdrawals} currency={instrument.currency} start={start} end={end} />
          <Phase2WithdrawalLog report={result?.accountReport} start={start} end={end} onInspect={setInspected} />
        </div></details>
      </section></>}
      {result?.comparison && <section className="panel holding-comparison"><div className="panel-head"><h2>동일 입출금 · 단순 보유 참고</h2><small>{instrument.currency} · 분배금 제외</small></div>
        <div className="comparison-body"><p className="hint">선택 전략과 같은 거래일·실제 납입액·인출액을 사용합니다. 납입일 시가(추정 구간은 종가)로 잔액을 합산해 정수주 매수하고 보유합니다. 인출은 현금으로만 지급하며 강제매도하지 않습니다.</p>
        {result.comparison.available ? <><p><span>최종 총자산</span><strong>{money(result.comparison.total)}</strong></p><p><span>순손익</span><strong>{money(result.comparison.profit)}</strong></p><p><span>선택 전략의 총자산 차이</span><strong>{money(final!.total - result.comparison.total)}</strong></p><p><span>단순 보유 XIRR</span><strong>{metric(result.comparison.xirr)}</strong></p><p><span>보유 주식 / 현금</span><strong>{result.comparison.quantity.toLocaleString()}주 / {money(result.comparison.cash)}</strong></p></> : <p role="status">{result.comparison.reason}</p>}</div>
      </section>}
      {estimate && <section className="panel estimate-model"><div className="panel-head"><h2>추정 모델 · 독립 검증</h2><strong>실제 운용 실적 아님</strong></div>
        <div className="model-summary"><p>추정 {estimate.points[0].date} ~ {estimate.points.at(-1)!.date} · 실제 {estimate.anchor.date} 이후</p>
        <p>보정 {estimate.calibration.start} ~ {estimate.calibration.end} ({estimate.calibration.observations}개) · 미사용 검증 {estimate.validation.start} ~ {estimate.validation.end} ({estimate.validation.observations}개)</p>
        <p>연율 잔여 차이 {percent(estimate.calibration.annualResidual)} · 일별 RMSE {percent(estimate.validation.dailyRmse)} · 검증 종료 가격 오차 {percent(estimate.validation.terminalRelativeError)} · 최대 가격 오차 {percent(estimate.validation.maxRelativeError)}</p>
        <p>잔여 차이는 운용보수와 같지 않습니다. 금리 대용치·분배금 제외·추적 차이가 포함될 수 있으며, 검증 오차가 큰 종목도 있습니다.</p>
        <p>최초 실제 1주에 연결한 가격 단위이며 가상 분할을 추가하지 않습니다. 최초 추정 종가(당시 단위) {money(estimate.points[0].close * data!.splits.filter(split => split.date > estimate.points[0].date).reduce((factor, split) => factor * split.ratio, 1))}. 정수주·호가 단위에 따라 매수하지 못할 수 있습니다.</p>
        <details><summary>모델 근거·가정·버전</summary><ul>{estimate.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul><p>생성 {new Date(estimate.fetchedAt).toLocaleString('ko-KR')}</p><ul>{estimate.sources.map(source => <li key={source}><a href={source} target="_blank" rel="noreferrer">{source}</a></li>)}</ul><p>국내 거래일 미확인 제외: {estimate.omittedCalendarDates?.join(', ') || '없음'}</p><p className="model-version">{estimate.version}</p></details></div>
      </section>}
      {kind === 'infinite' && <div className="notice">V3.0 원문 규칙 대조 · 전일 장부로 LOC·하단 추가 주문 예약, 종가 체결·소진¼ MOC. 정수주 쿼터 내림·고정 호가를 적용합니다. 원문의 시간외 지정가는 정규장 OHLC로 근사하며 원형 대상 외 종목 적용은 확장 실험입니다.</div>}
      {kind === 'vr' && <div className="notice">VR5.0 기본·실력공식과 예약매수표 원문·영상 대조. 직전 주식 평가액 E, V 갱신 후 입출금, 매도 우선 기장·주기 Pool 한도·고정 호가 반올림은 체결 가정입니다. 미지급 인출은 실제 인출에 넣지 않습니다.</div>}
      <details className="panel data-notes" id="data-notes"><summary>데이터 근거와 계산 기준</summary>{data ? <ul>{[...data.warnings, ...(result?.warnings ?? [])].map((warning, index) => <li key={index}>{warning}</li>)}</ul> : <p>시세를 불러오면 데이터 출처와 계산 기준을 표시합니다.</p>}</details>
      <footer>정수주 · 분배금 제외 · 현금 이자 0 · 수수료 0 · 운용 원장과 매매차익 세금 분석은 분리합니다.<br />세금은 기본적으로 종료일 종가에 잔여 주식을 전량 매도하는 기준입니다. ISA 세금 공제는 사용자 지정으로 0원입니다.<br />차트: <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a></footer>
      </div>
    </main>
  </div>;
}
