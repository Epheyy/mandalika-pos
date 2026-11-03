async (page) => {
  await page.unrouteAll({behavior:'wait'});
  await page.context().route('**/*',r=>/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(r.request().url())?r.continue():r.abort());
  const user={id:'synthetic-user',displayName:'A31 Tester',role:'admin',outletId:'A',permissions:[]};
  const now=new Date().toISOString(), calls=[], held=[];let failB=false, signal;
  let reached=new Promise(resolve=>signal=resolve);
  const order=(scope,i)=>({id:`${scope}-${i}`,orderNumber:`${scope}-${i}`,outletId:scope,cashierId:user.id,cashierName:user.displayName,customerId:null,customerName:null,status:'completed',paymentMethod:'cash',subtotal:scope==='B'?7000:1000,total:scope==='B'?7000:1000,discountAmount:0,taxAmount:0,createdAt:now,items:[]});
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(), path=req.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    const q=Object.fromEntries((req.url().split('?')[1]||'').split('&').filter(Boolean).map(s=>s.split('=')));
    const scope=req.headers()['x-outlet-id']||q.outletId||'', n=Number(q.page)||1,limit=Number(q.limit)||50;
    calls.push({path,scope,page:n});
    let data=[];
    if(path.includes('/auth/'))data={access:'SYNTHETIC-NON-TOKEN',refresh:'SYNTHETIC-NON-TOKEN',user};
    else if(path.endsWith('/outlets'))data=[{id:'A',name:'Outlet A',isActive:true},{id:'B',name:'Outlet B',isActive:true}];
    else if(path.endsWith('/orders')){
      if(scope==='B'&&failB)return route.fulfill({status:503,json:{error:'A31 B synthetic failure'}});
      data=scope==='A'?Array.from({length:201},(_,i)=>order('A',i)):scope==='B'?[order('B',0)]:[];
      if(scope==='A'&&n===2){held.push(()=>route.fulfill({json:{data:data.slice(200),meta:{page:2,limit:200,total:201}}}));signal();return;}
    }
    const total=Array.isArray(data)?data.length:1;
    if(path.endsWith('/orders'))data=data.slice((n-1)*limit,n*limit);
    await route.fulfill({json:{data,meta:{total,page:n,limit}}});
  });
  await page.goto('http://127.0.0.1:5174');
  await page.evaluate(()=>{localStorage.clear();localStorage.setItem('mandalika.backoffice.refresh','SYNTHETIC-NON-TOKEN');localStorage.setItem('mandalika.backoffice.loginDate',new Date().toISOString().slice(0,10));});
  await page.reload();await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Laporan',exact:true}).click();await page.getByRole('button',{name:'Unduh data',exact:true}).click();
  const outlet=page.locator('select').filter({has:page.locator('option[value="A"]')});
  const flush=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const results=[];
  for(const errorCase of [false,true]){
    failB=errorCase;reached=new Promise(resolve=>signal=resolve);
    await outlet.selectOption('A');await reached;await outlet.selectOption('B');
    if(errorCase)await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor();
    else await page.getByText('1 transaksi',{exact:true}).waitFor();
    const before=await page.locator('main').innerText();const count=held.length;
    await Promise.all(held.splice(0).map(fn=>fn()));await flush();
    // Barrier: a same-origin request after the released HTTP responses, then two rendered frames.
    await page.evaluate(()=>fetch('/tests/polling-harness.html'));await flush();
    const after=await page.locator('main').innerText();
    if(before!==after)throw new Error(`Stale A changed B rendered content (${errorCase}): ${after}`);
    if(errorCase){if(!await page.getByRole('button',{name:'Unduh CSV',exact:true}).isDisabled())throw new Error('B failure export enabled');}
    else if(!after.replace(/\s/g,'').includes('Rp7.000')||after.includes('201 transaksi'))throw new Error('B-only totals missing');
    results.push({scenario:errorCase?'B failure then late complete A':'B success then late complete A',passed:true,heldAPage2Responses:count,before,after});
  }
  page.__a31Result = {environment:'real Backoffice Reports, synthetic intercepted HTTP, real fetchAllPages 201-row A cohort; no backend/live data',results,calls};
  return page.__a31Result;
}
