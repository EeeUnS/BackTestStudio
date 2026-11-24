import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { record } from '../src/data/market.ts';
export interface CachedResponse<T> {
  data: T;
  cache: 'fresh' | 'cached';
  stale: boolean;
}
export function createDataStore<T extends {
  fetchedAt: string;
}>(directory: string, adapter: {
  validateKey: (key: string) => void;
  validate: (value: unknown) => T;
  fetch: (key: string) => Promise<T>;
  identity: (data: T, key: string) => boolean;
  maxAgeMs?: number;
}) {
  const pending = new Map<string, Promise<CachedResponse<T>>>();
  async function read(key: string): Promise<T | undefined> {
    adapter.validateKey(key);
    const content = await readFile(join(directory, `${key}.json`), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') {
      return undefined;
    } throw error; });
    if (content === undefined) {
      return undefined;
    }
    const envelope = record(JSON.parse(content));
    if (typeof envelope.payload !== 'string' || typeof envelope.hash !== 'string' || createHash('sha256').update(envelope.payload).digest('hex') !== envelope.hash) {
      throw new Error('캐시 무결성 오류입니다. 명시적으로 새로 조회하세요.');
    }
    const data = adapter.validate(JSON.parse(envelope.payload));
    if (!adapter.identity(data, key)) {
      throw new Error('캐시 데이터 식별자가 일치하지 않습니다.');
    }
    return data;
  }
  async function update(key: string): Promise<CachedResponse<T>> {
    const data = adapter.validate(await adapter.fetch(key));
    if (!adapter.identity(data, key)) {
      throw new Error('공급원 데이터 식별자가 일치하지 않습니다.');
    }
    await mkdir(directory, { recursive: true });
    const payload = JSON.stringify(data);
    const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ hash: createHash('sha256').update(payload).digest('hex'), payload }), 'utf8');
    await rename(temporary, join(directory, `${key}.json`));
    return { data, cache: 'fresh', stale: false };
  }
  async function get(key: string, refresh = false, maxAgeMs = adapter.maxAgeMs): Promise<CachedResponse<T>> {
    adapter.validateKey(key);
    let fallback: T | undefined;
    if (!refresh) {
      const cached = await read(key);
      if (cached) {
        const age = Date.now() - Date.parse(cached.fetchedAt);
        if (maxAgeMs === undefined || age < maxAgeMs) {
          return { data: cached, cache: 'cached', stale: age > 86400000 };
        }
        fallback = cached;
      }
    }
    let request = pending.get(key);
    if (!request) {
      request = update(key).finally(() => { pending.delete(key); });
      pending.set(key, request);
    }
    try {
      return await request;
    } catch (error) {
      if (fallback) { return { data: fallback, cache: 'cached', stale: true }; }
      throw error;
    }
  }
  return { get, read };
}
