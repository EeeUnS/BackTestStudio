import { fetchAppData } from '../data/fetchAppData.ts';
import {useEffect,useRef,useState} from 'react';
import {validateTaxBasis} from '../data/taxBasis.ts';
import type {MarketData} from '../data/market.ts';
import type {TaxBasisData} from '../tax/types.ts';

export function useTaxBasis(data:MarketData|undefined,enabled:boolean) {
  const [value,setValue]=useState<TaxBasisData>();
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const loaded=useRef(-1);
  useEffect(()=>{
    if(!enabled||!data||data.currency!=='KRW'){setLoading(false);return;}
    if(value?.symbol===data.symbol&&loaded.current===revision)return;
    const abort=new AbortController();setValue(undefined);setLoading(true);setError('');
    void(async()=>{try{
      const response=await fetchAppData('tax-basis', data.symbol, revision > 0, abort.signal);
      if(import.meta.env.MODE==='pages'&&response.status===404)throw new Error('배포 데이터에 이 종목의 과표기준가격이 없어 세금을 계산할 수 없습니다.');
      const body=await response.json();if(!response.ok)throw new Error(body.error??`HTTP ${response.status}`);
      const next=validateTaxBasis(body.data);if(next.symbol!==data.symbol)throw new Error('과표기준가격의 종목이 선택 종목과 다릅니다.');
      if(!abort.signal.aborted){setValue({...next,warnings:[...next.warnings??[],...(body.stale?['24시간 이상 지난 과표기준가격 캐시입니다.']:[])]});loaded.current=revision;}
    }catch(cause){if(!abort.signal.aborted)setError(cause instanceof Error?cause.message:'과표기준가격 조회 실패');}
    finally{if(!abort.signal.aborted)setLoading(false);}})();
    return()=>abort.abort();
  },[data,enabled,revision]);
  return {data:enabled&&value?.symbol===data?.symbol?value:undefined,loading:enabled&&loading,error:enabled?error:'',refresh:()=>setRevision(n=>n+1)};
}
