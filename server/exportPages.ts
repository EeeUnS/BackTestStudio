import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { instruments } from '../src/data/market.ts';
import { referenceIds } from '../src/data/reference.ts';
import { createMarketStore } from './cache.ts';
import { createFxStore } from './fxCache.ts';
import { createReferenceStore } from './referenceCache.ts';
import { createEstimateStore, supportsEstimate } from './estimateCache.ts';
import { createTaxBasisStore } from './taxBasis.ts';
import { fetchMarketUpdate } from './marketUpdate.ts';

const [mode, cacheDirectory = 'cache', outputDirectory = 'dist/data'] = process.argv.slice(2);
if (mode !== 'refresh' && mode !== 'export') {
  throw new Error('Usage: node server/exportPages.ts <refresh|export> [cache] [output]');
}
const refresh = mode === 'refresh';
const cache = resolve(cacheDirectory);
const marketRead = createMarketStore(cache);
const markets = createMarketStore(cache, async symbol => fetchMarketUpdate(symbol, await marketRead.read(symbol)));
const fx = createFxStore(cache);
const references = createReferenceStore(cache);
const taxes = createTaxBasisStore(cache);
const estimates = createEstimateStore(cache);

async function load<T extends { fetchedAt: string }>(
  store: { read(key: string): Promise<T | undefined>; get(key: string, refresh: boolean): Promise<{ data: T }> },
  key: string,
) {
  const data = refresh ? (await store.get(key, true)).data : await store.read(key);
  if (!data) throw new Error(`Missing cached data for ${key}`);
  return data;
}

const files = new Map<string, { fetchedAt: string }>();
files.set('fx/USD-KRW', await load(fx, 'USD-KRW'));
for (const id of referenceIds) {
  const data = await load(references, id);
  if (id === 'NDX') files.set(`reference/${id}`, data);
}

for (const { symbol, currency } of instruments) {
  files.set(`market/${symbol}`, await load(markets, symbol));
  if (currency === 'KRW') {
    try {
      files.set(`tax-basis/${symbol}`, await load(taxes, symbol));
    } catch (error) {
      console.warn(`Skipping tax basis for ${symbol}:`, error);
    }
  }
  if (supportsEstimate(symbol)) files.set(`estimate/${symbol}`, (await estimates.get(symbol)).data);
}

for (const [name, data] of files) {
  const file = resolve(outputDirectory, `${name}.json`);
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify({ data, cache: 'cached', stale: false }));
}
console.log(`Exported ${files.size} static data files to ${outputDirectory}`);
