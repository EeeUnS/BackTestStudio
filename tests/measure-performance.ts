import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createMarketStore } from '../server/cache.ts';
import { instruments } from '../src/data/market.ts';
import type { MarketData } from '../src/data/market.ts';
import { createCalculationSession } from '../src/worker/session.ts';
import type { BacktestRequest, BacktestResult } from '../src/engine/simpleBacktest.ts';
interface Reply { result?: BacktestResult; cached?: boolean; computeMs: number; error?: string }
interface Measurement { symbol: string; range: string; size: string; strategy: BacktestRequest['strategy']; mode: string; days: number; trades: number; computeMs: number; roundTripMs: number; cached: boolean }
function strategies(capital: number, flow: number, tick: number): BacktestRequest['strategy'][] {
  return [
    { kind: 'hold', capital },
    ...(['weekly', 'biweekly', 'monthly'] as const).map(interval => ({ kind: 'dca' as const, contribution: flow, interval })),
    { kind: 'infinite', capital, splits: 40, target: 0.1, reinvestment: 0.5, tick },
    ...(['hold', 'accumulate', 'withdraw'] as const).flatMap(mode => [false, true].map(advanced => ({ kind: 'vr' as const, capital, mode, advanced, initialStockFraction: 0.9, initialValue: 0, gradient: mode === 'withdraw' ? 20 : 10, annualGradientIncrease: 1, band: 0.15, cycleDays: 14, poolUse: mode === 'accumulate' ? 0.75 : mode === 'withdraw' ? 0.25 : 0.5, flowAmount: flow, flowDays: 14, tick }))),
  ];
}
if (!isMainThread) {
  const session = createCalculationSession();
  const begin = performance.now();
  session.load(workerData as MarketData);
  parentPort!.postMessage({ computeMs: performance.now() - begin } satisfies Reply);
  parentPort!.on('message', (message: { kind: 'load' } | { kind: 'run'; request: BacktestRequest }) => {
    const start = performance.now();
    try {
      if (message.kind === 'load') {
        session.load(workerData as MarketData);
        parentPort!.postMessage({ computeMs: performance.now() - start } satisfies Reply);
      } else {
        parentPort!.postMessage({ ...session.run(message.request), computeMs: performance.now() - start } satisfies Reply);
      }
    } catch (error) {
      parentPort!.postMessage({ computeMs: performance.now() - start, error: error instanceof Error ? error.message : String(error) } satisfies Reply);
    }
  });
} else {
  const rows: Measurement[] = [];
  const failures: { symbol: string; range: string; size: string; strategy: BacktestRequest['strategy']; error: string }[] = [];
  const loads: { symbol: string; computeMs: number; startupAndLoadMs: number }[] = [];
  const versions: { symbol: string; version: string; first: string; last: string; bars: number }[] = [];
  const store = createMarketStore('cache');
  const startedAt = new Date().toISOString();
  function receive(worker: Worker): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); worker.off('message', reply); worker.off('error', fail); };
      const reply = (value: Reply) => { cleanup(); if (value.error) { reject(new Error(value.error)); } else { resolve(value); } };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('측정 Worker 30초 응답 시간 초과')); }, 30000);
      worker.once('message', reply); worker.once('error', fail);
    });
  }
  for (const instrument of instruments) {
    const data = (await store.get(instrument.symbol)).data;
    versions.push({ symbol: data.symbol, version: data.version, first: data.bars[0].date, last: data.bars.at(-1)!.date, bars: data.bars.length });
    const cutoff = new Date(data.bars.at(-1)!.date);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5);
    for (const range of ['5y', 'full']) {
      const start = range === 'full' ? data.bars[0].date : data.bars.find(bar => bar.date >= cutoff.toISOString().slice(0, 10))!.date;
      for (const size of ['normal', 'large']) {
        const scale = (instrument.currency === 'KRW' ? 1000 : 1) * (size === 'large' ? 1000 : 1);
        for (const strategy of strategies(10000 * scale, 250 * scale, instrument.currency === 'KRW' ? 5 : 0.01)) {
          const workerStart = performance.now();
          const worker = new Worker(new URL(import.meta.url), { workerData: data });
          try {
            const loaded = await receive(worker);
            loads.push({ symbol: data.symbol, computeMs: loaded.computeMs, startupAndLoadMs: performance.now() - workerStart });
            const request = { start, end: data.bars.at(-1)!.date, strategy };
            const run = async (mode: string, value: BacktestRequest) => {
              const before = performance.now();
              const pending = receive(worker);
              worker.postMessage({ kind: 'run', request: value });
              const reply = await pending;
              const roundTripMs = performance.now() - before;
              assert(reply.result);
              rows.push({ symbol: data.symbol, range, size, strategy, mode, days: reply.result.days.length, trades: reply.result.trades.length, computeMs: reply.computeMs, roundTripMs, cached: reply.cached ?? false });
              return reply.result;
            };
            const cold = await run('cold', request);
            assert.deepEqual(await run('cached', request), cold);
            const short = { ...request, end: data.bars.at(-23)!.date };
            const snapshot = await run('shorten', short);
            const pending = receive(worker); worker.postMessage({ kind: 'load' }); await pending;
            assert.deepEqual(await run('prefix-new', short), snapshot);
            assert.deepEqual(await run('extend', request), cold);
          } catch (error) {
            failures.push({ symbol: data.symbol, range, size, strategy, error: error instanceof Error ? error.message : String(error) });
          } finally { await worker.terminate(); }
        }
      }
    }
    console.log(`${data.symbol}: 측정 ${rows.length}행, 실패 ${failures.length}건`);
  }
  await mkdir('work', { recursive: true });
  await writeFile('work/performance.json', JSON.stringify({ startedAt, completedAt: new Date().toISOString(), node: process.version, platform: process.platform, cpu: cpus()[0]?.model, versions, loads, rows, failures, note: 'Node worker_threads 실제 세션과 전체 결과 메시지. 네트워크/디스크·브라우저 렌더·100ms 입력 합치기·환율 제외. 조합별 1회 측정, 세션 cold이며 OS/JIT cold 보장 아님.' }, undefined, 2), 'utf8');
  console.log(JSON.stringify({ rows: rows.length, cases: loads.length, failures: failures.length, output: 'work/performance.json' }));
  if (failures.length > 0) { process.exitCode = 1; }
}
