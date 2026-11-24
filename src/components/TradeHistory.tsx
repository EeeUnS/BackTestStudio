import { memo, useEffect, useMemo, useState } from 'react';
import type { BacktestResult } from '../engine/simpleBacktest.ts';

export const TradeHistory = memo(function TradeHistory({ result, working, currency, onInspect }: {
  result?: BacktestResult; working: boolean; currency: string; onInspect: (date: string) => void;
}) {
  const [settled, setSettled] = useState<BacktestResult>();
  const [side, setSide] = useState('all');
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!result) { setSettled(undefined); return; }
    // Summary metrics use the Worker reply immediately. Build detailed rows
    // after a quiet interval; cancel superseded results instead of flashing them.
    const timer = setTimeout(() => { setSettled(result); }, 120);
    return () => { clearTimeout(timer); };
  }, [result]);
  useEffect(() => { setPage(0); }, [result, side]);
  const trades = useMemo(() => settled?.trades.filter(trade => side === 'all' || side === trade.side) ?? [], [settled, side]);
  const formatter = useMemo(() => new Intl.NumberFormat('ko-KR', {
    style: 'currency', currency, maximumFractionDigits: currency === 'USD' ? 2 : 0,
  }), [currency]);
  const maxPage = Math.max(0, Math.ceil(trades.length / 50) - 1);
  const visiblePage = Math.min(page, maxPage);
  const pending = working || result !== settled;
  return <section className="panel trade-history" aria-busy={pending}>
    <details className="section-disclosure"><summary>거래 내역</summary><div className="section-disclosure-body">
    <div className="panel-head"><h2>거래 내역</h2><select aria-label="거래 유형" value={side} onChange={event => { setSide(event.target.value); }}><option value="all">전체</option><option value="BUY">매수</option><option value="SELL">매도</option></select></div>
    {pending && !settled ? <div className="empty trade-details-status" role="status">상세 거래 내역을 갱신하고 있습니다…</div> : trades.length ? <>
      <div className="table-scroll"><table className="trades"><thead><tr>{['거래일', '유형', '체결가', '수량', '거래금액', '실현손익', '매매 사유'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>
        {trades.slice(visiblePage * 50, (visiblePage + 1) * 50).map((trade, index) => <tr key={`${trade.date}-${index}`} onClick={() => { onInspect(trade.date); }}>
          <td>{trade.date}{trade.estimated ? ' · 추정' : ''}</td><td><span className="trade-tag">{trade.side}</span></td><td>{formatter.format(trade.price)}</td><td>{trade.quantity.toLocaleString()}</td><td>{formatter.format(trade.amount)}</td><td>{formatter.format(trade.realized)}</td><td>{trade.reason}</td>
        </tr>)}
      </tbody></table></div>
      <div className="table-bottom"><span>{trades.length.toLocaleString()}건 · {visiblePage + 1}/{maxPage + 1}페이지</span><button disabled={visiblePage === 0} onClick={() => { setPage(value => value - 1); }}>이전</button><button disabled={visiblePage >= maxPage} onClick={() => { setPage(value => value + 1); }}>다음</button></div>
    </> : <div className="empty">{result ? '해당 유형의 거래가 없습니다.' : '계산된 거래가 없습니다.'}</div>}
  </div></details>
  </section>;
});
