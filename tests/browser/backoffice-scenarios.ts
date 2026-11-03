// Ordinary imported scenario functions, converted from the accepted manual scripts.
import { openBackoffice, navTo, openTab, clickTab, type ScenarioPage } from './fixture'
import { createRequire } from 'node:module'
import path from 'node:path'

const xlsxRequire = createRequire(path.resolve('apps/backoffice/package.json'))
const workbookReader = xlsxRequire('xlsx')

// Mirrors the backend's shared order filter (WIB day bounds, status, case-insensitive
// trimmed payment method, q over order number/cashier/customer) so the browser scenarios
// exercise the real request contract instead of client-side filtering.
const wibDay = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10)
const filterOrders = (list: any[], query: Record<string, string>) => {
  const dec = (v?: string) => (v === undefined ? '' : decodeURIComponent(v.replace(/\+/g, ' ')))
  const pay = dec(query.paymentMethod).trim().toLowerCase(), q = dec(query.q).toLowerCase()
  // dateBasis=refund (A27) returns only refunded rows, bounded by the refund day (mock rows are never refunded).
  return list.filter(o =>
    (query.dateBasis !== 'refund' || o.status === 'refunded') &&
    (!query.status || o.status === query.status) &&
    (!pay || o.paymentMethod.trim().toLowerCase() === pay) &&
    (!query.dateFrom || wibDay(o.createdAt) >= query.dateFrom) &&
    (!query.dateTo || wibDay(o.createdAt) <= query.dateTo) &&
    (!q || o.orderNumber.toLowerCase().includes(q) || o.cashierName.toLowerCase().includes(q) || (o.customerName || '').toLowerCase().includes(q)))
}
const summaryOf = (list: any[]) => {
  const completed = list.filter(o => o.status === 'completed'), refunded = list.filter(o => o.status === 'refunded')
  const byPaymentMethod: Record<string, number> = {}
  for (const o of completed) byPaymentMethod[o.paymentMethod] = (byPaymentMethod[o.paymentMethod] || 0) + o.total
  const totalSales = completed.reduce((a, o) => a + o.total, 0)
  // A27: gross = completed + refunded by sale day, refunds on the refund day, net = gross - refunds.
  const grossSales = totalSales + refunded.reduce((a, o) => a + o.total, 0), totalRefunds = refunded.reduce((a, o) => a + o.total, 0)
  const grossByPaymentMethod: Record<string, number> = {}
  for (const o of [...completed, ...refunded]) grossByPaymentMethod[o.paymentMethod] = (grossByPaymentMethod[o.paymentMethod] || 0) + o.total
  return {from: null, to: null, outletId: null, totalSales, totalOrders: completed.length,
    grossSales, grossOrders: completed.length + refunded.length,
    totalRefunds, refundedOrders: refunded.length, netSales: grossSales - totalRefunds,
    avgOrderValue: completed.length ? totalSales / completed.length : 0, byPaymentMethod, grossByPaymentMethod,
    refundsByPaymentMethod: {}, topProducts: [], dailySales: []}
}

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
    const state=page.__a26;state.calls.push({path,page:n,requested,limit,dateBasis:query.dateBasis});
    if(state.fail===path && n===2) return route.fulfill({status:503,json:{error:'A26 synthetic page 2 failure'}});
    let data: any=[];
    if(path.includes('/auth/')) data={access:'SYNTHETIC-NON-TOKEN',refresh:'SYNTHETIC-NON-TOKEN',user};
    else if(path.endsWith('/outlets')) data=[{id:'outlet-a',name:'A26 Outlet',isActive:true}];
    else if(path.endsWith('/settings/app')) data={paymentMethods:[{id:'cash',label:'Tunai'},{id:'qris',label:'QRIS'}]};
    else if(path.endsWith('/reports/summary')) data=summaryOf(filterOrders(Array.from({length:state.count},(_,i)=>state.order(i)),query));
    else if(path.endsWith('/orders')) data=filterOrders(Array.from({length:state.count},(_,i)=>state.order(i)),query);
    else if(path.endsWith('/shifts')) data=Array.from({length:state.count},(_,i)=>({id:`shift-${i}`,outletId:'outlet-a',cashierName:`Cashier ${i}`,status:'closed',openedAt:now,closedAt:now,startingCash:0,closingCash:1000,totalSales:1000,totalOrders:1,cashSales:1000,cardSales:0,transferSales:0,qrisSales:0})).filter(sh=>(!query.dateFrom||wibDay(sh.openedAt)>=query.dateFrom)&&(!query.dateTo||wibDay(sh.openedAt)<=query.dateTo));
    else if(path.endsWith('/products')) data=Array.from({length:201},(_,i)=>({id:`p-${i}`,name:`Product ${i}`,isActive:true,variants:[{size:'M',price:1000,stock:i===200?0:100}]}));
    const total=Array.isArray(data)?data.length:1;
    if(['/orders','/shifts','/products'].some(s=>path.endsWith(s))) data=data.slice((n-1)*limit,n*limit);
    return route.fulfill({json:{data,meta:{total,page:n,limit}}});
  });
  await openBackoffice(page);
  await navTo(page, 'reports');
  await clickTab(page, 'export');
  await page.evaluate(()=>{window.__a26csv=[];URL.createObjectURL=(b:any)=>{window.__a26csv.push(b.text());return 'blob:synthetic';};HTMLAnchorElement.prototype.click=function(){};});
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  const csv=await page.evaluate(()=>Promise.all(window.__a26csv));
  return {expected:51,rows:csv[0]?.split('\n').length-1,calls:page.__a26.calls,body:(await page.locator('body').innerText()).slice(-1300)};
}

