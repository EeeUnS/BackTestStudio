import { fetchAppData } from '../data/fetchAppData.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketData } from '../data/market.ts';
import type { EstimatedHistory } from '../model/estimate.ts';
import { validateEstimate } from '../model/validate.ts';
export function useEstimate(data: MarketData | undefined, enabled: boolean) {
  const [model, setModel] = useState<EstimatedHistory>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const loadedRevision = useRef(-1);
  const valid = model?.symbol === data?.symbol && model?.inputVersions.etf === data?.version;
  useEffect(() => {
    if (!enabled || !data || (valid && loadedRevision.current === revision)) { return; }
    const abort = new AbortController();
    setLoading(true); setError(''); setModel(undefined);
    async function load() {
      try {
        const response = await fetchAppData('estimate', data!.symbol, revision > 0, abort.signal);
        const body = await response.json();
        if (!response.ok) { throw new Error(body.error ?? `HTTP ${response.status}`); }
        const value = validateEstimate(body.data);
        if (value.symbol !== data!.symbol || value.inputVersions.etf !== data!.version || value.anchor.date !== data!.bars[0].date || value.anchor.close !== data!.bars[0].close) { throw new Error('추정 모델과 현재 시세의 종목·버전·연결 가격이 다릅니다. 시세를 새로 조회하세요.'); }
        if (!abort.signal.aborted) { setModel(value); loadedRevision.current = revision; }
      } catch (cause) {
        if (!abort.signal.aborted) { setError(cause instanceof Error ? cause.message : '추정 모델 조회 실패'); }
      } finally { if (!abort.signal.aborted) { setLoading(false); } }
    }
    void load();
    return () => { abort.abort(); };
  }, [data, enabled, revision]);
  return { model: enabled && valid ? model : undefined, loading: enabled && loading, error: enabled ? error : '', refresh: useCallback(() => { setRevision(value => value + 1); }, []) };
}
