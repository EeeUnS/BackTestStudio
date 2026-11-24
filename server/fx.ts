import { createHash } from 'node:crypto';
import { isDate } from '../src/data/market.ts';
import { validateFx } from '../src/data/fx.ts';
import type { FxData, FxObservation } from '../src/data/fx.ts';
export const fxSources = [
  { url: 'https://www.federalreserve.gov/releases/h10/hist/dat89_ko.htm', century: 1900 },
  { url: 'https://www.federalreserve.gov/releases/h10/hist/dat96_ko.htm', century: 1900 },
  { url: 'https://www.federalreserve.gov/releases/h10/hist/dat00_ko.htm', century: 2000 },
];
const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export function parseFedFx(html: string, century: number) {
  if (!/South Kore(?:an|a)/i.test(html) || ![1900, 2000].includes(century)) {
    throw new Error('연준 환율 표 식별 오류입니다.');
  }
  const observations: FxObservation[] = [];
  const missingDates: string[] = [];
  const seen = new Set<string>();
  let previous = '';
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cell[1].replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').trim());
    if (cells.length !== 2) {
      continue;
    }
    const match = cells[0].match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
    if (!match) {
      if (/rowheader\d+|id=["']r\d+/i.test(row[1])) {
        throw new Error('연준 환율 날짜 형식 오류입니다.');
      }
      continue;
    }
    const month = months.indexOf(match[2].toUpperCase()) + 1;
    const date = `${century + Number(match[3])}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    if (!isDate(date) || seen.has(date) || date <= previous) {
      throw new Error('연준 환율 날짜·중복·정렬 오류입니다.');
    }
    seen.add(date);
    previous = date;
    if (cells[1] === 'ND') {
      missingDates.push(date);
      continue;
    }
    if (!/^\d+(\.\d+)?$/.test(cells[1]) || (!Number.isFinite(Number(cells[1])) || Number(cells[1]) <= 0)) {
      throw new Error(`${date}: 연준 환율 숫자 오류입니다.`);
    }
    observations.push({ date, rate: Number(cells[1]) });
  }
  if (observations.length === 0) {
    throw new Error('연준 환율 표에서 관측값을 찾지 못했습니다.');
  }
  return { observations, missingDates };
}
export async function fetchFx(): Promise<FxData> {
  const parts = await Promise.all(fxSources.map(async (source) => {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      throw new Error(`환율 조회 HTTP ${response.status}. 기존 캐시는 유지합니다.`);
    }
    return parseFedFx(await response.text(), source.century);
  }));
  const observations = parts.flatMap(part => part.observations).sort((a, b) => a.date.localeCompare(b.date));
  const missingDates = parts.flatMap(part => part.missingDates).sort();
  const version = createHash('sha256').update(JSON.stringify({ observations, missingDates })).digest('hex');
  return validateFx({ schema: 1, pair: 'USD-KRW', unit: 'KRW-per-USD', source: 'Federal Reserve H.10', sources: fxSources.map(item => item.url),
    fetchedAt: new Date().toISOString(), version, observations, missingDates, warnings: [
      '연준 H.10 뉴욕 정오 관측 환율의 사후 환산입니다. 주간 발표·개정 가능 자료이며 당시 실시간 환전가나 발표시각을 재현하지 않습니다.',
      '거래일과 같은 날짜 또는 이전의 마지막 관측만 사용합니다. 휴장·ND·최신 발표 지연 구간은 사용 관측일과 경과 일수를 표시합니다.',
      '기본 USD 전략·주문·보유수량은 바꾸지 않으며 실제 환전 스프레드·수수료·세금은 반영하지 않습니다.',
    ] });
}
