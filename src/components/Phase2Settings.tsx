import { accountEligibility, accountNames } from '../phase2/settings.ts';
import type { AccountKind, Phase2SettingsValue } from '../phase2/settings.ts';

export interface Phase2SettingsProps {
  symbol: string;
  currency: string;
  value: Phase2SettingsValue;
  onChange: (patch: Partial<Phase2SettingsValue>) => void;
}
export function Phase2Settings({ symbol, currency, value, onChange }: Phase2SettingsProps) {
  const selectedValid = value.account !== '' && accountEligibility(symbol, value.account).allowed;
  return <div className="phase2-settings strategy-block">
    <details className="section-disclosure"><summary>계좌 · 세금 설정</summary><div className="section-disclosure-body">
    <h2><b>03</b> 계좌 · 세금</h2>
    <fieldset className="phase-account-fieldset"><legend>계좌 유형</legend>
      <div className="phase-account-options">{(['general', 'isa', 'pension'] as const).map(kind => {
        const rule = accountEligibility(symbol, kind);
        return <label key={kind} className="phase-account-option" data-selected={value.account === kind} data-disabled={!rule.allowed}>
          <input type="radio" name="backtest-account" aria-label={accountNames[kind]} value={kind} checked={value.account === kind}
            disabled={!rule.allowed} onChange={() => { onChange({ account: kind }); }} />
          <span><strong>{accountNames[kind]}</strong><small>{rule.reason}</small></span>
        </label>;
      })}</div>
    </fieldset>
    {!selectedValid && <p className="phase-inline-error" role="alert">현재 종목에서 사용할 계좌를 다시 선택하세요. 계좌를 임의로 바꾸지 않습니다.</p>}
    <label className="check"><input aria-label="매매차익 세금 반영" type="checkbox" checked={value.taxEnabled}
      onChange={event => { onChange({ taxEnabled: event.target.checked }); }} />매매차익 세금 반영</label>
    {value.account === 'general' && <label className="field">세금용 원가 방식<select aria-label="세금용 원가 방식"
      value={value.costMethod} disabled={currency !== 'USD'} onChange={event => { onChange({ costMethod:event.target.value as Phase2SettingsValue['costMethod'] }); }}>
      <option value="fifo">선입선출</option><option value="average">이동평균</option>
    </select><small>{currency === 'USD' ? '세금용 취득원가만 변경합니다. 전략 매매 판단의 평단은 유지합니다.' : '국내 ETF는 상품의 보유기간 과세 규칙을 사용합니다. 해외주식 원가 선택을 적용하지 않습니다.'}</small></label>}
    {value.account === 'general' && <p className="phase-note">세금은 기본적으로 종료일 종가에 잔여 주식을 전량 매도하는 기준으로 계산합니다. 아래 정산 결과에서 다른 시나리오와 비교할 수 있습니다.</p>}
    {value.account === 'isa' && <p className="phase-note">선택 시작일에 신규 개설합니다. 투자 종료 후 전량 매도하고, 결제와 가입 의무기간을 충족한 뒤 정상 해지하는 모형입니다. 사용자 지정: 세금 계산의 공제액은 0원이며 실제 ISA 제도와 다른 가정입니다. 납입한도는 유지합니다.</p>}
    {value.account === 'pension' && <p className="phase-note">세액공제를 받지 않은 원금과 운용수익을 구분합니다. 정상 연금 수령이나 세액공제 환급금은 계산하지 않습니다.</p>}
    <p className="phase-settings-foot">매매차익 과세 반영 · 분배금 과세 미반영<br />현재 규칙을 과거 전체 기간에 고정 적용하는 제한 모형입니다.</p>
  </div></details>
  </div>;
}
