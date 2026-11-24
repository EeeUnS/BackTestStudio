import { createHash } from 'node:crypto';
import type { MarketData } from '../src/data/market.ts';
import { validateMarket } from '../src/data/market.ts';
import { fetchMarket } from './provider.ts';

export async function fetchMarketUpdate(
  symbol: string,
  previous?: MarketData,
  provider = fetchMarket,
): Promise<MarketData> {
  if (!previous) return provider(symbol);
  const latestDate = previous.bars.at(-1)!.date;
  const start = new Date(`${latestDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 10);
  const since = start.toISOString().slice(0, 10);
  const recent = await provider(symbol, since);
  const oldSplits = previous.splits.filter(split => split.date >= since);
  if (JSON.stringify(oldSplits) !== JSON.stringify(recent.splits)) return provider(symbol);

  const bars = mergeByDate(previous.bars, recent.bars, bar => bar.date);
  const distributions = mergeByDate(previous.distributions, recent.distributions, item => item.exDate);
  const splits = previous.splits;
  const version = createHash('sha256').update(JSON.stringify({ symbol, bars, splits, distributions })).digest('hex');
  const warnings = [...new Set([...previous.warnings, ...recent.warnings])];
  return validateMarket({ ...recent, version, bars, splits, distributions, warnings });
}

function mergeByDate<T>(existing: T[], incoming: T[], dateOf: (value: T) => string): T[] {
  const merged = new Map(existing.map(value => [dateOf(value), value]));
  for (const value of incoming) merged.set(dateOf(value), value);
  return [...merged.values()].sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
}
