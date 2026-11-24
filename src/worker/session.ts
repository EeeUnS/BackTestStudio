import { validateMarket } from '../data/market.ts';
import { validateFx } from '../data/fx.ts';
import { validateReference } from '../data/reference.ts';
import type { FxData } from '../data/fx.ts';
import { validateEstimate } from '../model/validate.ts';
import { prepareExecution, prepareEstimatedExecution } from '../data/execution.ts';
import { createBacktestRunner } from '../engine/simpleBacktest.ts';
import { convertToKrw } from '../engine/fx.ts';
import { compareHolding } from '../engine/benchmark.ts';
import { validateTaxBasis } from '../data/taxBasis.ts';
import { analyzeTax } from '../tax/analyze.ts';
import { TAX_POLICY } from '../tax/policy.ts';
import type { TaxBasisData, TaxReport } from '../tax/types.ts';
import type { CalculationRequest, CalculationResult } from './protocol.ts';
import type { BacktestRequest, BacktestResult, ExecutionData } from '../engine/simpleBacktest.ts';
export function createCalculationSession() {
  let prepared: ExecutionData | undefined;
  let currency = '';
  let fx: FxData | undefined;
  let taxBasis:TaxBasisData|undefined;
  const taxCache=new Map<string,TaxReport>();
  const cache = new Map<string, BacktestResult>();
  const runners = new Map<string, ReturnType<typeof createBacktestRunner>>();
  function load(value: unknown, estimate?: unknown, nasdaq?: unknown) {
    prepared = undefined;
    currency = '';
    taxBasis=undefined;
    taxCache.clear();
    cache.clear();
    runners.clear();
    const data = validateMarket(value);
    currency = data.currency;
    const execution = estimate === undefined ? prepareExecution(data, data.bars[0].date, data.bars.at(-1)!.date) : prepareEstimatedExecution(data, validateEstimate(estimate));
    prepared = nasdaq === undefined ? execution : { ...execution, nasdaq: validateReference(nasdaq) };
  }
  function loadFx(value: unknown) {
    fx = undefined;
    taxCache.clear();
    if (value !== undefined) { fx = validateFx(value); }
  }
  function loadTaxBasis(value:unknown) {
    taxBasis=undefined;taxCache.clear();
    if(value!==undefined)taxBasis=validateTaxBasis(value);
  }
  function run(request: CalculationRequest) {
    if (!prepared) {
      throw new Error('계산 데이터를 먼저 로드해야 합니다.');
    }
    const { reportInKrw, tax, ...baseRequest } = request;
    if(tax && tax.account !== (baseRequest.account??'general'))throw new Error('전략 원장의 계좌와 세금 분석 계좌가 다릅니다. 같은 계좌를 선택하세요.');
    const key = JSON.stringify(baseRequest);
    let result = cache.get(key);
    const cached = Boolean(result);
    if (result) {
      cache.delete(key);
      cache.set(key, result);
    }
    else {
      const { end: _end, ...runnerRequest }=baseRequest;
      const runnerKey = JSON.stringify(runnerRequest);
      let runner = runners.get(runnerKey);
      if (!runner) { runner = createBacktestRunner(prepared, baseRequest); }
      runners.delete(runnerKey);
      result = runner.run(baseRequest.end);
      result = { ...result, comparison: compareHolding(prepared, result) };
      runners.set(runnerKey, runner);
      if (runners.size > 4) { runners.delete(runners.keys().next().value!); }
      cache.set(key, result);
      if (cache.size > 4) {
        cache.delete(cache.keys().next().value!);
      }
    }
    let output:CalculationResult=result;
    if(tax){
      const taxKey=JSON.stringify({request:key,tax,policy:TAX_POLICY.version,fx:fx?.version,basis:taxBasis?.version});
      let report=taxCache.get(taxKey);
      if(!report)report=analyzeTax(result,prepared,tax,fx,taxBasis);
      taxCache.delete(taxKey);taxCache.set(taxKey,report);
      if(taxCache.size>4)taxCache.delete(taxCache.keys().next().value!);
      output={...result,tax:report};
    }
    if (reportInKrw) {
      if (currency !== 'USD') {
        return { result: { ...output, krwError: '기본 통화가 이미 KRW이므로 환율을 중복 적용하지 않습니다.' }, cached };
      }
      if (!fx) {
        return { result: { ...output, krwError: '환율 데이터를 먼저 조회해야 합니다.' }, cached };
      }
      if (result.start < fx.observations[0].date) {
        return { result: { ...output, krwError: '선택 시작일이 첫 환율 관측 이전이므로 원화 환산만 제공하지 않습니다.' }, cached };
      }
      return { result: { ...output, krw: convertToKrw(result, fx) }, cached };
    }
    return { result:output, cached };
  }
  return { load, loadFx, loadTaxBasis, run };
}
