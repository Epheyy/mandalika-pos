// Ordinary imported scenario functions, converted from the accepted manual scripts.
import type { ScenarioPage } from './fixture'

export const setupBackoffice = async (page: ScenarioPage) => {
  await page.unrouteAll({behavior:'wait'});
  const now = new Date().toISOString();
  const user = {id:'synthetic-cashier',displayName:'A26 Cashier',role:'admin',outletId:'outlet-a',permissions:[]};
  const order = i => ({id:`order-${i}`,orderNumber:`A26-${i}`,outletId:'outlet-a',cashierId:user.id,cashierName:user.displayName,customerId:null,customerName:null,status:'completed',paymentMethod:i%2?'qris':'cash',subtotal:1000,total:1000,discountAmount:0,taxAmount:0,createdAt:now,items:[{productId:'p',productName:'A26 Product',variantSize:'M',quantity:1,subtotal:1000,unitPrice:1000}]});
  page.__a26 = {count:51,fail:null,calls:[],csv:[],order};
  await page.route('http://127.0.0.1:59999/api/v1/**',async route=>{
    const req=route.request(), path=req.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    const query=Object.fromEntries((req.url().split('?')[1]||'').split('&').filter(Boolean).map(s=>s.split('=')));
    const n=Number(query.page)||1, requested=Number(query.limit)||50, limit=requested>200||requested<1?50:requested;
    const state=page.__a26;state.calls.push({path,page:n,requested,limit});
    if(state.fail===path && n===2) return route.fulfill({status:503,json:{error:'A26 synthetic page 2 failure'}});
    let data: any=[];
    if(path.includes('/auth/')) data={access:'SYNTHETIC-NON-TOKEN',refresh:'SYNTHETIC-NON-TOKEN',user};
    else if(path.endsWith('/outlets')) data=[{id:'outlet-a',name:'A26 Outlet',isActive:true}];
    else if(path.endsWith('/orders')) data=Array.from({length:state.count},(_,i)=>order(i));
    else if(path.endsWith('/shifts')) data=Array.from({length:state.count},(_,i)=>({id:`shift-${i}`,outletId:'outlet-a',cashierName:`Cashier ${i}`,status:'closed',openedAt:now,closedAt:now,startingCash:0,closingCash:1000,totalSales:1000,totalOrders:1,cashSales:1000,cardSales:0,transferSales:0,qrisSales:0}));
    else if(path.endsWith('/products')) data=Array.from({length:201},(_,i)=>({id:`p-${i}`,name:`Product ${i}`,isActive:true,variants:[{size:'M',price:1000,stock:i===200?0:100}]}));
    const total=Array.isArray(data)?data.length:1;
    if(['/orders','/shifts','/products'].some(s=>path.endsWith(s))) data=data.slice((n-1)*limit,n*limit);
    return route.fulfill({json:{data,meta:{total,page:n,limit}}});
  });
  await page.goto('http://127.0.0.1:5184');
  await page.evaluate(()=>{localStorage.clear();localStorage.setItem('mandalika.backoffice.refresh','SYNTHETIC-NON-TOKEN');localStorage.setItem('mandalika.backoffice.loginDate',new Date().toISOString().slice(0,10));});
  await page.reload();
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Laporan',exact:true}).click();
  await page.getByRole('button',{name:'Ekspor',exact:true}).click();
  await page.evaluate(()=>{window.__a26csv=[];URL.createObjectURL=(b:any)=>{window.__a26csv.push(b.text());return 'blob:synthetic';};HTMLAnchorElement.prototype.click=function(){};});
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  const csv=await page.evaluate(()=>Promise.all(window.__a26csv));
  return {expected:51,rows:csv[0]?.split('\n').length-1,calls:page.__a26.calls,body:(await page.locator('body').innerText()).slice(-1300)};
}

