export function fetchAppData(
  endpoint: 'market' | 'fx' | 'estimate' | 'tax-basis' | 'reference',
  symbol: string | undefined,
  refresh: boolean,
  signal: AbortSignal,
): Promise<Response> {
  if (import.meta.env.MODE === 'pages') {
    const filename = encodeURIComponent(symbol ?? 'USD-KRW');
    return fetch(`${import.meta.env.BASE_URL}data/${endpoint}/${filename}.json`, {
      signal,
      cache: refresh ? 'reload' : 'default',
    });
  }

  const query = new URLSearchParams();
  if (symbol !== undefined) query.set(endpoint === 'reference' ? 'series' : 'symbol', symbol);
  if (refresh) query.set('refresh', '1');
  return fetch(`/api/${endpoint}${query.size ? `?${query}` : ''}`, { signal });
}
