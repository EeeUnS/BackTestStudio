import type { CostMethod } from './types.ts';
export interface TaxLot { quantity: number; cost: number; basisCost?: number; acquired: string; settlementDate: string; rate: number; observationDate: string }
export interface LotDisposal { cost: number; basisCost?: number }
export function createTaxLots(method: CostMethod) {
  const lots: TaxLot[]=[];
  let first=0;
  function buy(lot: TaxLot) {
    if(!Number.isSafeInteger(lot.quantity)||lot.quantity<=0||!Number.isFinite(lot.cost)||lot.cost<0)throw new Error('세금 매입분 입력 오류입니다.');
    if(method==='average'&&lots[first]) {
      const item=lots[first];item.quantity+=lot.quantity;item.cost+=lot.cost;
      item.basisCost=item.basisCost===undefined||lot.basisCost===undefined?undefined:item.basisCost+lot.basisCost;
    }else lots.push({...lot});
  }
  function split(ratio: number) {
    if(!Number.isFinite(ratio)||ratio<=0)throw new Error('세금 원가 분할 오류입니다.');
    for(let i=first;i<lots.length;i++){const quantity=lots[i].quantity*ratio;if(!Number.isSafeInteger(quantity))throw new Error('세금 원가 원장에 단주 정산 자료가 없습니다.');lots[i].quantity=quantity;}
  }
  function sell(quantity: number):LotDisposal {
    if(!Number.isSafeInteger(quantity)||quantity<=0)throw new Error('세금 매도 수량 오류입니다.');
    if(lots.slice(first).reduce((sum,lot)=>sum+lot.quantity,0)<quantity)throw new Error('세금 원가 원장의 보유량보다 많이 매도했습니다.');
    let remaining=quantity,cost=0,basisCost:number|undefined=0;
    while(remaining>0){const lot=lots[first];const taken=Math.min(remaining,lot.quantity);const fraction=taken/lot.quantity;
      const removedCost=lot.cost*fraction;cost+=removedCost;
      if(lot.basisCost===undefined)basisCost=undefined;
      else {const removedBasis=lot.basisCost*fraction;if(basisCost!==undefined)basisCost+=removedBasis;lot.basisCost-=removedBasis;}
      lot.quantity-=taken;lot.cost-=removedCost;remaining-=taken;if(lot.quantity===0)first++;
    }
    return {cost,basisCost};
  }
  return {buy,sell,split,get quantity(){return lots.slice(first).reduce((sum,lot)=>sum+lot.quantity,0);},get cost(){return lots.slice(first).reduce((sum,lot)=>sum+lot.cost,0);},snapshot:()=>lots.slice(first).map(lot=>({...lot}))};
}
