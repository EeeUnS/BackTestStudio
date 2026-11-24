import type { EstimatedHistory } from '../model/estimate.ts';
import type { FxData } from '../data/fx.ts';
import { useEffect, useRef, useState } from 'react';
import type { MarketData } from '../data/market.ts';
import type { ReferenceData } from '../data/reference.ts';
import type { BacktestRequest, BacktestResult } from '../engine/simpleBacktest.ts';
import type { WorkerReply, WorkerRequest } from '../worker/protocol.ts';
import type { CalculationRequest, CalculationResult } from '../worker/protocol.ts';
import type { TaxBasisData } from '../tax/types.ts';

export interface CalculationState {
  status: 'idle' | 'working' | 'success' | 'error';
  result?: CalculationResult;
  error?: string;
  milliseconds?: number;
  cached?: boolean;
}
export function useBacktest(data: MarketData | undefined, request: CalculationRequest | undefined, fx?: FxData, estimate?: EstimatedHistory, taxBasis?:TaxBasisData, nasdaq?: ReferenceData) {
  const worker = useRef<Worker | undefined>(undefined);
  const sequence = useRef(0);
  const inFlight = useRef<number | undefined>(undefined);
  const replaceWorker = useRef<(() => void) | undefined>(undefined);
  const latestFx = useRef(fx);
  latestFx.current = fx;
  const latestTaxBasis=useRef(taxBasis);
  latestTaxBasis.current=taxBasis;
  const [state, setState] = useState<CalculationState>({ status: 'idle' });
  useEffect(() => {
    sequence.current++;
    setState({ status: 'idle' });
    if (!data) { return; }
    const createWorker = () => {
      worker.current?.terminate();
      inFlight.current = undefined;
      const instance = new Worker(new URL('../worker/backtest.worker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      instance.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (worker.current !== instance) { return; }
        const reply = event.data;
        if (reply.kind === 'ready') { return; }
        if (reply.id !== 0 && reply.id !== sequence.current) { return; }
        inFlight.current = undefined;
        if (reply.kind === 'error') { setState({ status: 'error', error: reply.error }); }
        else { setState({ status: 'success', result: reply.result, milliseconds: reply.milliseconds, cached: reply.cached }); }
      };
      instance.onerror = event => {
        if (worker.current !== instance) { return; }
        inFlight.current = undefined;
        setState({ status: 'error', error: event.message || 'Worker 실행 실패' });
      };
      instance.postMessage({ kind: 'load', data, estimate, nasdaq } satisfies WorkerRequest);
      instance.postMessage({ kind: 'loadFx', data: latestFx.current } satisfies WorkerRequest);
      instance.postMessage({kind:'loadTaxBasis',data:latestTaxBasis.current} satisfies WorkerRequest);
    };
    replaceWorker.current = createWorker;
    createWorker();
    return () => {
      sequence.current++;
      worker.current?.terminate();
      worker.current = undefined;
      replaceWorker.current = undefined;
      inFlight.current = undefined;
    };
  }, [data, estimate, nasdaq]);
  useEffect(() => {
    worker.current?.postMessage({ kind: 'loadFx', data: fx } satisfies WorkerRequest);
  }, [data, fx]);
  useEffect(()=>{worker.current?.postMessage({kind:'loadTaxBasis',data:taxBasis} satisfies WorkerRequest);},[data,taxBasis]);
  useEffect(() => {
    const id = ++sequence.current;
    if (inFlight.current !== undefined) { replaceWorker.current?.(); }
    if (!request || !data) { setState({ status: 'idle' }); return; }
    setState(previous => ({ ...previous, status: 'working', error: undefined }));
    const timer = setTimeout(() => {
      if (worker.current) {
        inFlight.current = id;
        worker.current.postMessage({ kind: 'run', id, request } satisfies WorkerRequest);
      }
    }, 100);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [data, request, fx, estimate, taxBasis, nasdaq]);
  return state;
}
