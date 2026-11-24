const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const dates=[['2021-01-04',100],['2022-01-03',120],['2023-01-02',80],['2024-01-02',140],['2024-06-03',150],['2024-06-04',155],['2024-12-30',160],['2025-01-02',170],['2025-06-02',180],['2025-06-03',180],['2026-01-02',200]];
function marketFixture(symbol) {
  const domestic=symbol.endsWith('.KS');const scale=domestic?100:1;
  return {schema:1,symbol,currency:domestic?'KRW':'USD',timeZone:domestic?'Asia/Seoul':'America/New_York',source:'deterministic-phase2-browser-test',fetchedAt:'2026-01-03T00:00:00Z',priceBasis:'split-adjusted',version:`phase2-fixture-${symbol}`,warnings:['계좌·세금 UI 통합 테스트 전용 시세입니다.'],splits:[],distributions:[],bars:dates.map(([date,price])=>({date,open:price*scale,high:price*scale,low:price*scale,close:price*scale}))};
}
const observations=[];
for(let time=Date.parse('2020-12-01');time<=Date.parse('2030-12-31');time+=86400000)observations.push({date:new Date(time).toISOString().slice(0,10),rate:1000});
const fxFixture={schema:1,pair:'USD-KRW',unit:'KRW-per-USD',source:'deterministic-phase2-browser-test',sources:['https://www.federalreserve.gov/releases/h10/hist/dat00_ko.htm'],fetchedAt:'2026-01-03T00:00:00Z',version:'phase2-fx-fixture',warnings:['실제 환율이 아닌 결정적 브라우저 테스트 자료입니다.'],missingDates:[],observations};
function basisFixture(symbol) {
  return {symbol,version:`phase2-basis-${symbol}`,source:'https://www.tigeretf.com/ko/product/search/detail/index.do',fetchedAt:'2026-01-03T00:00:00Z',points:dates.map(([date,price])=>({date,value:price*100*.75})),warnings:['실제 과표기준가격이 아닌 결정적 브라우저 테스트 자료입니다.']};
}
async function run() {
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'backtest-phase2-test-'));
  const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let socket;const completed=[];
  try {
    const endpoint=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Chrome 시작 시간 초과')),15000);browser.once('error',reject);browser.stderr.on('data',chunk=>{output+=chunk;const found=output.match(/DevTools listening on (ws:\/\/\S+)/);if(found){clearTimeout(timer);resolve(found[1]);}});});
    const pages=await(await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let sequence=0;const pending=new Map();const errors=[];const requests={market:0,fx:0,basis:0};let failBasis=false;
    const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Fetch.requestPaused') {
        const url=new URL(message.params.request.url);const symbol=url.searchParams.get('symbol')??'TQQQ';
        let data,status=200;
        if(url.pathname==='/api/fx'){requests.fx++;data=fxFixture;}
        else if(url.pathname==='/api/tax-basis'){requests.basis++;data=basisFixture(symbol);if(failBasis)status=503;}
        else {requests.market++;data=marketFixture(symbol);}
        void command('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(status===503?{error:'과표 테스트 HTTP 503'}:{data,cache:'cached',stale:false})).toString('base64')});
      }
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);
      const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);message.error?entry.reject(Error(JSON.stringify(message.error))):entry.resolve(message.result);
    });
    const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;};
    const waitFor=async expression=>{const deadline=performance.now()+20000;while(performance.now()<deadline){if(await evaluate(`Boolean(${expression})`))return;await delay(50);}throw Error('조건 대기 시간 초과: '+expression+' '+JSON.stringify(await evaluate(`({status:document.querySelector('.calculation-status')?.textContent,account:document.querySelector('[name="backtest-account"]:checked')?.value,symbol:document.querySelector('[aria-label="종목"]')?.value,tax:window.__phaseLastReply?.result?.tax,run:window.__phaseRuns?.at(-1)})`)));};
    const pass=name=>{completed.push(name);console.log('PASS '+name);};
    const input=async(label,value)=>{await evaluate(`{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}`);};
    const select=async(label,value)=>{await evaluate(`{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));}`);};
    const clickText=async(text,scope='document')=>{await evaluate(`Array.from(${scope}.querySelectorAll('button')).find(e=>e.textContent===${JSON.stringify(text)}).click()`);};
    const replyNumber=()=>evaluate('window.__phaseReplies.length');
    const result=()=>evaluate('window.__phaseLastReply.result');
    const ready=()=>waitFor(`['available','estimated'].includes(window.__phaseLastReply?.result?.tax?.status) && !document.querySelector('.phase2-report')?.getAttribute('aria-busy')?.includes('true')`);
    async function newResult(before,condition='true') {await waitFor(`window.__phaseReplies.length>${before} && (${condition}) && document.querySelector('.calculation-status').textContent.includes('거래일')`);}
    async function symbol(value) {await select('종목',value);await waitFor(`document.querySelector('[aria-label="종목"]').value===${JSON.stringify(value)} && document.querySelector('.symbol-line strong')?.textContent===${JSON.stringify(value)}`);}
    await command('Page.enable');await command('Runtime.enable');
    await command('Page.addScriptToEvaluateOnNewDocument',{source:`window.__phaseRuns=[];window.__phaseReplies=[];const NativeWorker=window.Worker;window.Worker=class extends NativeWorker {postMessage(message){if(message.kind==='run')window.__phaseRuns.push(message);super.postMessage(message);}set onmessage(handler){super.onmessage=event=>{if(event.data.kind==='result'){window.__phaseLastReply=event.data;window.__phaseReplies.push(event.data);}handler.call(this,event);};}};`});
    await command('Fetch.enable',{patterns:[{urlPattern:'*/api/market*'},{urlPattern:'*/api/fx*'},{urlPattern:'*/api/tax-basis*'}]});
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url:process.env.APP_BASE_URL??'http://127.0.0.1:5173/'});
    await waitFor(`document.querySelector('.run') && !document.querySelector('.run').disabled && document.querySelector('[aria-label="매매차익 세금 반영"]')`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="종목"]').options.length`),12);
    assert(await evaluate(`document.querySelector('[aria-label="중개형 ISA · 일반형"]').disabled && document.querySelector('[aria-label="연금저축펀드"]').disabled`));
    assert.equal(await evaluate(`document.querySelector('[aria-label="환율 고려 원화 성과"]').checked`),false);
    await waitFor('window.__phaseReplies.length===0');
    await evaluate(`document.querySelector('.run').click()`);await ready();
    const initial=await result();assert.equal(initial.days.at(-1).total,20000);assert(requests.fx>0);
    assert.equal(initial.tax.scenario,'liquidate');assert(initial.tax.trades.some(trade=>trade.hypothetical));assert.equal(initial.tax.accrued,1650000);
    pass('12종목 선택·미국 ETF 절세계좌 제한·원화 표시를 꺼도 세금용 환율 조회');

    const originalTrades=JSON.stringify(initial.trades);let before=await replyNumber();const marketBefore=requests.market;
    await select('세금용 원가 방식','average');await newResult(before,`window.__phaseLastReply.result.tax.costMethod==='average'`);
    assert.equal(JSON.stringify((await result()).trades),originalTrades);assert.equal(await evaluate('window.__phaseLastReply.cached'),true);assert.equal(requests.market,marketBefore);
    before=await replyNumber();await clickText('보유 유지',`document.querySelector('[aria-label="일반계좌 종료 시나리오"]')`);
    await newResult(before,`window.__phaseLastReply.result.tax.scenario==='hold'`);await ready();
    assert.equal((await result()).tax.accrued,0);
    before=await replyNumber();await clickText('전량 매도 가정',`document.querySelector('[aria-label="일반계좌 종료 시나리오"]')`);
    await newResult(before,`window.__phaseLastReply.result.tax.scenario==='liquidate'`);await ready();
    const liquidated=await result();assert.equal(JSON.stringify(liquidated.trades),originalTrades);assert(liquidated.tax.trades.some(trade=>trade.hypothetical));assert.equal(liquidated.tax.accrued,1650000);
    pass('원가 방식·청산 시나리오만 변경 시 전략 거래 보존·캐시 재사용·연간 공제1회');

    before=await replyNumber();await evaluate(`document.querySelector('[aria-label="매매차익 세금 반영"]').click()`);await newResult(before,`window.__phaseLastReply.result.tax.status==='disabled'`);
    assert.equal(JSON.stringify((await result()).trades),originalTrades);
    assert(!await evaluate(`document.querySelector('.phase-summary').textContent.includes('1,650,000')`));
    before=await replyNumber();await evaluate(`document.querySelector('[aria-label="매매차익 세금 반영"]').click()`);await newResult(before,`window.__phaseLastReply.result.tax.status!=='disabled'`);await ready();
    pass('세금 반영 해제·재적용 시 이전 세액 숨김·전략 원장 불변');

    before=await replyNumber();await input('인출 요청일','2024-06-01');await input('중간 인출 요청 금액','1500');await clickText('일정 추가',`document.querySelector('.phase-withdraw-form')`);
    await newResult(before,`window.__phaseLastReply.result.accountReport.withdrawnGross===1500`);
    let current=await result();const withdrawal=current.accountReport.withdrawals.find(row=>row.source==='scheduled');
    assert.equal(withdrawal.processedDate,'2024-06-03');assert.equal(withdrawal.paidDate,'2024-06-04');assert.equal(withdrawal.soldQuantity,10);assert.equal(withdrawal.netPaid,1500);
    assert(current.trades.some(trade=>trade.reason.includes('중간 인출 재원 마련')));assert.equal(current.days.at(-1).total,18000);
    await waitFor(`document.querySelector('.phase2-withdraw-log tbody').textContent.includes('2024-06-04')`);
    before=await replyNumber();await evaluate(`document.querySelector('.phase2-withdrawals tbody tr button').click()`);await input('중간 인출 요청 금액','3000');await clickText('일정 수정',`document.querySelector('.phase-withdraw-form')`);await newResult(before,`window.__phaseLastReply.result.accountReport.withdrawnGross===3000`);assert.equal((await result()).days.at(-1).total,16000);
    before=await replyNumber();await evaluate(`document.querySelectorAll('.phase2-withdrawals tbody tr button')[1].click()`);await newResult(before,`window.__phaseLastReply.result.accountReport.withdrawnGross===0`);assert.equal((await result()).days.at(-1).total,20000);
    before=await replyNumber();await input('인출 요청일','2030-01-02');await input('중간 인출 요청 금액','500');await clickText('일정 추가',`document.querySelector('.phase-withdraw-form')`);await newResult(before,`window.__phaseLastReply.result.accountReport.withdrawals.some(row=>row.excluded)`);assert.equal((await result()).days.at(-1).total,20000);assert.match(await evaluate(`document.querySelector('.phase2-withdrawals tbody').textContent`),/선택 기간 밖/);
    await evaluate(`document.querySelectorAll('.phase2-withdrawals tbody tr button')[1].click()`);await waitFor(`!document.querySelector('.phase2-withdrawals tbody tr')`);
    pass('중간 인출 추가·수정·삭제·휴장 이월·결제 후 지급·재원매도·기간 밖 제외');

    await symbol('418660.KS');assert(!await evaluate(`document.querySelector('[aria-label="중개형 ISA · 일반형"]').disabled`));assert(await evaluate(`document.querySelector('[aria-label="연금저축펀드"]').disabled`));
    await symbol('360750.KS');assert(!await evaluate(`document.querySelector('[aria-label="연금저축펀드"]').disabled`));
    await evaluate(`document.querySelector('[aria-label="중개형 ISA · 일반형"]').click()`);await input('초기 투자금','30000000');before=await replyNumber();await evaluate(`document.querySelector('.run').click()`);await newResult(before,`window.__phaseLastReply.result.accountReport.kind==='isa'`);await ready();
    current=await result();assert.equal(current.accountReport.approved,20000000);assert.equal(current.accountReport.blocked,10000000);assert(current.tax.settlement);assert.equal(current.tax.settlement.minimumHoldingDate,'2024-01-04');
    assert.equal(current.tax.settlement.deduction,0);assert(current.tax.warnings.some(warning=>warning.includes('사용자')));
    assert.match(await evaluate(`document.querySelector('.phase-contribution-summary').textContent`),/20,000,000/);
    before=await replyNumber();await evaluate(`document.querySelector('[aria-label="연금저축펀드"]').click()`);await newResult(before,`window.__phaseLastReply.result.accountReport.kind==='pension'`);await ready();current=await result();assert.equal(current.accountReport.approved,18000000);assert.equal(current.accountReport.blocked,12000000);assert.equal(current.tax.settlement.principal,18000000);
    assert.match(await evaluate(`document.querySelector('.phase-settlement').textContent`),/전액 중도인출/);
    pass('추가 국내 ETF 계좌 허용·ISA2천만원/연금1천8백만원 부분 승인·차단·정산 타임라인');

    await symbol('133690.KS');assert(!await evaluate(`document.querySelector('[aria-label="연금저축펀드"]').disabled`));before=await replyNumber();await evaluate(`document.querySelector('.run').click()`);await newResult(before,`window.__phaseLastReply.result.accountReport.kind==='pension'`);await ready();
    await symbol('TQQQ');assert.equal(await evaluate(`document.querySelector('[name="backtest-account"]:checked').value`),'pension');assert(await evaluate(`document.querySelector('.run').disabled`));assert.match(await evaluate(`document.querySelector('.phase2-settings').textContent`),/다시 선택/);
    await evaluate(`document.querySelector('[aria-label="일반계좌"]').click()`);await waitFor(`!document.querySelector('.run').disabled`);
    pass('종목 변경 시 부적합 계좌 유지·실행 차단·사용자 계좌 재선택');

    await symbol('133690.KS');await evaluate(`document.querySelector('.run').click()`);await ready();
    failBasis=true;await clickText('과표기준가격 다시 조회');await waitFor(`document.querySelector('.phase2-report').textContent.includes('과표 테스트 HTTP 503')`);assert(!await evaluate(`document.querySelector('.phase2-report .phase-summary').textContent.includes('₩0')`));
    failBasis=false;await clickText('과표기준가격 다시 조회');await ready();
    current=await result();
    assert.equal(current.tax.curve.at(-1).accountValue,current.tax.accountValueKrw,'세금 곡선 마지막 계좌 자산은 요약 자산과 일치해야 합니다.');
    assert.equal(current.tax.accountValueKrw,current.days.at(-1).total,'KRW 결과는 환율을 중복 반영하지 않아야 합니다.');
    const curveQuote=await evaluate(`({date:document.querySelector('.phase-chart-quote strong')?.textContent,text:document.querySelector('.phase-chart-quote')?.textContent})`);
    const curveDay=current.tax.curve.find(day=>day.date===curveQuote.date);
    assert(curveDay,JSON.stringify(curveQuote));
    assert(curveQuote.text.includes(new Intl.NumberFormat('ko-KR',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(curveDay.accountValue)),JSON.stringify({curveQuote,curveDay}));
    pass('과표기준가격 실패 시 계산 불가 사유·세금0 오표시 방지·재조회 복구');

    await fs.mkdir('work',{recursive:true});
    for(const width of [1440,375]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width===375});
      for(const [name,selector]of[['settings','.phase2-settings'],['tax','.phase2-report'],['settlement','.phase-settlement'],['schedule','.phase2-withdrawals'],['withdraw-log','.phase2-withdraw-log']]) {
        await evaluate(`document.querySelector('${selector}').scrollIntoView({block:'start'})`);await delay(100);
        const layout=await evaluate('({scroll:document.documentElement.scrollWidth,width:innerWidth})');assert(layout.scroll<=layout.width,JSON.stringify({width,name,...layout}));
        const capture=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(`work/phase2-${width}-${name}.png`,Buffer.from(capture.data,'base64'));
      }
    }
    assert.equal(errors.length,0,JSON.stringify(errors));pass('1440/375px 계좌·세금·정산·일정 화면 overflow 및 브라우저 예외 없음');
    await fs.writeFile('work/phase2-browser-validation.json',JSON.stringify({at:new Date().toISOString(),completed,requests,errors,note:'실제 production Chrome·Web Worker, 결정적 시세·환율·과표 fixture. 실제 세금자료 정확성 검증을 대신하지 않음.'},null,2));
  }finally {
    if(socket?.readyState===WebSocket.OPEN){socket.send(JSON.stringify({id:999999,method:'Browser.close'}));socket.close();}
    await delay(100);if(browser.exitCode===null)browser.kill();
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
