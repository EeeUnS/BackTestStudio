const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function run() {
  const datasets = new Map();
  for (const symbol of ['TQQQ','QLD','QQQ','SPY','SOXL','418660.KS']) { const envelope=JSON.parse(await fs.readFile(`cache/${symbol}.json`,'utf8'));datasets.set(symbol,JSON.parse(envelope.payload)); }
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
    let sequence=0; const pending=new Map(); const errors=[]; let requests=0;
    const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Fetch.requestPaused') {
        const symbol=new URL(message.params.request.url).searchParams.get('symbol');
        const data=datasets.get(symbol);assert(data);requests++;
        void command('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({data,cache:'cached',stale:false})).toString('base64')});
      }
      if(message.method==='Runtime.exceptionThrown'){errors.push(message.params.exceptionDetails);}
      const entry=pending.get(message.id);if(!entry){return;}pending.delete(message.id);
      if(message.error){entry.reject(new Error(JSON.stringify(message.error)));}else{entry.resolve(message.result);}
    });
    const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;};
    const waitFor=async expression=>{const deadline=performance.now()+60000;while(performance.now()<deadline){if(await evaluate(expression)){return;}await delay(50);}throw new Error('조건 대기 시간 초과: '+expression+' '+JSON.stringify(await evaluate("({status:document.querySelector('.calculation-status')?.textContent,symbol:document.querySelector('[aria-label=\"종목\"]')?.value,strategy:document.querySelector('[aria-label=\"전략 선택\"]')?.value,start:document.querySelector('[aria-label=\"시작일\"]')?.value,end:document.querySelector('[aria-label=\"종료일\"]')?.value})")));};
    await command('Page.enable');
    await command('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.__measurements=[];window.__longTasks=[];
      new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker {
        postMessage(message){
          if(message.kind==='run'){this.started ??= new Map();this.started.set(message.id,{time:performance.now(),request:message.request});}
          super.postMessage(message);
        }
        set onmessage(handler){super.onmessage=event=>{
          const record=event.data.kind==='result'?this.started?.get(event.data.id):undefined;
          const received=performance.now();handler.call(this,event);
          if(record){requestAnimationFrame(()=>requestAnimationFrame(()=>{
            const afterPaintMs=performance.now()-record.time;
            const finish=()=>{
              if(document.querySelector('.trade-history')?.getAttribute('aria-busy')==='true'){requestAnimationFrame(finish);return;}
              window.__measurements.push({request:record.request,computeMs:event.data.milliseconds,roundTripMs:received-record.time,afterPaintMs,detailsReadyMs:performance.now()-record.time,cached:event.data.cached,days:event.data.result.days.length,trades:event.data.result.trades.length});
            };
            finish();
          }));}
        };}
      };
    `});
    await command('Runtime.enable');
    await command('Fetch.enable',{patterns:[{urlPattern:'*/api/market*'}]});
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url:'http://127.0.0.1:5173/'});
    await waitFor("document.querySelector('.run') && !document.querySelector('.run').disabled");
    const select=async(label,value)=>{await evaluate(`{const e=document.querySelector('[aria-label="${label}"]');e.value='${value}';e.dispatchEvent(new Event('change',{bubbles:true}));}`);await delay(30);};
    const number=async(label,value)=>{await evaluate(`{const e=document.querySelector('[aria-label="${label}"]');e.focus();e.select();}`);await command('Input.insertText',{text:String(value)});};
    if(process.env.BACKTEST_ESTIMATED==='1'){
      const {prepareEstimatedExecution}=await import('../src/data/execution.ts');
      const {runBacktest}=await import('../src/engine/simpleBacktest.ts');
      const checks=[];
      await fs.mkdir('work',{recursive:true});
      for(const [symbol,data] of datasets){
        await select('종목',symbol);await waitFor("!document.querySelector('.run').disabled");
        await select('전략 선택','hold');
        await evaluate(`document.querySelector('[aria-label="추정 데이터 포함"]').click()`);
        await waitFor(`document.querySelector('.estimate-model') !== null`);
        const modelResponse=await fetch(`http://127.0.0.1:5173/api/estimate?symbol=${encodeURIComponent(symbol)}`);
        assert(modelResponse.ok);const model=(await modelResponse.json()).data;
        const prepared=prepareEstimatedExecution(data,model);
        const capital=Math.max(data.currency==='KRW'?10000000:10000,prepared.bars[0].close*20);
        await number('초기 투자금',capital);
        await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='전체').click()`);
        await evaluate(`document.querySelector('.run').click()`);
        await waitFor(`document.querySelector('.performance-details')?.textContent.includes('상장 전 추정 종가 체결 포함')`);
        const expected=runBacktest(prepared,{start:prepared.bars[0].date,end:prepared.bars.at(-1).date,strategy:{kind:'hold',capital}});
        const actual=Number(await evaluate(`document.querySelector('.metric strong').textContent.replace(/[^0-9.]/g,'')`));
        assert(Math.abs(actual-expected.days.at(-1).total)<(data.currency==='KRW'?1:0.01),`${symbol}: ${actual} != ${expected.days.at(-1).total}`);
        await evaluate(`{const e=document.querySelector('[aria-label="계좌 조회일"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'${prepared.bars[0].date}');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}`);
        await waitFor(`document.querySelector('.chart-quote').textContent.includes('추정 종가')`);
        for(const width of [1440,375]){
          await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===375});
          await evaluate(`document.querySelector('.estimate-model').scrollIntoView({block:'start'})`);await delay(100);
          const layout=await evaluate('({scroll:document.documentElement.scrollWidth,width:innerWidth})');assert(layout.scroll<=layout.width,JSON.stringify(layout));
          const capture=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(`work/actual-estimated-${symbol}-${width}.png`,Buffer.from(capture.data,'base64'));
        }
        checks.push({symbol,capital,days:expected.days.length,estimatedDays:expected.days.filter(day=>day.estimated).length,total:actual,modelVersion:model.version});
        console.log(`${symbol}: 실제 전체 이력 추정+실제 화면 계산 일치`);
      }
      assert.equal(errors.length,0,JSON.stringify(errors));
      await fs.writeFile('work/estimated-browser-validation.json',JSON.stringify({checks,requests,errors},null,2));
      return;
    }
    const rows=[];
    for(const [symbol,data] of datasets){
      await select('종목',symbol);
      await waitFor("!document.querySelector('.run').disabled");
      for(const kind of ['hold','dca','infinite','vr']){
        await select('전략 선택',kind);
        for(const size of ['normal','large']){
          const scale=(data.currency==='KRW'?1000:1)*(size==='large'?1000:1);
          await number(kind==='dca'?'회당 납입금':'초기 투자금',(kind==='dca'?250:10000)*scale);
          for(const range of ['5y','full']){
            await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='${range==='full'?'전체':'5년'}').click()`);
            await delay(200);
            const before=await evaluate('window.__measurements.length');
            await evaluate("document.querySelector('.run').click()");
            await waitFor(`window.__measurements.length>${before} && document.querySelector('.calculation-status').textContent.includes('거래일')`);
            await delay(100);
            const result=await evaluate('window.__measurements.at(-1)');
            assert.equal(result.request.strategy.kind,kind);
            assert(result.detailsReadyMs>=result.afterPaintMs);
            rows.push({symbol,size,range,...result});
          }
        }
      }
      console.log(`${symbol}: 브라우저 ${rows.length}개`);
    }
    const lastData=datasets.get('418660.KS');
    const dragBefore=await evaluate('window.__measurements.length');
    await evaluate('window.__dragStart=performance.now()');
    for(let index=10;index>=0;index--){
      const date=lastData.bars.at(-1-index).date;
      await evaluate(`{const e=document.querySelector('[aria-label="종료일"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'${date}');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}`);
      await delay(25);
    }
    await waitFor(`window.__measurements.length>${dragBefore} && document.querySelector('.metrics') !== null`);
    const drag=await evaluate(`({changes:11,completed:window.__measurements.length-${dragBefore},inputToFrameMs:performance.now()-window.__dragStart})`);
    assert.equal(drag.completed,1,'연속 입력은 최종 요청 하나로 합쳐져야 합니다.');
    assert.equal(requests,6,'기간 변경에 시세 API를 추가 호출하면 안 됩니다.');
    assert.equal(errors.length,0,JSON.stringify(errors));
    await fs.mkdir('work',{recursive:true});
    await fs.writeFile('work/browser-performance.json',JSON.stringify({at:new Date().toISOString(),rows,drag,longTasks:await evaluate('window.__longTasks'),requests,note:'실제 캐시 시세·production Chrome·Web Worker. 1440px. 최종 실행 버튼 직전 설정 적용으로 캐시 실행이 포함될 수 있으므로 cached 필드로 구분. afterPaintMs는 결과 수신·React 갱신 후 두 프레임까지이며 순수 렌더 CPU 시간이 아님. 네트워크·입력100ms 제외.'},null,2));
  } finally {
    if(socket?.readyState===WebSocket.OPEN){socket.send(JSON.stringify({id:999999,method:'Browser.close'}));socket.close();}
    await delay(100);if(browser.exitCode===null){browser.kill();}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