export const backofficeChecks = async (page: ScenarioPage) => {
  const results: any[]=[];
  const check=(ok,msg)=>{if(!ok)throw new Error(msg);};
  const capture=async()=>{await page.evaluate(()=>window.__a26csv=[]);await page.getByRole('button',{name:'Export CSV',exact:true}).click();return (await page.evaluate(()=>Promise.all(window.__a26csv)))[0];};
  for(const n of [51,201,1000]) {
    page.__a26.count=n;page.__a26.calls=[];
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    await page.getByText(`${n} transaksi`,{exact:true}).waitFor();
    const dashboard=await page.locator('main').innerText();
    check(dashboard.includes(`Rp ${(n*1000).toLocaleString('id-ID')}`)||dashboard.replace(/\s/g,'').includes(`Rp${(n*1000).toLocaleString('id-ID')}`),'dashboard total');
    check(dashboard.includes('Product 200'),'last-page low stock missing');
    await page.getByRole('button',{name:'Laporan',exact:true}).click();
    await page.getByRole('button',{name:'Ekspor',exact:true}).click();
    await page.getByText(`${n} transaksi`,{exact:true}).waitFor();
    const csv=await capture();const csvRows=csv.split('\n').length-1;
    check(csvRows===n,`CSV ${csvRows} expected ${n}`);
    const report=await page.locator('main').innerText();
    check(report.replace(/\s/g,'').includes(`Rp${(n*1000).toLocaleString('id-ID')}`),'report total');
    await page.locator('select').filter({has:page.locator('option[value="qris"]')}).selectOption('qris');
    const filtered=await capture();check(filtered.split('\n').length-1===Math.floor(n/2),'payment filter');
    await page.locator('select').filter({has:page.locator('option[value="refunded"]')}).selectOption('refunded');
    check((await page.locator('main').innerText()).includes('0 transaksi'),'status filter');
    await page.locator('select').filter({has:page.locator('option[value="refunded"]')}).selectOption('');
    await page.locator('select').filter({has:page.locator('option[value="qris"]')}).selectOption('');
    await page.locator('input[type=date]').first().fill('2099-01-01');
    check((await page.locator('main').innerText()).includes('0 transaksi'),'date filter');
    await page.locator('input[type=date]').first().fill(new Date().toISOString().slice(0,10));
    await page.getByRole('button',{name:'Shift',exact:true}).click();
    const shifts=await capture();check(shifts.split('\n').length-1===n,'shift CSV');
    results.push({n,csvRows,shiftCsvRows:n,reportTotal:n*1000,filteredQris:Math.floor(n/2),dashboard,requests:page.__a26.calls});
  }
  await page.getByRole('button',{name:'Ekspor',exact:true}).click();
  page.__a26.fail='/api/v1/orders';
  await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor({timeout:20000});
  check(await page.getByRole('button',{name:'Export CSV',exact:true}).isDisabled(),'failed export enabled');
  check((await page.locator('main').innerText()).includes('1000 transaksi'),'complete snapshot lost');
  results.push({laterPageFailure:'visible error; original1000 snapshot retained; export disabled'});
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor();
  results.push({dashboardInitialFailure:'error instead of prefix KPIs'});
  page.__a26.fail=null;
  return results;
}

export const transactionsChecks = async (page: ScenarioPage) =>{
  const results: any[]=[];
  for(const n of [51,201,1000]) {
    page.__a26.count=n;
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    await page.getByRole('button',{name:'Laporan',exact:true}).click();
    await page.getByText(`${n} transaksi · Total:`,{exact:false}).waitFor();
    await page.evaluate(()=>{window.__a26blobs=[];URL.createObjectURL=(b:any)=>{window.__a26blobs.push(b);return 'blob:synthetic';};});
    await page.getByRole('button',{name:'Export',exact:true}).click();
    const rows=await page.evaluate(async()=>{
      const url=performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('/xlsx.js'));
      const XLSX=await import(url!);
      const wb=XLSX.read(await window.__a26blobs[0].arrayBuffer());
      return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    });
    if(rows.length!==n||rows.reduce((s,r)=>s+r.Total,0)!==n*1000)throw new Error('incomplete XLSX');
    results.push({n,xlsxRows:rows.length,total:rows.reduce((s,r)=>s+r.Total,0)});
  }
  page.__a26.fail='/api/v1/orders';
  await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor({timeout:20000});
  if(!(await page.getByRole('button',{name:'Export',exact:true}).isDisabled()))throw new Error('failure enabled export');
  results.push({laterFailure:'visible error; XLSX disabled; complete snapshot retained'});
  page.__a26.fail=null;
  return results;
}