export const backofficeChecks = async (page: ScenarioPage) => {
  const results: any[]=[];
  const check=(ok,msg)=>{if(!ok)throw new Error(msg);};
  const capture=async()=>{await page.evaluate(()=>window.__a26csv=[]);await page.getByRole('button',{name:'Export CSV',exact:true}).click();await page.waitForFunction(()=>window.__a26csv.length>0);return (await page.evaluate(()=>Promise.all(window.__a26csv)))[0];};
  for(const n of [51,201,1000]) {
    page.__a26.count=n;page.__a26.calls=[];
    await navTo(page, 'dashboard');
    // T7: the revenue KPI is net; its subtitle shows Kotor / Refund (was "N transaksi"), proving the refund side loaded.
    const money=(n*1000).toLocaleString('id-ID');
    await page.getByText(new RegExp('^Kotor Rp\\s*'+money.replace(/\./g,'\\.')+'\\s*/ Refund Rp\\s*0$')).waitFor();
    const kpiValue=(await page.locator('p',{hasText:/^Penjualan$/}).locator('xpath=preceding-sibling::p[1]').innerText()).replace(/\s/g,'');
    check(kpiValue===`Rp${money}`,'dashboard net KPI value');
    const dashboard=await page.locator('main').innerText();
    check(dashboard.includes('Tren Penjualan (Bersih)'),'dashboard net trend heading');
    check(page.__a26.calls.some(c=>c.path.endsWith('/orders')&&c.dateBasis==='refund'),'dashboard refund-basis request');
    check(dashboard.includes(`Rp ${(n*1000).toLocaleString('id-ID')}`)||dashboard.replace(/\s/g,'').includes(`Rp${(n*1000).toLocaleString('id-ID')}`),'dashboard total');
    check(dashboard.includes('Product 200'),'last-page low stock missing');
    await navTo(page, 'reports');
    await clickTab(page, 'export');
    await page.getByText(`${n} transaksi`,{exact:true}).waitFor();
    await page.getByText('Penjualan Kotor',{exact:true}).waitFor();
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
    // Restore "today" in the browser's timezone (Asia/Jakarta), matching the Reports default.
    const localToday=await page.evaluate(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
    await page.locator('input[type=date]').first().fill(localToday);
    await clickTab(page, 'shifts');
    const shifts=await capture();check(shifts.split('\n').length-1===n,'shift CSV');
    results.push({n,csvRows,shiftCsvRows:n,reportTotal:n*1000,filteredQris:Math.floor(n/2),dashboard,requests:page.__a26.calls});
  }
  await clickTab(page, 'export');
  await page.getByText('1000 transaksi',{exact:true}).waitFor();
  // The list/summary only request one page; a later page can only fail inside the full export.
  page.__a26.fail='/api/v1/orders';
  await page.evaluate(()=>{window.__a26csv=[]});
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'synthetic page 2 failure'}).waitFor({timeout:20000});
  check((await page.evaluate(()=>window.__a26csv.length))===0,'partial CSV produced after a later page failure');
  check((await page.locator('main').innerText()).includes('1000 transaksi'),'complete snapshot lost');
  results.push({laterPageFailure:'visible error; no partial CSV; list snapshot retained'});
  await navTo(page, 'dashboard');
  await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor();
  results.push({dashboardInitialFailure:'error instead of prefix KPIs'});
  page.__a26.fail=null;
  return results;
}

