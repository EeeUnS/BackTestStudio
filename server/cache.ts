import { instrumentFor, validateMarket } from '../src/data/market.ts';
import { fetchMarket } from './provider.ts';
import { createDataStore } from './dataStore.ts';
export function createMarketStore(directory: string, provider = fetchMarket) {
  return createDataStore(directory, { validateKey: key => { instrumentFor(key); }, validate: validateMarket, fetch: provider, identity: (data, key) => data.symbol === key, maxAgeMs: 24 * 60 * 60 * 1000 });
}