export const qualifyBackoffice = async (page: ScenarioPage) =>{
 const out: any[]=[];const P=page.__a24.products[0].id;const fixture=page.__a24.promotions[3];const initial=JSON.parse(JSON.stringify(fixture));
 const rows: any[]=[['bundle',P,P+'|M',false],['bundle',P+'|M',P,false],['bundle',P+'|M',P+'|L',true],['buy_x_get_y',P,P+'|M',false],['buy_x_get_y',P+'|M',P+'|L',true]];
 for(const [type,a,b,valid]of rows){
  fixture.type=type;fixture.bundleConfig={slots:[{productKeys:[a],quantity:1},{productKeys:[b],quantity:1}],bundlePrice:100000,maxApplications:1};fixture.bxgyConfig={buyProductIds:[a],getProductIds:[b],buyQuantity:1,getQuantity:1,getDiscountKind:'percentage',getDiscountValue:50,maxApplications:1};
  await page.reload();await page.getByRole('button',{name:'Promosi',exact:true}).first().click();
  await page.getByRole('row').filter({hasText:'Invalid Legacy'}).locator('button').nth(1).click();
  await page.getByRole('button',{name:'Lanjutkan',exact:true}).click();const mechanics=await page.locator('.fixed.inset-0.z-50').innerText();
  await page.getByRole('button',{name:'Lanjutkan',exact:true}).click();const save=page.getByRole('button',{name:'Simpan',exact:true});
  if((await save.isEnabled())!==valid)throw Error(type+a+b+' wrong Save gate');
  const n=page.__a24.writes.length;
  if(valid){await save.click();await page.locator('.fixed.inset-0.z-50').waitFor({state:'hidden'});if(page.__a24.writes.length!==n+1)throw Error('missing save');}
  else {await save.evaluate((b:any)=>b.click());if(page.__a24.writes.length!==n)throw Error('invalid API mutation');await page.getByRole('button',{name:'Batal',exact:true}).click();}
  out.push({type,keys:[a,b],valid,saveEnabled:valid,mutationCalls:page.__a24.writes.length-n,mechanics});
 }
 // Real picker edit: valid M/L -> whole/M overlap -> valid M/L again.
 fixture.type='bundle';fixture.bundleConfig={slots:[{productKeys:[P+'|M'],quantity:1},{productKeys:[P+'|L'],quantity:1}],bundlePrice:100000,maxApplications:1};
 await page.reload();await page.getByRole('button',{name:'Promosi',exact:true}).first().click();await page.getByRole('row').filter({hasText:'Invalid Legacy'}).locator('button').nth(1).click();await page.getByRole('button',{name:'Lanjutkan',exact:true}).click();
 await page.getByRole('checkbox',{name:'Pilih semua varian Synthetic Scent'}).first().check();
 const interactiveError=await page.locator('.fixed.inset-0.z-50').innerText();if(!interactiveError.includes('Produk atau varian tidak boleh'))throw Error('picker overlap not shown');
 await page.getByRole('button',{name:'Lanjutkan',exact:true}).click();if(await page.getByRole('button',{name:'Simpan',exact:true}).isEnabled())throw Error('picker invalid save');await page.getByRole('button',{name:'Batal',exact:true}).click();
 const row=page.getByRole('row').filter({hasText:'Invalid Legacy'});await row.getByTitle('Duplikat').click();

 await row.getByRole('button',{name:'Aktif',exact:true}).click();
 const writes=page.__a24.writes.slice(-2);
 if(writes[0].method!=='POST'||writes[1].method!=='PUT'||writes[1].body.isActive!==false)throw Error('duplicate/toggle mutation missing');
 for(const write of writes)if(JSON.stringify(write.body.bundleConfig)!==JSON.stringify(fixture.bundleConfig))throw Error('duplicate/toggle changed bundle mechanics');
 out.push({interactiveError,duplicateAndToggle:writes});
 Object.assign(fixture,initial);page.__a24.boQualification=out;return out;
}

