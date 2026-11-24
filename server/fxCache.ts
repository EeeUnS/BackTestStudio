import { validateFx } from '../src/data/fx.ts';
import { createDataStore } from './dataStore.ts';
import { fetchFx } from './fx.ts';
export function createFxStore(directory: string, provider = fetchFx) {
  return createDataStore(directory, { validateKey: key => { if (key !== 'USD-KRW') {
      throw new Error('지원하지 않는 환율입니다.');
    } }, validate: validateFx, fetch: provider, identity: (data, key) => data.pair === key });
}
