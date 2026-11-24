import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { WithdrawalRequest } from '../accounts/types.ts';
import { validateWithdrawalDraft } from '../phase2/settings.ts';

export type WithdrawalScheduleItem = WithdrawalRequest;
export interface Phase2WithdrawalsProps {
  items: WithdrawalScheduleItem[];
  onChange: (items: WithdrawalScheduleItem[]) => void;
  currency: 'USD' | 'KRW';
  start: string;
  end: string;
}
export function Phase2Withdrawals({ items, onChange, currency, start, end }: Phase2WithdrawalsProps) {
  const [date, setDate] = useState(start);
  const [amount, setAmount] = useState('');
  const [editing, setEditing] = useState<string>();
  const [draftCurrency, setDraftCurrency] = useState(currency);
  const [error, setError] = useState('');
  const errorElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (!date && start) { setDate(start); } }, [date, start]);
  useEffect(() => { if (!editing) { setDraftCurrency(currency); } }, [currency, editing]);
  useEffect(() => { if (error) { errorElement.current?.focus(); } }, [error]);
  useEffect(() => { if (editing && !items.some(item => item.id === editing)) { setEditing(undefined); setAmount(''); } }, [items, editing]);
  const included = (item: WithdrawalScheduleItem) => item.currency === currency && Boolean(start && end) && item.date >= start && item.date <= end;
  const includedCount = items.filter(included).length;
  const money = (value: number, unit: string) => new Intl.NumberFormat('ko-KR', { style:'currency', currency:unit,
    currencyDisplay:'narrowSymbol', maximumFractionDigits:unit === 'KRW' ? 0 : 2 }).format(value);
  function cancel() { setEditing(undefined); setAmount(''); setError(''); setDraftCurrency(currency); }
  function save(event: FormEvent) {
    event.preventDefault();
    const invalid = validateWithdrawalDraft(date, amount);
    if (invalid) { setError(invalid); return; }
    const item: WithdrawalScheduleItem = { id:editing ?? crypto.randomUUID(), date, amount:Number(amount), currency:draftCurrency };
    onChange([...items.filter(previous => previous.id !== item.id), item].toSorted((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)));
    cancel();
  }
  return <section className="panel phase2-withdrawals" id="withdrawals-panel" aria-labelledby="withdrawals-heading">
    <div className="panel-head"><div className="panel-title"><h2 id="withdrawals-heading">운용 중 중간 인출</h2><small>일정 변경 시 이후 계좌·전략 재계산</small></div><span className="phase-pill">세전 계좌 차감 요청 · {currency}</span></div>
    <div className="phase-body">
      <form className="phase-withdraw-form" onSubmit={save} noValidate>
        <label className="field">인출 요청일<input aria-label="인출 요청일" type="date" value={date} aria-describedby={error ? 'withdrawal-editor-error' : undefined}
          onChange={event => { setDate(event.target.value); setError(''); }} /></label>
        <label className="field">요청 금액 · {draftCurrency}<input aria-label="중간 인출 요청 금액" type="number" min="0.01" step="any" inputMode="decimal" value={amount}
          aria-describedby={error ? 'withdrawal-editor-error' : undefined} onChange={event => { setAmount(event.target.value); setError(''); }} /></label>
        <button type="submit">{editing ? '일정 수정' : '일정 추가'}</button>
        {editing && <button type="button" onClick={cancel}>수정 취소</button>}
      </form>
      <p className="phase-inline-error" id="withdrawal-editor-error" role="alert" tabIndex={-1} ref={errorElement}>{error}</p>
      <div className="phase-withdraw-summary"><span>선택 기간·통화 내 <strong>{includedCount}건</strong></span><span>제외 <strong>{items.length-includedCount}건</strong></span></div>
      <p className="phase-note">현금을 먼저 사용하고 부족분은 정수주 매도로 마련합니다. 매도 재원의 지급은 결제를 기다립니다. VR 정기 인출과 별개 일정이며, 요청액·계좌 차감액·인출세액·순수령액을 실행 내역에서 구분합니다.</p>
    </div>
    {items.length ? <div className="table-scroll"><table className="phase-table"><thead><tr><th>요청일</th><th>요청 금액</th><th>통화</th><th>실행 대상</th><th>일정 편집</th></tr></thead><tbody>
      {items.toSorted((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map(item => <tr key={item.id} data-included={included(item)}>
        <td>{item.date}</td><td>{money(item.amount,item.currency)}</td><td>{item.currency}</td><td>{included(item) ? '포함' : item.currency !== currency ? '통화 불일치 · 제외' : '선택 기간 밖 · 제외'}</td>
        <td><div className="phase-row-actions"><button type="button" aria-label={`${item.date} ${money(item.amount,item.currency)} 인출 수정`} onClick={() => { setEditing(item.id); setDate(item.date); setAmount(String(item.amount)); setDraftCurrency(item.currency); setError(''); }}>수정</button>
          <button type="button" aria-label={`${item.date} ${money(item.amount,item.currency)} 인출 삭제`} onClick={() => { onChange(items.filter(previous => previous.id !== item.id)); if (editing === item.id) { cancel(); } }}>삭제</button></div></td>
      </tr>)}
    </tbody></table></div> : <p className="empty">등록한 중간 인출 일정이 없습니다.</p>}
  </section>;
}
