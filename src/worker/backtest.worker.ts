import { createCalculationSession } from './session.ts';
import type { WorkerReply, WorkerRequest } from './protocol.ts';
const session = createCalculationSession();
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage: (message: WorkerReply) => void;
};
scope.onmessage = event => {
  const message = event.data;
  try {
    if (message.kind === 'load') { session.load(message.data, message.estimate, message.nasdaq); scope.postMessage({ kind: 'ready' }); return; }
    if (message.kind === 'loadFx') { session.loadFx(message.data); scope.postMessage({ kind: 'ready' }); return; }
    if (message.kind === 'loadTaxBasis') { session.loadTaxBasis(message.data); scope.postMessage({ kind:'ready' }); return; }
    const start = performance.now();
    const value = session.run(message.request);
    scope.postMessage({ kind: 'result', id: message.id, ...value, milliseconds: performance.now() - start });
  } catch (error) {
    scope.postMessage({ kind: 'error', id: message.kind === 'run' ? message.id : 0,
      error: error instanceof Error ? error.message : '계산 Worker 오류입니다.' });
  }
};
