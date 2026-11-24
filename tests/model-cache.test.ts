import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createEstimateStore } from '../server/estimateCache.ts';
import type { MarketData } from '../src/data/market.ts';
import type { ReferenceData } from '../src/data/reference.ts';
test('모델 캐시는 입력 버전이 바뀌면 재생성하고 손상은 명시적 갱신으로만 복구', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backtest-model-cache-'));
  async function save(name: string, data: unknown) {
    const payload = JSON.stringify(data);
    await writeFile(join(directory, `${name}.json`), JSON.stringify({ payload, hash: createHash('sha256').update(payload).digest('hex') }), 'utf8');
  }
  try {
    const points = Array.from({ length: 1000 }, (_, index) => ({ date: new Date(Date.UTC(2010, 0, 1 + index)).toISOString().slice(0, 10), value: 100 }));
    const reference: ReferenceData = { schema: 1, id: 'NDX', unit: 'index-level', source: 'test', sourceUrl: 'https://example.com/ndx', fetchedAt: new Date().toISOString(), version: 'ndx-1', points, missingDates: [], warnings: [] };
    const market: MarketData = { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'test', fetchedAt: reference.fetchedAt, version: 'etf-1', priceBasis: 'split-adjusted', warnings: [], splits: [], distributions: [], bars: points.slice(200).map(point => ({ date: point.date, open: 100, high: 100, low: 100, close: 100 })) };
    await save('NDX', reference);
    await save('DFF', { ...reference, id: 'DFF', unit: 'annual-percent', version: 'dff-1', points: points.map(point => ({ ...point, value: 0 })) });
    await save('TQQQ', market);
    const store = createEstimateStore(directory);
    const first = await store.get('TQQQ');
    assert.equal(first.cache, 'fresh');
    const cached = await store.get('TQQQ');
    assert.equal(cached.cache, 'cached');
    assert.equal(cached.data.version, first.data.version);
    await save('TQQQ', { ...market, version: 'etf-2' });
    const updated = await store.get('TQQQ');
    assert.equal(updated.cache, 'fresh');
    assert.equal(updated.data.inputVersions.etf, 'etf-2');
    assert.notEqual(updated.data.version, first.data.version);
    await writeFile(join(directory, 'model', 'TQQQ.json'), JSON.stringify({ payload: 'invalid', hash: 'wrong' }), 'utf8');
    await assert.rejects(store.get('TQQQ'), /무결성/);
    assert.equal((await store.get('TQQQ', true)).data.inputVersions.etf, 'etf-2');
    await assert.rejects(store.get('../TQQQ'), /지원하지/);
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert(basename(target).startsWith('backtest-model-cache-'));
    await rm(target, { recursive: true, force: true });
  }
});
