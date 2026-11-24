import { join } from 'node:path';
import { instrumentFor, underlyingIndex } from '../src/data/market.ts';
import { validateEstimate } from '../src/model/validate.ts';
import { estimateHistory } from '../src/model/estimate.ts';
import { createDataStore } from './dataStore.ts';
import { createMarketStore } from './cache.ts';
import { createReferenceStore } from './referenceCache.ts';
import { createFxStore } from './fxCache.ts';
export function createEstimateStore(directory: string) {
  const markets = createMarketStore(directory);
  const references = createReferenceStore(directory);
  const currencies = createFxStore(directory);
  async function inputs(symbol: string) {
    const instrument = instrumentFor(symbol);
    if (instrument.symbol === 'QQQ5.L') { throw new Error('QQQ5의 상장 전 추정은 지원하지 않습니다.'); }
    const [market, index, rates, fx, calendar] = await Promise.all([
      markets.get(symbol), references.get(underlyingIndex(instrument.symbol)), references.get('DFF'),
      instrument.currency === 'KRW' ? currencies.get('USD-KRW') : undefined,
      instrument.currency === 'KRW' ? references.get('KOSPI') : undefined,
    ]);
    const latest = market.data.bars.at(-1)!.date;
    const indexData = instrument.symbol !== 'SOXL' && index.data.points.at(-1)!.date < latest
      ? (await references.get(index.data.id, true)).data : index.data;
    const rateAge = Date.parse(indexData.points.at(-1)!.date) - Date.parse(rates.data.points.at(-1)!.date);
    const rateData = instrument.symbol !== 'SOXL' && instrument.leverage > 1 && rateAge > 7 * 86400000
      ? (await references.get('DFF', true)).data : rates.data;
    return { market: market.data, index: indexData, rates: rateData, fx: fx?.data, calendar: calendar?.data };
  }
  const store = createDataStore(join(directory, 'model'), {
    validateKey: key => { instrumentFor(key); }, validate: validateEstimate,
    fetch: async key => { const data = await inputs(key); return estimateHistory(data.market, data.index, data.rates, data.fx, data.calendar); },
    identity: (data, key) => data.symbol === key,
  });
  async function get(symbol: string, refresh = false) {
    const data = await inputs(symbol);
    const versions = { etf: data.market.version, index: data.index.version, rates: data.rates.version,
      ...(data.fx ? { fx: data.fx.version } : {}), ...(data.calendar ? { calendar: data.calendar.version } : {}) };
    const cached = await store.get(symbol, refresh);
    return JSON.stringify(cached.data.inputVersions) === JSON.stringify(versions) ? cached : store.get(symbol, true);
  }
  return { get };
}