export const reportsRaces = async (page: ScenarioPage, errorCase: boolean) => {
  await page.unrouteAll({behavior:'wait'});
  const user={id:'synthetic-user',displayName:'A31 Tester',role:'admin',outletId:'A',permissions:[]};
  const now=new Date().toISOString(), calls: any[]=[], held: (() => Promise<void>)[]=[];let failB=false, signal: () => void;
  let reached=new Promise<void>(resolve=>signal=resolve);
  const order=(scope,i)=>({id:`${scope}-${i}`,orderNumber:`${scope}-${i}`,outletId:scope,cashierId:user.id,cashierName:user.displayName,customerId:null,customerName:null,status:'completed',paymentMethod:'cash',subtotal:scope==='B'?7000:1000,total:scope==='B'?7000:1000,discountAmount:0,taxAmount:0,createdAt:now,items:[]});
  await page.route('http://127.0.0.1:59999/api/v1/**',async route=>{
    const req=route.request(), path=req.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    const q=Object.fromEntries((req.url().split('?')[1]||'').split('&').filter(Boolean).map(s=>s.split('=')));
    const scope=req.headers()['x-outlet-id']||q.outletId||'', n=Number(q.page)||1,limit=Number(q.limit)||50;
    calls.push({path,scope,page:n});
    let data: any=[];
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
  await page.goto('http://127.0.0.1:5184');
  await page.evaluate(()=>{localStorage.clear();localStorage.setItem('mandalika.backoffice.refresh','SYNTHETIC-NON-TOKEN');localStorage.setItem('mandalika.backoffice.loginDate',new Date().toISOString().slice(0,10));});
  await page.reload();await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Laporan',exact:true}).click();await page.getByRole('button',{name:'Ekspor',exact:true}).click();
  const outlet=page.locator('select').filter({has:page.locator('option[value="A"]')});
  const flush=()=>page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  const results: any[]=[];
  for(const scenario of [errorCase]){
    failB=scenario;reached=new Promise<void>(resolve=>signal=resolve);
    await outlet.selectOption('A');await reached;await outlet.selectOption('B');
    if(errorCase)await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor();
    else await page.getByText('1 transaksi',{exact:true}).waitFor();
    const before=await page.locator('main').innerText();const count=held.length;
    await Promise.all(held.splice(0).map(fn=>fn()));await flush();
    // Barrier: a same-origin request after the released HTTP responses, then two rendered frames.
    await page.evaluate(()=>fetch('/tests/polling-harness.html'));await flush();
    const after=await page.locator('main').innerText();
    if(before!==after)throw new Error(`Stale A changed B rendered content (${errorCase}): ${after}`);
    if(errorCase){if(!await page.getByRole('button',{name:'Export CSV',exact:true}).isDisabled())throw new Error('B failure export enabled');}
    else if(!after.replace(/\s/g,'').includes('Rp7.000')||after.includes('201 transaksi'))throw new Error('B-only totals missing');
    results.push({scenario:errorCase?'B failure then late complete A':'B success then late complete A',passed:true,heldAPage2Responses:count,before,after});
  }
  page.__a31Result = {environment:'real Backoffice Reports, synthetic intercepted HTTP, real fetchAllPages 201-row A cohort; no backend/live data',results,calls};
  return page.__a31Result;
}
