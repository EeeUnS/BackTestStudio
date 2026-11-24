import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentFor, instruments } from '../src/data/market.ts';
import { createFxStore } from './fxCache.ts';
import { createEstimateStore } from './estimateCache.ts';
import { createReferenceStore } from './referenceCache.ts';
import { referenceIds } from '../src/data/reference.ts';
import { createTaxBasisStore } from './taxBasis.ts';
import { createMarketStore } from './cache.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = createMarketStore(resolve(root, 'cache'));
const fxStore = createFxStore(resolve(root, 'cache'));
const referenceStore = createReferenceStore(resolve(root, 'cache'));
const estimateStore = createEstimateStore(resolve(root, 'cache'));
const taxBasisStore = createTaxBasisStore(resolve(root,'cache'));
const production = process.argv.includes('--production');
const vite = production ? undefined : await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { throw new Error('PORT는 1024~65535 정수여야 합니다.'); }
async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.writeHead(405).end(JSON.stringify({ error: 'GET만 지원합니다.' })); return; }
    try {
      if (url.pathname === '/api/instruments') { res.end(JSON.stringify(instruments)); return; }
      if (url.pathname === '/api/fx') { res.end(JSON.stringify(await fxStore.get('USD-KRW', url.searchParams.get('refresh') === '1'))); return; }
      if(url.pathname==='/api/tax-basis') {const symbol=url.searchParams.get('symbol')??'';if(!instruments.some(item=>item.symbol===symbol&&item.currency==='KRW')){res.writeHead(400).end(JSON.stringify({error:'과표기준가격을 지원하지 않는 종목입니다.'}));return;}res.end(JSON.stringify(await taxBasisStore.get(symbol,url.searchParams.get('refresh')==='1')));return;}
      if (url.pathname === '/api/estimate') {
        const symbol = url.searchParams.get('symbol') ?? '';
        if (!instruments.some(item => item.symbol === symbol)) { res.writeHead(400).end(JSON.stringify({ error: '지원하지 않는 종목입니다.' })); return; }
        res.end(JSON.stringify(await estimateStore.get(symbol, url.searchParams.get('refresh') === '1'))); return;
      }
      if (url.pathname === '/api/reference') {
        const series = url.searchParams.get('series') ?? '';
        if (!referenceIds.some(id => id === series)) { res.writeHead(400).end(JSON.stringify({ error: '지원하지 않는 모델 참조 자료입니다.' })); return; }
        res.end(JSON.stringify(await referenceStore.get(series, url.searchParams.get('refresh') === '1', series === 'NDX' ? 24 * 60 * 60 * 1000 : undefined))); return;
      }
      if (url.pathname !== '/api/market') { res.writeHead(404).end(JSON.stringify({ error: 'API 경로가 없습니다.' })); return; }
      const symbol = url.searchParams.get('symbol') ?? '';
      if (!instruments.some(item => item.symbol === symbol)) { res.writeHead(400).end(JSON.stringify({ error: '지원하지 않는 종목입니다.' })); return; }
      instrumentFor(symbol);
      res.end(JSON.stringify(await store.get(symbol, url.searchParams.get('refresh') === '1')));
    } catch (error) {
      console.error('시세 요청 실패:', error);
      res.writeHead(502).end(JSON.stringify({ error: error instanceof Error ? error.message : '시세 처리 오류입니다.' }));
    }
    return;
  }
  if (vite) { vite.middlewares(req, res); return; }
  const dist = resolve(root, 'dist');
  const requested = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
  if (requested !== dist && !requested.startsWith(dist + sep)) { res.writeHead(403).end(); return; }
  const filename = extname(requested) ? requested : resolve(dist, 'index.html');
  const content = await readFile(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') { return undefined; }
    throw error;
  });
  if (!content) { res.writeHead(404).end('파일이 없습니다. npm run build를 먼저 실행하세요.'); return; }
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  res.setHeader('Content-Type', mime[extname(filename)] ?? 'application/octet-stream');
  res.end(content);
}
const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error: unknown) => {
    console.error('HTTP 요청 처리 실패:', error);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); }
    res.end('요청 처리 오류입니다.');
  });
});
server.listen(port, '127.0.0.1', () => { console.log(`BacktestStudio: http://127.0.0.1:${port}`); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(); void vite?.close(); });
}
