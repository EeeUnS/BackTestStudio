const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fixture = { schema: 1, symbol: 'TQQQ', currency: 'USD', timeZone: 'America/New_York', source: 'deterministic-browser-test', fetchedAt: '2026-01-03T00:00:00Z', priceBasis: 'split-adjusted', version: 'browser-fixture-v1', warnings: ['통합 테스트 전용 시세이며 실제 투자 자료가 아닙니다.'], splits: [], distributions: [{ exDate: '2023-01-02', amount: 1 }],
  bars: [['2021-01-04',100],['2022-01-03',120],['2023-01-02',80],['2024-01-02',140],['2025-01-02',160],['2026-01-02',200]].map(([date,price])=>({date,open:price,high:price,low:price,close:price})) };
const fxFixture = { schema:1,pair:'USD-KRW',unit:'KRW-per-USD',source:'결정적 환율 테스트',sources:['https://www.federalreserve.gov/releases/h10/hist/dat00_ko.htm'],fetchedAt:'2026-01-03T00:00:00Z',version:'fx-browser-fixture',warnings:['브라우저 테스트 전용 환율입니다.'],missingDates:[],observations:[{date:'2021-01-04',rate:1000},{date:'2023-01-02',rate:1000},{date:'2024-01-02',rate:1100},{date:'2025-01-02',rate:1200},{date:'2026-01-02',rate:1300}] };
const estimateFixture = { schema:1,symbol:'TQQQ',currency:'USD',priceBasis:'split-adjusted',model:'daily-leverage-financing-log-residual-v1',version:'estimate-browser-1',fetchedAt:'2026-01-03T00:00:00Z',points:[{date:'2019-01-02',close:50},{date:'2020-01-02',close:60}],anchor:{date:'2021-01-04',close:100},calibration:{start:'2021-01-04',end:'2023-01-02',observations:252,annualResidual:.01,financingLeverage:2,financingDayBasis:360,residualDayBasis:365},validation:{start:'2024-01-02',end:'2026-01-02',observations:252,dailyRmse:.001,dailyBias:0,annualTrackingError:.01,terminalRelativeError:.02,maxRelativeError:.03},inputVersions:{etf:fixture.version,index:'index-fixture',rates:'rates-fixture'},sources:['https://example.com/model'],warnings:['추정 브라우저 검증 전용 모델입니다.'] };
async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'backtest-app-test-'));
  const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
  let socket;
  try {
    const endpoint = await new Promise((resolve,reject)=>{
      let output=''; const timer=setTimeout(()=>reject(new Error('Chrome 시작 시간 초과')),10000);
      browser.once('error',reject);
      browser.stderr.on('data',bytes=>{ output+=bytes; const found=output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if(found){clearTimeout(timer);resolve(found[1]);} });
    });
    const pages=await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
    const page=pages.find(item=>item.type==='page'); assert(page);
    socket=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let sequence=0; const pending=new Map(); const errors=[]; let requests=0; let fxRequests=0; let failFx=false; let estimateRequests=0; let failEstimate=false;
    const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Fetch.requestPaused') {
        const url=new URL(message.params.request.url);const isFx=url.pathname==='/api/fx';const isEstimate=url.pathname==='/api/estimate';
        if(isFx){fxRequests++;}else if(isEstimate){estimateRequests++;}else{requests++;}
        const native=url.searchParams.get('symbol')==='418660.KS';
        const data=isEstimate?estimateFixture:isFx?fxFixture:native?{...fixture,symbol:'418660.KS',currency:'KRW',timeZone:'Asia/Seoul'}:fixture;
        const failed=(isFx&&failFx)||(isEstimate&&failEstimate);
        void command('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:failed?503:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(failed?{error:isEstimate?'추정 모델 테스트 HTTP 503':'환율 테스트 HTTP 503'}:{data,cache:'cached',stale:false})).toString('base64')});
      }
      if(message.method==='Runtime.exceptionThrown'){errors.push(message.params.exceptionDetails);}
      const entry=pending.get(message.id);if(!entry){return;}pending.delete(message.id);
      if(message.error){entry.reject(new Error(JSON.stringify(message.error)));}else{entry.resolve(message.result);}
    });
    const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;};
    const waitFor=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression)){return;}await delay(50);}throw new Error('조건 대기 시간 초과: '+expression+' '+JSON.stringify(await evaluate("({status:document.querySelector('.calculation-status')?.textContent,input:document.querySelector('input[aria-label=\"회당 납입금\"]')?.value,delay:window.__delayNextReply,scheduled:window.__delayedReplyScheduled,worker:String(window.Worker).slice(0,100)})")));};
    await command('Page.enable');
    await command('Page.addScriptToEvaluateOnNewDocument',{source:`
      new MutationObserver(() => {
        if (!window.__firstMetricsAt && document.querySelector('.metric strong')?.textContent !== '—' && document.querySelector('.metric strong')) { window.__firstMetricsAt = performance.now(); }
        if (!window.__firstTradesAt && document.querySelector('.trades tbody tr')) { window.__firstTradesAt = performance.now(); }
      }).observe(document, {childList:true,subtree:true,characterData:true});
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          const code = 'import ' + JSON.stringify(String(url)) + '; const handle=self.onmessage; self.onmessage=e=>{if(e.data.kind==="test-block"){self.postMessage({kind:"test-busy"});const end=performance.now()+10000;while(performance.now()<end){};return;}handle(e);};';
          super(URL.createObjectURL(new Blob([code], {type:'text/javascript'})), options);
        }
        postMessage(message) {
          if (message.kind === 'run' && window.__blockNextRun) {
            window.__blockNextRun = false;
            super.postMessage({kind:'test-block'});
          }
          super.postMessage(message);
        }
        terminate() { window.__terminatedWorkers = (window.__terminatedWorkers || 0) + 1; super.terminate(); }
        set onmessage(handler) {
          super.onmessage = event => {
            if(event.data.kind==='test-busy'){window.__workerBusy=true;return;}
            const delayed = event.data.kind === 'result' && window.__delayNextReply;
            if (delayed) { window.__delayNextReply = false; window.__delayedReplyScheduled = true; }
            setTimeout(() => handler.call(this, event), delayed ? 600 : 0);
          };
        }
      };
    `});
    await command('Runtime.enable');
    await command('Fetch.enable',{patterns:[{urlPattern:'*/api/market*'},{urlPattern:'*/api/fx*'},{urlPattern:'*/api/estimate*'}]});
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url:'http://127.0.0.1:5173/'});
    await waitFor("document.querySelector('.run') && !document.querySelector('.run').disabled");
    await evaluate("document.querySelector('.run').click()");
    await waitFor("document.querySelector('.calculation-status').textContent.includes('6 거래일')");
    assert.equal(await evaluate("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')"),'20000.00');
    await waitFor("document.querySelectorAll('.trades tbody tr').length===1");
    assert(await evaluate('window.__firstMetricsAt < window.__firstTradesAt'), '핵심 수치는 상세 거래 행보다 먼저 갱신되어야 합니다.');
    assert.match(await evaluate("document.querySelector('.holding-comparison').textContent"), /동일 입출금/);
    assert.equal(await evaluate("document.querySelector('.comparison-body strong').textContent.replace(/[^0-9.]/g,'')"),'20000.00');
    console.log('PASS 최초 5년 실행·실제 Worker·계좌/성과/거래 연결');
    assert.equal(await evaluate("document.querySelector('[data-testid=\"max-cost-loss\"]').textContent"),'-20.00%');
    assert.match(await evaluate("document.querySelector('.cost-loss-detail').textContent"), /2023-01-02/);
    await evaluate("document.querySelector('.loss-date').click()");
    await waitFor("document.querySelector('[aria-label=\"계좌 조회일\"]').value==='2023-01-02'");
    assert(await evaluate("Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='고정 해제')"));
    await fs.mkdir('work',{recursive:true});
    for (const width of [1440,375]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===375});
      await evaluate("document.querySelector('.cost-loss-summary').scrollIntoView({block:'center'})");
      await delay(100);
      const layout=await evaluate('({scroll:document.documentElement.scrollWidth,width:innerWidth})');
      assert(layout.scroll<=layout.width,JSON.stringify(layout));
      const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await fs.writeFile(`work/app-${width}-cost-loss.png`,Buffer.from(shot.data,'base64'));
    }
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='고정 해제').click()");
    console.log('PASS 평단 대비 최대 평가손실 -20%·발생일 계좌 조회·날짜 고정');
    const setInput=(label,value)=>`(()=>{const e=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'${value}');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`;
    const handlePositions = () => evaluate(`Array.from(document.querySelectorAll('.price-range-handle'), element => Number.parseFloat(element.style.left))`);
    const originalHandles = await handlePositions();
    const lossHeight = await evaluate(`document.querySelector('.cost-loss-summary').getBoundingClientRect().height`);
    const lossValue = await evaluate(`document.querySelector('[data-testid="max-cost-loss"]').textContent`);
    const stableLayout = await evaluate(`Array.from(document.querySelectorAll('.performance-details:not(.krw-details), .price-panel, .trade-history, .phase2-report, .holding-comparison'), element => ({height:element.getBoundingClientRect().height, top:element.getBoundingClientRect().top+scrollY}))`);
    await evaluate('window.__delayNextReply=true;window.__delayedReplyScheduled=false;');
    const initialStart=await evaluate(`document.querySelector('[aria-label="시작일"]').value`);
    await evaluate(`document.querySelector('[aria-label="상세 차트 시작 핸들"]').focus()`);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'});
    await waitFor(`document.querySelector('[aria-label="시작일"]').value==='2022-01-03'`);
    await waitFor(`document.querySelector('.cost-loss-summary')?.getAttribute('aria-busy')==='true'`);
    assert.equal(await evaluate(`document.querySelector('[data-testid="max-cost-loss"]').textContent`),lossValue);
    assert.equal(await evaluate(`document.querySelector('.cost-loss-summary').getBoundingClientRect().height`),lossHeight);
    assert.equal(await evaluate(`document.querySelector('.loss-date').disabled`),true);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.performance-details:not(.krw-details), .price-panel, .trade-history, .phase2-report, .holding-comparison'), element => ({height:element.getBoundingClientRect().height, top:element.getBoundingClientRect().top+scrollY}))`),stableLayout);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.metric strong')).visibility`),'hidden');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.metric strong'),'::after').content`), '"—"');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.performance-details span'),'::after').content`), '"—"');
    await delay(250);
    const movedHandles = await handlePositions();
    assert(movedHandles[0] > originalHandles[0] + 10, 'Start handle must move within the viewport');
    assert(Math.abs(movedHandles[1] - originalHandles[1]) < 1, 'End handle must retain its chart position');
    await evaluate(setInput('시작일',initialStart));
    await waitFor(`document.querySelector('.calculation-status').textContent.includes('${initialStart} ~')`);
    await evaluate(`document.querySelector('.price-range-chart').scrollIntoView({block:'center'})`);
    const detailDrag=await evaluate(`(()=>{const a=document.querySelector('[aria-label="상세 차트 시작 핸들"]').getBoundingClientRect();const b=document.querySelector('[aria-label="상세 차트 종료 핸들"]').getBoundingClientRect();return {x:a.x+a.width/2,y:a.y+a.height/2,target:a.x+a.width/2+(b.x-a.x)*0.4};})()`);
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:detailDrag.x,y:detailDrag.y});
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:detailDrag.x,y:detailDrag.y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:detailDrag.target,y:detailDrag.y,buttons:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:detailDrag.target,y:detailDrag.y,button:'left',clickCount:1});
    await waitFor(`document.querySelector('[aria-label="시작일"]').value!=='${initialStart}'`);
    await delay(250);
    const draggedHandles = await handlePositions();
    assert(draggedHandles[0] > originalHandles[0] + 10, 'Released handle must retain its new position');
    assert(Math.abs(draggedHandles[1] - originalHandles[1]) < 1, 'Drag must preserve the viewport');
    await evaluate(setInput('시작일',initialStart));
    await waitFor(`document.querySelector('.calculation-status').textContent.includes('${initialStart} ~')`);
    assert.equal(requests,1);
    console.log('PASS 상세 가격 차트 기간 핸들 키보드·드래그·재계산·시세 조회 유지');
    await evaluate(setInput('계좌 조회일','2024-01-02'));
    await waitFor(`document.querySelector('.price-chart').dataset.inspectDate==='2024-01-02' && document.querySelector('.asset-chart').dataset.inspectDate==='2024-01-02'`);
    assert.match(await evaluate(`document.querySelector('.chart-quote').textContent`), /2024-01-02/);
    await evaluate(`document.querySelector('.asset-chart').scrollIntoView({block:'center'})`);
    const assetPoint=await evaluate(`(()=>{const r=document.querySelector('.asset-chart').getBoundingClientRect();return {x:r.x+35,y:r.y+80};})()`);
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',...assetPoint});
    await waitFor(`document.querySelector('[aria-label="계좌 조회일"]').value !== '2024-01-02'`);
    assert.equal(await evaluate(`document.querySelector('.price-chart').dataset.inspectDate`),await evaluate(`document.querySelector('[aria-label="계좌 조회일"]').value`));
    await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='날짜 고정').click()`);
    const pinnedDate=await evaluate(`document.querySelector('[aria-label="계좌 조회일"]').value`);
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:assetPoint.x+150,y:assetPoint.y});
    assert.equal(await evaluate(`document.querySelector('[aria-label="계좌 조회일"]').value`),pinnedDate);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='고정 해제').click()`);
    console.log('PASS 조회일 입력·자산 포인터의 가격/계좌 동기화·날짜 고정');
    await evaluate(setInput('시작일','2023-01-02'));
    await waitFor("document.querySelector('.calculation-status').textContent.includes('2023-01-02 ~')");
    assert.equal(await evaluate("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')"),'25000.00');
    assert.equal(requests,1,'기간 변경에서 시세를 다시 조회하면 안 됩니다.');
    console.log('PASS 시작일 변경은 계좌 재시작·시세 재조회 없음');
    await evaluate("const e=document.querySelector('[aria-label=\"전략 선택\"]');e.value='dca';e.dispatchEvent(new Event('change',{bubbles:true}));");
    await waitFor("document.querySelector('.trades tbody')?.children.length===4");
    assert.equal(await evaluate("document.querySelector('[aria-label=\"초기 투자금\"]').disabled"),true);
    assert(await evaluate("document.querySelector('.performance-details').textContent.includes('추가 입출금')"));
    console.log('PASS 적립식 최초금 비활성·실제 거래·CAGR 적용 조건');
    const terminationsBefore=await evaluate('window.__terminatedWorkers || 0');
    await evaluate('window.__delayNextReply=true;window.__delayedReplyScheduled=false;');
    await evaluate(`document.querySelector('[aria-label="회당 납입금"]').focus();document.querySelector('[aria-label="회당 납입금"]').select();`);
    await command('Input.insertText',{text:'100'});
    await waitFor('window.__delayedReplyScheduled===true');
    await evaluate(`document.querySelector('[aria-label="회당 납입금"]').focus();document.querySelector('[aria-label="회당 납입금"]').select();`);
    await command('Input.insertText',{text:'200'});
    await waitFor("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')==='1140.00' && document.querySelector('#workspace').dataset.calculating==='false'");
    await delay(750);
    assert.equal(await evaluate("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')"),'1140.00');
    await waitFor("document.querySelector('.trade-history').getAttribute('aria-busy')==='false' && document.querySelectorAll('.trades tbody tr').length===4");
    assert.equal(await evaluate("document.querySelector('.trades tbody tr td:nth-child(5)').textContent.replace(/[^0-9.]/g,'')"),'160.00','지연된 이전 요청의 거래 행이 최신 납입200 결과를 덮으면 안 됩니다.');
    assert((await evaluate('window.__terminatedWorkers || 0'))>terminationsBefore,'실행 중 이전 Worker가 종료되어야 합니다.');
    console.log('PASS 실행 중 Worker 종료·교체 및 지연된 이전 응답 무시');
    await evaluate('window.__blockNextRun=true;window.__workerBusy=false;');
    await evaluate(`document.querySelector('[aria-label="회당 납입금"]').focus();document.querySelector('[aria-label="회당 납입금"]').select();`);
    await command('Input.insertText',{text:'300'});
    await waitFor('window.__workerBusy===true');
    const busyStart=Date.now();
    await evaluate(`document.querySelector('[aria-label="회당 납입금"]').focus();document.querySelector('[aria-label="회당 납입금"]').select();`);
    await command('Input.insertText',{text:'200'});
    await waitFor("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')==='1140.00' && document.querySelector('#workspace').dataset.calculating==='false'");
    assert(Date.now()-busyStart<5000,'이전 10초 동기 작업을 기다리지 않아야 합니다.');
    console.log('PASS 실제 10초 동기 작업 중인 Worker를 종료하고 최신 요청 완료');

    const previous=await evaluate("document.querySelector('.calculation-status').textContent.split(' · ')[0]");
    await evaluate("document.querySelectorAll('.price-chart canvas')[0].dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}));");
    await delay(150);
    assert.equal(await evaluate("document.querySelector('.calculation-status').textContent.split(' · ')[0]"),previous);
    console.log('PASS 차트 확대와 계산 기간 분리');
    const metricsBefore=await evaluate("document.querySelector('.metrics').textContent");
    await evaluate(`document.querySelector('.asset-display button:nth-child(2)').click()`);
    await waitFor(`document.querySelector('[aria-label="주식·현금 비중 곡선"]') !== null`);
    assert.match(await evaluate(`document.querySelector('.asset-composition').textContent`), /주식 .*% · 현금\(잠금 포함\) .*%/);
    assert.equal(await evaluate("document.querySelector('.metrics').textContent"),metricsBefore);
    await evaluate(`document.querySelector('.asset-display button').click()`);
    await waitFor(`document.querySelector('[aria-label="총자산·주식·현금 곡선"]') !== null`);
    assert.equal(requests,1);
    console.log('PASS 금액/비중 전환·선택 날짜 구성 수치·성과 유지·시세 재조회 없음');

    for (const label of ['주봉','월봉','일봉']) {
      await evaluate(`Array.from(document.querySelectorAll('.timeframe-buttons button')).find(button=>button.textContent==='${label}').click()`);
      await waitFor(`Array.from(document.querySelectorAll('.timeframe-buttons button')).some(button=>button.textContent==='${label}'&&button.getAttribute('aria-pressed')==='true')`);
      assert.equal(await evaluate("document.querySelector('.metrics').textContent"),metricsBefore);
    }
    await evaluate("document.querySelector('.moving-average-settings').open=true");
    await evaluate(`{ const input=document.querySelector('[aria-label="이평선 1 기간"]');input.focus();input.select(); }`);
    await command('Input.insertText',{text:'2'});
    assert.equal(await evaluate(`document.querySelector('[aria-label="이평선 1 기간"]').value`),'2');
    await evaluate(`{ const select=document.querySelector('[aria-label="봉별 거래 상세"]');select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true})); }`);
    await waitFor("document.querySelectorAll('.candle-trades li').length>0");
    assert.equal(await evaluate("document.querySelector('.metrics').textContent"),metricsBefore);
    console.log('PASS 일/주/월 전환·이평선 설정·봉별 거래 상세는 계산 결과 유지');
    await evaluate(`document.querySelector('[aria-label="이력 시작 핸들"]').focus()`);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'});
    await waitFor(`document.querySelector('[aria-label="시작일"]').value==='2024-01-02'`);
    await waitFor("document.querySelector('.calculation-status').textContent.includes('2024-01-02 ~')");
    const bounds=await evaluate(`(()=>{const b=document.querySelector('.history-navigator').getBoundingClientRect();const h=document.querySelector('[aria-label="이력 시작 핸들"]').getBoundingClientRect();return {x:h.x+h.width/2,y:h.y+h.height/2,target:b.x+b.width*2/5};})()`);
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:bounds.x,y:bounds.y});
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:bounds.x,y:bounds.y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:bounds.target,y:bounds.y,buttons:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:bounds.target,y:bounds.y,button:'left',clickCount:1});
    await waitFor(`document.querySelector('[aria-label="시작일"]').value==='2023-01-02'`);
    await waitFor("document.querySelector('.calculation-status').textContent.includes('2023-01-02 ~')");
    assert.equal(requests,1);
    console.log('PASS 전체 이력 핸들 키보드·포인터 드래그는 기간 재계산·시세 재조회 없음');
    await evaluate(`{ const select=document.querySelector('[aria-label="전략 선택"]');select.value='infinite';select.dispatchEvent(new Event('change',{bubbles:true})); }`);
    await waitFor("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')==='10480.00'");
    assert(await evaluate("document.querySelector('.account').textContent.includes('V3 진행 T')"));
    assert(await evaluate("Array.from(document.querySelectorAll('.notice')).some(item=>item.textContent.includes('V3.0 원문 규칙 대조'))"));
    await evaluate(`{ const select=document.querySelector('[aria-label="거래 유형"]');select.value='SELL';select.dispatchEvent(new Event('change',{bubbles:true})); }`);
    // 6 shares: 5 target + 1 quarter; next cycle's 3 shares: all target,
    // because a rounded-down quarter of 3 is zero. Three SELL rows in total.
    await waitFor("document.querySelectorAll('.trades tbody tr').length===3");
    await evaluate(`{ const input=document.querySelector('[aria-label="V3 분할 수"]');input.focus();input.select(); }`);
    await command('Input.insertText',{text:'10'});
    await waitFor("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')==='10960.00'");
    assert.equal(requests,1);
    console.log('PASS V3 실제 주문·SELL 필터·분할 설정 재계산·전략 상태와 원문/체결 가정 안내');
    assert.match(await evaluate(`document.querySelector('.profit-legend').textContent`), /평단 대비 수익.*평단 대비 손실/);
    assert(await evaluate(`Boolean(document.querySelector('.chart-workspace .moving-average-settings'))`));
    await evaluate(`document.querySelector('.moving-average-settings summary').click()`);
    assert.equal(await evaluate(`document.querySelector('.moving-average-settings').open`),true);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
    assert.equal(await evaluate(`document.querySelector('.moving-average-settings').open`),false);
    assert.equal(await evaluate(`document.activeElement.tagName`),'SUMMARY');
    for (const width of [1440,375]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===375});
      await evaluate(`document.querySelector('.chart-workspace').scrollIntoView({block:'center'})`);
      await delay(100);
      assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
      const chartShot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await fs.writeFile(`work/app-chart-zones-${width}.png`,Buffer.from(chartShot.data,'base64'));
    }
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
    await evaluate(setInput('계좌 조회일','2026-01-02'));
    const profitMetrics=await evaluate(`document.querySelector('.metrics').textContent`);
    await evaluate(`document.querySelector('[aria-label="평균원가 손익 구간 표시"]').click()`);
    assert.equal(await evaluate(`document.querySelector('.profit-legend').textContent.includes('미실현 평가손익')`),false);
    await evaluate(`document.querySelector('[aria-label="평균원가 손익 구간 표시"]').click()`);
    assert.match(await evaluate(`document.querySelector('.profit-legend').textContent`), /미실현 평가손익/);
    assert.equal(await evaluate(`document.querySelector('.metrics').textContent`),profitMetrics);
    await evaluate(`document.querySelector('.price-panel .checkbox-row input').click()`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="평균원가 손익 구간 표시"]').disabled`),false);
    assert.match(await evaluate(`document.querySelector('.profit-legend').textContent`), /평단 대비 수익/);
    await evaluate(`document.querySelector('.price-panel .checkbox-row input').click()`);
    assert.equal(requests,1);
    console.log('PASS 평균원가 손익 구간 토글·미실현 평가 분리·계산 결과 유지');

    await evaluate(`{ const select=document.querySelector('[aria-label="전략 선택"]');select.value='vr';select.dispatchEvent(new Event('change',{bubbles:true})); }`);
    await waitFor("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')==='20920.00'");
    assert(await evaluate("document.querySelector('.account').textContent.includes('VR 목표 V')"));
    await evaluate(`document.querySelector('[aria-label="VR 실력공식 사용"]').click()`);
    await waitFor("document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')==='21000.00'");
    assert(await evaluate("document.querySelector('.account').textContent.includes('실력공식')"));
    await evaluate(`{ const select=document.querySelector('[aria-label="VR 운용 유형"]');select.value='accumulate';select.dispatchEvent(new Event('change',{bubbles:true})); }`);
    await waitFor(`Number(Array.from(document.querySelectorAll('.account p')).find(row=>row.querySelector('span')?.textContent==='누적 납입금')?.querySelector('strong').textContent.replace(/[^0-9.]/g,''))>10000`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="VR 입출금액"]').value`),'250');
    assert.equal(await evaluate(`document.querySelector('[aria-label="VR Pool 한도"]').value`),'75');
    await evaluate(`{ const select=document.querySelector('[aria-label="VR 운용 유형"]');select.value='withdraw';select.dispatchEvent(new Event('change',{bubbles:true})); }`);
    await waitFor(`Number(Array.from(document.querySelectorAll('.account p')).find(row=>row.querySelector('span')?.textContent==='누적 인출금')?.querySelector('strong').textContent.replace(/[^0-9.]/g,''))>0`);
    assert(await evaluate(`Number(Array.from(document.querySelectorAll('.account p')).find(row=>row.querySelector('span')?.textContent==='VR 누적 미지급 인출')?.querySelector('strong').textContent.replace(/[^0-9.]/g,''))>0`));
    assert.equal(await evaluate(`document.querySelector('[aria-label="VR G 값"]').value`),'20');
    assert.equal(requests,1);
    console.log('PASS VR 기본/실력 전환·거치/적립/인출·Pool 기본값·실제/미지급 인출 연결');
    const usdBefore=await evaluate("document.querySelector('.metric strong').textContent");
    await evaluate(`document.querySelector('[aria-label="환율 고려 원화 성과"]').click()`);
    await waitFor("document.querySelector('.krw-metrics .metric strong')?.textContent.replace(/[^0-9.]/g,'')==='5850000'");
    assert.equal(await evaluate("document.querySelector('.metric strong').textContent"),usdBefore);
    assert(await evaluate("document.querySelector('.krw-account').textContent.includes('관측일 2026-01-02')"));
    await evaluate(`document.querySelector('[aria-label="환율 고려 원화 성과"]').click()`);
    await waitFor("!document.querySelector('.krw-report')");
    await evaluate(`document.querySelector('[aria-label="환율 고려 원화 성과"]').click()`);
    await waitFor("document.querySelector('.krw-metrics .metric strong')?.textContent.replace(/[^0-9.]/g,'')==='5850000'");
    assert.equal(fxRequests,1);
    await waitFor(`document.querySelector('#workspace').dataset.calculating==='false' && !Array.from(document.querySelectorAll('.krw-report button')).find(button=>button.textContent==='환율 새로 조회').disabled`);
    failFx=true;
    await evaluate("Array.from(document.querySelectorAll('.krw-report button')).find(button=>button.textContent==='환율 새로 조회').click()");
    await waitFor("document.querySelector('.krw-report [role=alert]')?.textContent.includes('503')");
    assert.equal(await evaluate("document.querySelector('.metric strong').textContent"),usdBefore);
    await waitFor(`!Array.from(document.querySelectorAll('.krw-report button')).find(button=>button.textContent==='환율 새로 조회').disabled`);
    failFx=false;
    await evaluate("Array.from(document.querySelectorAll('.krw-report button')).find(button=>button.textContent==='환율 새로 조회').click()");
    await waitFor("document.querySelector('.krw-metrics .metric strong')?.textContent.replace(/[^0-9.]/g,'')==='5850000' && !document.querySelector('.krw-report [role=alert]') && !Array.from(document.querySelectorAll('.krw-report button')).find(button=>button.textContent==='환율 새로 조회').disabled");
    assert.equal(fxRequests,3);assert.equal(requests,1);
    console.log('PASS 날짜별 원화 보고·USD 원장 유지·환율 조회 재사용·조회 실패/재시도');
    await fs.mkdir('work',{recursive:true});
    for(const width of [1440,375]){
      await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===375});await delay(200);
      const layout=await evaluate('({scroll:document.documentElement.scrollWidth,width:innerWidth})');
      assert(layout.scroll<=layout.width,JSON.stringify(layout));
      const capture=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await fs.writeFile(`work/app-${width}.png`,Buffer.from(capture.data,'base64'));
    }
    await evaluate(`document.querySelector('.asset-display button:nth-child(2)').click()`);
    for (const width of [1440,375]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===375});
      for (const [name,selector] of [['results','.heading'],['account','.account'],['chart','.chart-options'],['history','.history-explorer'],['krw','.krw-report'],['composition','.asset-display']]) {
        await evaluate(`document.querySelector('${selector}').scrollIntoView({block:'start'})`);
        await delay(120);
        const capture=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await fs.writeFile(`work/app-${width}-${name}.png`,Buffer.from(capture.data,'base64'));
      }
    }
    await evaluate(`document.querySelector('[aria-label="환율 고려 원화 성과"]').click()`);
    await evaluate(`{const e=document.querySelector('[aria-label="전략 선택"]');e.value='hold';e.dispatchEvent(new Event('change',{bubbles:true}));}`);
    await evaluate(`document.querySelector('[aria-label="추정 데이터 포함"]').click()`);
    await waitFor(`document.querySelector('.estimate-model') !== null`);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='전체').click()`);
    await waitFor(`document.querySelector('.calculation-status').textContent.includes('8 거래일')`);
    assert.equal(await evaluate(`document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')`),'40000.00');
    assert.match(await evaluate(`document.querySelector('.performance-details').textContent`), /추정 종가 체결 포함/);
    assert.match(await evaluate(`document.querySelector('.estimate-model').textContent`), /보정 .*미사용 검증/);
    await evaluate(setInput('계좌 조회일','2020-01-02'));
    await waitFor(`document.querySelector('.chart-quote').textContent.includes('추정 종가')`);
    assert.equal(await evaluate(`document.querySelector('.chart-quote').textContent.includes('OHLC·거래량 생성 없음')`),true);
    for(const width of [1440,375]){
      await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===375});
      for(const [name,selector] of [['estimated','.estimate-model'],['estimated-chart','.chart-options']]){
        await evaluate(`document.querySelector('${selector}').scrollIntoView({block:'start'})`);await delay(150);
        const layout=await evaluate('({scroll:document.documentElement.scrollWidth,width:innerWidth})');assert(layout.scroll<=layout.width,JSON.stringify(layout));
        const capture=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(`work/app-${width}-${name}.png`,Buffer.from(capture.data,'base64'));
      }
    }
    await evaluate(`document.querySelector('[aria-label="추정 데이터 포함"]').click()`);
    await waitFor(`document.querySelector('[aria-label="시작일"]').value==='2021-01-04' && document.querySelector('.calculation-status').textContent.includes('6 거래일')`);
    assert.equal(await evaluate(`document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')`),'20000.00');
    await evaluate(`document.querySelector('[aria-label="추정 데이터 포함"]').click()`);
    await waitFor(`document.querySelector('.estimate-model') !== null`);
    assert.equal(estimateRequests,1);assert.equal(requests,1);
    failEstimate=true;
    await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='추정 모델 다시 생성').click()`);
    await waitFor(`document.body.textContent.includes('추정 모델 테스트 HTTP 503')`);
    await waitFor(`document.querySelector('.calculation-status').textContent.includes('6 거래일')`);
    failEstimate=false;
    await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='추정 모델 다시 생성').click()`);
    await waitFor(`document.querySelector('.estimate-model') !== null`);
    assert.equal(estimateRequests,3);assert.equal(requests,1);

    await evaluate(`document.querySelector('[aria-label="추정 데이터 포함"]').click()`);
    console.log('PASS 추정 포함·전체 기간 실제 계산·종가 선/실제 캔들 구분·모델 오차·해제 범위 복원·조회 재사용');
    await evaluate(`{const select=document.querySelector('[aria-label="종목"]');select.value='418660.KS';select.dispatchEvent(new Event('change',{bubbles:true}));}`);
    await waitFor(`document.querySelector('[aria-label="환율 고려 원화 성과"]').disabled===true`);
    assert.equal(fxRequests,3);
    console.log('PASS TIGER 원화 종목 환율 체크 비활성·중복 조회 없음');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS 1440/375px 페이지 overflow 없음·브라우저 예외 없음');
  } finally {
    if(socket?.readyState===WebSocket.OPEN){socket.send(JSON.stringify({id:999999,method:'Browser.close'}));socket.close();}
    await delay(100);if(browser.exitCode===null){browser.kill();}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
