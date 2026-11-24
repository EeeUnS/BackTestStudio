export const TAX_POLICY = {
  version: 'KR-resident-fixed-2026-11-15-isa-zero-v2', asOf: '2026-11-15',
  overseasDeduction: 2500000, overseasRate: 0.22, domesticRate: 0.154,
  // User-defined simulation override; this is not the statutory ISA exemption.
  isaDeduction: 0, isaRate: 0.099, isaAnnualLimit: 20000000, isaLifetimeLimit: 100000000, isaYears: 3,
  pensionAnnualLimit: 18000000, pensionWithdrawalRate: 0.165,
  usSettlementDays: 1, krSettlementDays: 2,
  sources: [
    'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=8800&mi=12274',
    'https://www.nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=2201&nttSn=1350890',
    'https://www.hanaw.com/hts/notice/__icsFiles/afieldfile/2015/05/06/a0.pdf',
    'https://regulation.krx.co.kr/contents/RGL/03/03060105/RGL03060105.jsp',
    'https://www.samsungfund.com/upload/kodex/newsroom/2026011317101936.pdf',
    'https://m.samsungfund.com/etf/pension/guide.do',
    'https://www.sec.gov/investment/settlement-cycle-small-entity-compliance-guide-15c6-1-15c6-2-204-2',
    'https://regulation.krx.co.kr/contents/RGL/03/03060101/RGL03060101.jsp',
  ],
} as const;
export const TAX_SCOPE_NOTICE = '매매차익 과세 반영 · 분배금 과세 미반영 · 현재 규칙 고정 시뮬레이션';
