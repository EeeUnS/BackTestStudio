export interface Account {
  quantity: number;
  cost: number;
  cash: number;
  lockedCash: number;
  receivable: number;
  realized: number;
  dividendIncome: number;
  deposited: number;
  withdrawn: number;
}
export function createAccount(): Account {
  return { quantity: 0, cost: 0, cash: 0, lockedCash: 0, receivable: 0, realized: 0, dividendIncome: 0, deposited: 0, withdrawn: 0 };
}
const tolerance = 1e-8;
function nonnegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) { throw new Error(`${label}: 0 이상의 유한 숫자가 필요합니다.`); }
}
export function assertAccount(account: Account) {
  for (const [label, value] of Object.entries(account)) {
    if (!Number.isFinite(value)) { throw new Error(`계좌 불변식 오류: ${label}`); }
  }
  if (!Number.isSafeInteger(account.quantity) || account.quantity < 0 || account.cash < -tolerance
    || account.lockedCash < -tolerance || account.receivable < -tolerance || account.cost < -tolerance
    || (account.quantity === 0 && Math.abs(account.cost) > tolerance)) {
    throw new Error('계좌 불변식 오류: 정수주·비음수 자산·잔여 원가를 확인하세요.');
  }
}
export function settleSales(account: Account) {
  account.cash += account.lockedCash;
  account.lockedCash = 0;
}
export function deposit(account: Account, amount: number) {
  nonnegative(amount, '납입금');
  account.cash += amount;
  account.deposited += amount;
}
export function withdraw(account: Account, requested: number) {
  nonnegative(requested, '인출 요청');
  const amount = Math.min(requested, account.cash);
  account.cash -= amount;
  account.withdrawn += amount;
  return amount;
}
export function buy(account: Account, price: number, budget: number, maximumQuantity = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(price) || price <= 0) { throw new Error('매수가 오류입니다.'); }
  nonnegative(budget, '매수 예산');
  if (!Number.isSafeInteger(maximumQuantity) || maximumQuantity < 0) { throw new Error('매수 수량 한도 오류입니다.'); }
  const quantity = Math.min(Math.floor(Math.min(budget, account.cash) / price), maximumQuantity);
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(account.quantity + quantity)) {
    throw new Error('매수 수량이 안전한 정수 범위를 넘었습니다.');
  }
  const amount = quantity * price;
  account.quantity += quantity;
  account.cost += amount;
  account.cash -= amount;
  assertAccount(account);
  return { quantity, amount };
}
export function sell(account: Account, price: number, quantity: number) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > account.quantity) {
    throw new Error('매도 가격 또는 보유 수량 오류입니다.');
  }
  const removedCost = account.cost * quantity / account.quantity;
  const amount = quantity * price;
  const realized = amount - removedCost;
  account.quantity -= quantity;
  account.cost = account.quantity === 0 ? 0 : account.cost - removedCost;
  account.lockedCash += amount;
  account.realized += realized;
  assertAccount(account);
  return { quantity, amount, realized, removedCost };
}
export function applySplit(account: Account, ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) { throw new Error('분할 비율 오류입니다.'); }
  const quantity = account.quantity * ratio;
  if (!Number.isSafeInteger(quantity)) { throw new Error('단주 정산 자료가 없는 분할은 계산할 수 없습니다.'); }
  account.quantity = quantity;
  assertAccount(account);
}
export function accrueDividend(account: Account, perShare: number) {
  nonnegative(perShare, '주당 분배금');
  const amount = account.quantity * perShare;
  account.receivable += amount;
  account.dividendIncome += amount;
  return amount;
}
export function payDividend(account: Account, amount: number) {
  nonnegative(amount, '분배금 지급액');
  if (amount > account.receivable + tolerance) { throw new Error('미수분배금보다 큰 지급액입니다.'); }
  account.receivable = Math.max(0, account.receivable - amount);
  account.cash += amount;
}
export function valueAccount(account: Account, price: number) {
  if (!Number.isFinite(price) || price <= 0) { throw new Error('평가 가격 오류입니다.'); }
  const stock = account.quantity * price;
  const totalCash = account.cash + account.lockedCash;
  const total = stock + totalCash + account.receivable;
  return { stock, totalCash, total, averageCost: account.quantity > 0 ? account.cost / account.quantity : 0,
    unrealized: stock - account.cost, profit: total + account.withdrawn - account.deposited };
}