export const transactionsChecks = async (page: ScenarioPage) => {
  const results: any[] = [];
  const baseOrder = page.__a26.order;
  const textIds = ['0000123', '=1+1', '+628123', '@SUM(A1)', '-123'];
  page.__a26.order = i => ({...baseOrder(i), orderNumber: textIds[i] ?? `A26-${i}`,
    cashierName: 'Ni Luh Äyu 香 🌺', customerName: i % 2 ? 'Pelanggan Montréal' : null,
    discountLabel: 'Melati 110 ml + Mawar 10 ml', discountValue: i % 2 ? 0 : undefined});
  // setupBackoffice's legacy CSV capture stubs belong to the old document.
  // Reload restores the real browser Blob/download path for this scenario.
  await page.reload();
  if (workbookReader.version !== '0.20.3') throw Error('Node readback resolved wrong SheetJS');
  let downloads = 0;
  page.on('download', () => downloads++);
  const capture = async () => {
    const waiting = page.waitForEvent('download');
    await page.getByRole('button',{name:'Export',exact:true}).click();
    const download = await waiting;
    const stream = await download.createReadStream();
    if (!stream || await download.failure()) throw Error('XLSX download failed');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const book = workbookReader.read(bytes);
    if (book.SheetNames.join() !== 'Data') throw Error('Worksheet name changed');
    const sheet = book.Sheets.Data;
    const rows = workbookReader.utils.sheet_to_json(sheet);
    const headers = workbookReader.utils.sheet_to_json(sheet,{header:1})[0];
    const expectedHeaders = ['No. Order','Tanggal','Status','Pembayaran','Kasir','Pelanggan','Jumlah Item','Subtotal','Diskon','Sumber Diskon','Tipe Diskon','Nilai Diskon','Rincian Diskon','Pajak','Total'];
    if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) throw Error('XLSX column contract changed');
    return {sheet,rows,filename:download.suggestedFilename(),bytes:bytes.length};
  };
  for (const n of [51,201,1000]) {
    page.__a26.count=n;
    await navTo(page, 'dashboard');
    await navTo(page, 'reports');
    await page.getByText(`${n} transaksi · Total:`,{exact:false}).waitFor();
    const browserVersion=await page.evaluate(async()=>{
      const url=performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('/xlsx.js'));
      if(!url)throw Error('Application XLSX module missing');
      return (await import(url)).version;
    });
    if(browserVersion!=='0.20.3')throw Error('Application resolved wrong SheetJS');
    const {rows,sheet,filename,bytes}=await capture();
    if(rows.length!==n||rows.reduce((sum,row)=>sum+row.Total,0)!==n*1000)throw Error('incomplete XLSX');
    const cells: any[]=[];
    for(let i=0;i<textIds.length;i++){
      const row=rows[i],source=page.__a26.order(i),address=`A${i+2}`;
      const dateParts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(source.createdAt));
      const part=(name:string)=>dateParts.find(p=>p.type===name)!.value;
      const expectedDate=`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
      if(row['No. Order']!==textIds[i]||row.Tanggal!==expectedDate||row.Kasir!==source.cashierName||row.Pelanggan!==(source.customerName??'')||row['Jumlah Item']!==1||row['Sumber Diskon']!==source.discountLabel)throw Error('typed/Unicode/date value changed');
      if(sheet[address].t!=='s'||sheet[address].f!==undefined||sheet[`O${i+2}`].t!=='n'||sheet[`B${i+2}`].t!=='s')throw Error('identifier/amount/date cell type changed');
      cells.push({id:sheet[address],date:sheet[`B${i+2}`],amount:sheet[`O${i+2}`],row});
    }
    await page.getByLabel('Filter pembayaran').selectOption('qris');
    const qris=await capture();
    if(qris.rows.length!==Math.floor(n/2)||qris.rows.some(r=>r.Pembayaran!=='qris'))throw Error('XLSX payment filter changed');
    await page.getByLabel('Filter pembayaran').selectOption('');
    await page.getByLabel('Cari order / kasir / pelanggan').fill('0000123');
    const single=await capture();if(single.rows.length!==1||single.rows[0]['No. Order']!=='0000123')throw Error('single-row/search export changed');
    await page.getByLabel('Cari order / kasir / pelanggan').fill('');
    await page.getByLabel('Filter status').selectOption('refunded');
    if(!await page.getByRole('button',{name:'Export',exact:true}).isDisabled())throw Error('empty/status export enabled');
    await page.getByLabel('Filter status').selectOption('');
    // Totals now load from the server after each filter change; wait for the unfiltered figure.
    await page.waitForFunction(([count,total])=>{const t=document.querySelector('main')!.innerText.replace(/\s/g,'');return t.includes(`${count}transaksi·Total:Rp${total}`)},[n,(n*1000).toLocaleString('id-ID')]);
    const body=(await page.locator('main').innerText()).replace(/\s/g,'');
    if(!body.includes(`Rp${(n*1000).toLocaleString('id-ID')}`))throw Error('rendered total changed');
    results.push({n,xlsxRows:rows.length,total:rows.reduce((sum,row)=>sum+row.Total,0),filename,bytes,browserVersion,readerVersion:workbookReader.version,readerEntry:xlsxRequire.resolve('xlsx'),cells,qrisRows:qris.rows.length,singleRows:single.rows.length,emptyDisabled:true});
  }
  page.__a26.fail='/api/v1/orders';
  await page.getByRole('button',{name:'Export',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'synthetic page 2 failure'}).waitFor({timeout:20000});
  if(downloads!==9)throw Error('unexpected/partial download count');
  results.push({laterFailure:'visible error; no partial XLSX download after a later page failure',downloads});
  page.__a26.fail=null;
  return results;
}

export const qualifyBackoffice = async (page: ScenarioPage) =>{
 const out: any[]=[];const P=page.__a24.products[0].id;const fixture=page.__a24.promotions[3];const initial=JSON.parse(JSON.stringify(fixture));
 const rows: any[]=[['bundle',P,P+'|M',false],['bundle',P+'|M',P,false],['bundle',P+'|M',P+'|L',true],['buy_x_get_y',P,P+'|M',false],['buy_x_get_y',P+'|M',P+'|L',true]];
 for(const [type,a,b,valid]of rows){
  fixture.type=type;fixture.bundleConfig={slots:[{productKeys:[a],quantity:1},{productKeys:[b],quantity:1}],bundlePrice:100000,maxApplications:1};fixture.bxgyConfig={buyProductIds:[a],getProductIds:[b],buyQuantity:1,getQuantity:1,getDiscountKind:'percentage',getDiscountValue:50,maxApplications:1};
  await page.reload();await navTo(page, 'promotions');
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
 await page.reload();await navTo(page, 'promotions');await page.getByRole('row').filter({hasText:'Invalid Legacy'}).locator('button').nth(1).click();await page.getByRole('button',{name:'Lanjutkan',exact:true}).click();
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
      if(scope==='A'){held.push(()=>route.fulfill({json:{data:data.slice(0,limit),meta:{page:1,limit,total:201}}}));signal();return;}
    }
    else if(path.endsWith('/reports/summary')){
      const sales=scope==='A'?201*1000:scope==='B'?7000:0,count=scope==='A'?201:scope==='B'?1:0;
      data={from:null,to:null,outletId:null,totalSales:sales,totalOrders:count,totalRefunds:0,refundedOrders:0,netSales:sales,grossSales:sales,grossOrders:count,avgOrderValue:count?sales/count:0,byPaymentMethod:count?{cash:sales}:{},grossByPaymentMethod:count?{cash:sales}:{},refundsByPaymentMethod:{},topProducts:[],dailySales:[]};
      // Hold A's summary too: both polled queries of the tab must ignore a late A response.
      if(scope==='A'){held.push(()=>route.fulfill({json:{data,meta:{total:1,page:1,limit:50}}}));return;}
    }
    const total=Array.isArray(data)?data.length:1;
    if(path.endsWith('/orders'))data=data.slice((n-1)*limit,n*limit);
    await route.fulfill({json:{data,meta:{total,page:n,limit}}});
  });
  await openBackoffice(page);
  await openTab(page, 'reports', 'export');
  const outlet=page.locator('select').filter({has:page.locator('option[value="A"]')});
  const flush=()=>page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  const results: any[]=[];
  for(const scenario of [errorCase]){
    failB=scenario;reached=new Promise<void>(resolve=>signal=resolve);
    await outlet.selectOption('A');await reached;await outlet.selectOption('B');
    if(errorCase)await page.getByRole('alert').filter({hasText:'Gagal memuat data'}).waitFor();
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
