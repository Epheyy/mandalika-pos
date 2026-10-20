// Ordinary imported scenario functions, converted from the accepted manual scripts.
import type { ScenarioPage } from './fixture'

// A04: an outlet-less (admin) account on an unbound terminal must pick the outlet once. The
// real picker is clicked here, exactly as a person would; the choice is then stored in the
// app's own durable terminal binding, so later reloads in the same scenario do not ask again.
export const passTerminalPicker = async (page: ScenarioPage, outletName = 'Synthetic Outlet') => {
  const product = page.getByRole('button', { name: 'S Synthetic Scent', exact: true });
  const picker = page.getByRole('heading', { name: 'Pilih outlet terminal ini' });
  await picker.or(product).first().waitFor();
  if (await picker.isVisible()) {
    await page.getByRole('button', { name: outletName, exact: true }).click();
  }
};

export const setupPos = async (page: ScenarioPage) => {
  const P = '00000000-0000-4000-8300-000000000001';
  const R = '00000000-0000-4000-8300-000000000002';
  const products: any[] = [{id:P,name:'Synthetic Scent',isActive:true,variants:[{size:'M',sku:'SYN-M',price:100000,stock:100},{size:'L',sku:'SYN-L',price:120000,stock:100}]},{id:R,name:'Synthetic Tester',isActive:true,variants:[{size:'M',sku:'TEST-M',price:20000,stock:100},{size:'L',sku:'TEST-L',price:25000,stock:100}]}];
  products.forEach(p=>p.variants.forEach(v=>v.barcode=v.sku));
  const base={value:0,isActive:true,combinable:true,codeOnly:false,minPurchase:0};
  const promotions: any[] =[{...base,id:'bundle',name:'Synthetic Bundle',type:'bundle',bundleConfig:{slots:[{productKeys:[P],quantity:1},{productKeys:[R],quantity:1}],bundlePrice:105000,maxApplications:1}},{...base,id:'bxgy',name:'Synthetic BXGY',type:'buy_x_get_y',bxgyConfig:{buyProductIds:[P],getProductIds:[R],buyQuantity:1,getQuantity:1,getDiscountKind:'percentage',getDiscountValue:50,maxApplications:1}},{...base,id:'generic',name:'Generic Ten',type:'percentage',value:10},{...base,id:'invalid',name:'Invalid Legacy',type:'bundle',bundleConfig:{slots:[{productKeys:[P],quantity:1},{productKeys:[P+'|M'],quantity:1}],bundlePrice:50000,maxApplications:1}}];
  const customer={id:'00000000-0000-4000-8300-000000000081',name:'Synthetic Customer',phone:'+62000000000',points:100,totalSpent:0,visitCount:0};
  const codes=[{id:'code-bundle',code:'Raw-Bundle',promotionId:'bundle'},{id:'code-bxgy',code:'Raw-BXGY',promotionId:'bxgy'},{id:'code-generic',code:'Raw-Generic',promotionId:'generic'},{id:'code-cap',code:'CUSTOMER-CAP',perCustomerLimit:1},{id:'code-assigned',code:'ASSIGNED',customerId:customer.id}].map(c=>({...base,type:'percentage',value:10,usageCount:0,...c}));
  const settings={taxEnabled:false,taxRate:0,roundingEnabled:false,roundingType:'none',allowNegativeStock:true,autoOpenShift:false,paymentMethods:[{id:'cash',label:'Tunai',isEnabled:true},{id:'qris',label:'QRIS',isEnabled:true}],receipt:{headerText:'Synthetic receipt',footerText:'Test only',showTax:false,showCashier:true}};
  const user={id:'00000000-0000-4000-8300-000000000091',displayName:'Synthetic Cashier',role:'admin',outletId:'00000000-0000-4000-8300-000000000090',permissions:['create_order','manage_promotions']};
  const snapshot={version:1,products,categories:[],bundles:[],customers:[customer],promotions,discountCodes:codes,loyaltyConditions:[],loyaltySettings:{enabled:true,tierEnabled:false,pointsPerThousand:1,redemptionRate:100},appSettings:settings,outletName:'Synthetic Outlet',outletCode:'SYN',salesmen:[]};
  page.__a24={products,promotions,codes,customer,snapshot,version:1,calls:[],writes:[],unexpected:[]};
  await page.unrouteAll({behavior:'wait'});
  await page.route('http://127.0.0.1:59999/api/v1/**',async route=>{
    const req=route.request(), path=req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0], method=req.method();
    page.__a24.calls.push({path,method});
    let data: any=[];
    if(path.includes('/auth/')) data={access:'SYNTHETIC-NON-TOKEN',refresh:'SYNTHETIC-NON-TOKEN',user};
    else if(path.endsWith('/sync/pull')) data={...snapshot,version:page.__a24.version};
    else if(path.split('?')[0].endsWith('/sync/version')) data={version:page.__a24.version};
    else if(path.endsWith('/sync/batch')) {page.__a24.writes.push(req.postDataJSON()); return route.fulfill({status:503,json:{error:'Synthetic retain-only transport'}});}
    else if(path.endsWith('/shifts/current')) data={id:'00000000-0000-4000-8300-000000000080',status:'open',startingCash:1100000,cashierId:user.id,outletId:user.outletId,openedAt:new Date().toISOString()};
    else if(path.endsWith('/products')) data=products;
    else if(path.endsWith('/promotions')) {if(method!=='GET')page.__a24.writes.push({path,method,body:req.postDataJSON()});data=promotions;}
    else if(path.includes('/promotions/')) {if(method!=='GET')page.__a24.writes.push({path,method,body:req.postDataJSON()});data={id:'saved-synthetic'};}
    else if(path.endsWith('/discount-codes')) data=codes;
    else if(path.endsWith('/sync/loyalty-preview')) data=[{conditionId:'loyalty-one',conditionName:'Customer gift',rewardProductIds:[R],products:[products[1]]}];
    else if(path.endsWith('/sync/customers/lookup')) data=[customer]; // A30: phone-only cashier lookup
    else if(path.endsWith('/customers')) data=[customer];
    else if(path.endsWith('/outlets')) data=[{id:user.outletId,name:'Synthetic Outlet',isActive:true}];
    else if(path.endsWith('/settings')) data=settings;
    return route.fulfill({status:200,json:{data,meta:{total:Array.isArray(data)?data.length:1,page:1,limit:50}}});
  });
  await page.goto('http://127.0.0.1:5183/');
  await page.evaluate(()=>{localStorage.clear();localStorage.setItem('mandalika.pos.refresh','SYNTHETIC-NON-TOKEN');});
  await page.reload();
  await page.setViewportSize({width:1440,height:1000});
  await passTerminalPicker(page);
  await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();
  return {fixture:'real apps; synthetic intercepted APIs; all external hosts blocked',products:products.length};
}

export const qualifyPos = async (page: ScenarioPage) =>{
 const result: any[]=[]; const assert=(v,m)=>{if(!v)throw Error(m)};
 page.__a24.products.forEach(p=>p.variants.forEach(v=>v.barcode=v.sku));
 const body=()=>page.locator('body').innerText();
 const fresh=async()=>{await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();for(const sku of ['SYN-M','SYN-L','TEST-M']){await page.getByRole('searchbox').fill(sku);await page.getByRole('searchbox').press('Enter');}await page.getByRole('button',{name:'Bayar',exact:true}).waitFor();};
 const panel=async()=>{await page.getByRole('button',{name:'Promo',exact:true}).click();};
 const direct=async(kind)=>{await panel();await page.getByRole('button').filter({hasText:'Synthetic '+kind}).last().click();};
 const code=async(kind)=>{await panel();await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-'+kind);await page.getByRole('button',{name:'Pakai',exact:true}).click();};
 const confirm=async(kind)=>{await page.getByRole('button',{name:kind==='Bundle'?/Synthetic Scent · MRp/:/Synthetic Tester · MRp/}).click();await page.getByRole('button',{name:'Terapkan',exact:true}).click();};
 for(const kind of ['Bundle','BXGY'])for(const owner of ['direct','linked']){
  await fresh();const before=await body();
  await (owner==='direct'?direct(kind):code(kind));
  assert(await page.getByRole('button',{name:'Batal',exact:true}).count()===1,owner+kind+' opens picker');
  await page.getByRole('button',{name:'Batal',exact:true}).click();
  await page.getByRole('heading',{name:'Promo & Kode Diskon'}).locator('..').getByRole('button',{name:'×',exact:true}).click();
  assert((await body())===before,'cancel must preserve cart and selection');
  await(owner==='direct'?direct(kind):code(kind));await confirm(kind);
  assert((await body()).includes('Hadiah Promo'),'confirm physical reward');
  result.push({kind,owner,cancelUnchanged:true,confirmed:await body()});
  if(owner==='linked'){
   await direct(kind);await confirm(kind);
   assert(!(await body()).includes('Raw-'+kind),'takeover drops code');
   result.push({kind,takeover:await body()});
  }
  await panel();
  const remove=page.getByRole('button',{name:/Hapus promo|Hapus kode/});
  if(await remove.count())await remove.first().click();
  else await page.getByRole('button',{name:/Hapus semua/}).last().click();
  if(await page.getByRole('heading',{name:'Promo & Kode Diskon'}).count())await page.getByRole('heading',{name:'Promo & Kode Diskon'}).locator('..').getByRole('button',{name:'×',exact:true}).click();
  assert(!(await body()).includes('Hadiah Promo'),'removal clears reward');
  result.push({kind,owner,removed:await body()});
 }
 page.__a24.qualification=result;return result;
}

export const posBoundaries = async (page: ScenarioPage) =>{
 const out: any[]=[]; const P=page.__a24.products[0].id;const legacy=page.__a24.promotions[3];legacy.type='bundle';legacy.bundleConfig={slots:[{productKeys:[P],quantity:1},{productKeys:[P+'|M'],quantity:1}],bundlePrice:50000,maxApplications:1};
 page.__a24.codes.push({...page.__a24.codes[0],id:'invalid-code',code:'Raw-Invalid',promotionId:'invalid'});
 const scan=async(sku)=>{await page.getByRole('searchbox').fill(sku);await page.getByRole('searchbox').press('Enter');};
 const fresh=async()=>{await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();for(const sku of ['SYN-M','SYN-L','TEST-M'])await scan(sku);};
 const apply=async(kind,owner)=>{await page.getByRole('button',{name:'Promo',exact:true}).click();if(owner==='direct')await page.getByRole('button').filter({hasText:'Synthetic '+kind}).last().click();else {await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-'+kind);await page.getByRole('button',{name:'Pakai',exact:true}).click();}await page.getByRole('button',{name:kind==='Bundle'?/Synthetic Scent · MRp/:/Synthetic Tester · MRp/}).click();await page.getByRole('button',{name:'Terapkan',exact:true}).click();};
 for(const kind of ['Bundle','BXGY'])for(const owner of ['direct','linked']){
  await fresh();await apply(kind,owner);
  // Remove both qualifying paid scent lines through the real cart controls.
  await page.getByRole('button',{name:'−',exact:true}).first().click();
  await page.getByRole('button',{name:'−',exact:true}).first().click();
  const edited=await page.locator('body').innerText();if(edited.includes('Hadiah Promo')||edited.includes('Kode:')||edited.includes('Promo:'))throw Error('participant edit left effect '+kind+owner);
  out.push({kind,owner,participantEdit:edited});
  await fresh();await apply(kind,owner);await page.getByRole('button',{name:'Hapus semua',exact:true}).click();if(await page.getByRole('button',{name:'Bayar',exact:true}).count())throw Error('clear left cart');out.push({kind,owner,clear:true});
 }
 await fresh();await page.getByRole('button',{name:'Promo',exact:true}).click();if(await page.getByRole('button').filter({hasText:'Invalid Legacy'}).last().isEnabled())throw Error('invalid direct enabled');
 await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-Invalid');await page.getByRole('button',{name:'Pakai',exact:true}).click();
 if(await page.getByRole('button',{name:'Terapkan',exact:true}).count())throw Error('invalid linked picker');
 await page.getByRole('heading',{name:'Promo & Kode Diskon'}).locator('..').getByRole('button',{name:'×',exact:true}).click();const invalid=await page.locator('body').innerText();if(invalid.includes('Hadiah Promo')||invalid.includes('Kode:'))throw Error('invalid effect');out.push({invalidRefused:invalid});
 page.__a24.posBoundaries=out;return out;
}

export const physicalQueue = async (page: ScenarioPage) =>{
 const out: any[]=[];const assert=(v,m)=>{if(!v)throw Error(m)};
 for(const kind of ['Bundle','BXGY'])for(const owner of ['direct','linked']){
  await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();
  for(const sku of ['SYN-M','SYN-L','TEST-M']){await page.getByRole('searchbox').fill(sku);await page.getByRole('searchbox').press('Enter');}
  const apply=async()=>{await page.getByRole('button',{name:'Promo',exact:true}).click();if(owner==='direct')await page.getByRole('button').filter({hasText:'Synthetic '+kind}).last().click();else{await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-'+kind);await page.getByRole('button',{name:'Pakai',exact:true}).click();}await page.getByRole('button',{name:kind==='Bundle'?/Synthetic Scent · MRp/:/Synthetic Tester · MRp/}).click();await page.getByRole('button',{name:'Terapkan',exact:true}).click();};
  await apply();
  await page.getByRole('button',{name:/^Promo(?: |$)/}).first().click();await page.getByRole('button',{name:'Hapus '+(owner==='direct'?'Synthetic ':'Raw-')+kind,exact:true}).click();
  await page.getByRole('heading',{name:'Promo & Kode Diskon'}).locator('..').getByRole('button',{name:'×',exact:true}).click();assert(!(await page.locator('body').innerText()).includes('Hadiah Promo'),'individual removal');
  await apply();await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button',{name:'QRIS',exact:true}).click();await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();await page.getByRole('heading',{name:'Pembayaran Berhasil'}).waitFor();
  const item=await page.evaluate(()=>JSON.parse(localStorage.getItem('mandalika.pos.outbox')!).at(-1)),p=item.payload;
  assert(p.items.reduce((n,i)=>n+i.quantity,0)===(kind==='Bundle'?3:4),'physical quantity');
  assert(p.items.filter(i=>i.rewardPromotionId===(kind==='Bundle'?'bundle':'bxgy')).length===1,'physical owner');
  assert(p.customerId===null,'guest identity');
  assert(owner==='direct'?p.promotionIds.length===1&&p.discountCodes.length===0:p.promotionIds.length===0&&p.discountCodes.length===1&&p.discountCodes[0]==='Raw-'+kind,'one usage identity');
  out.push({kind,owner,individualRemoval:true,item,receipt:await page.locator('body').innerText()});
 }
 // A01a: a sale whose outbox write fails must not look successful, and a double tap must queue exactly one.
 await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();
 await page.getByRole('searchbox').fill('SYN-M');await page.getByRole('searchbox').press('Enter');
 const outboxLength=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('mandalika.pos.outbox')||'[]').length);
 const before=await outboxLength();
 await page.evaluate(()=>{const orig=Storage.prototype.setItem;(window as any).__a01OrigSetItem=orig;Storage.prototype.setItem=function(k:string,v:string){if(k==='mandalika.pos.outbox')throw new DOMException('quota','QuotaExceededError');return orig.call(this,k,v)}});
 await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button',{name:'QRIS',exact:true}).click();
 const confirm=page.getByRole('button',{name:/^Konfirmasi Rp/});await confirm.click();
 await page.getByText(/BELUM tersimpan di perangkat/).first().waitFor();
 assert(await page.getByRole('heading',{name:'Pembayaran Berhasil'}).count()===0,'no success screen when the write failed');
 assert(await confirm.isEnabled(),'checkout stays open and retryable');
 assert(await outboxLength()===before,'failed write queued nothing');
 await page.evaluate(()=>{Storage.prototype.setItem=(window as any).__a01OrigSetItem});
 await confirm.dblclick();
 await page.getByRole('heading',{name:'Pembayaran Berhasil'}).waitFor();
 assert(await outboxLength()===before+1,'retry plus double tap queued exactly one sale');
 out.push({kind:'durable-write-failure',queuedBefore:before,queuedAfterRetry:before+1});
 page.__a24.physicalQueue=out;return out;
}

export const guestSales = async (page: ScenarioPage) =>{
 const results: any[]=[]; const assert=(v,m)=>{if(!v)throw Error(m)};
 const box=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('mandalika.pos.outbox')||'[]'));
 const fresh=async()=>{await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();await page.getByRole('searchbox').fill('SYN-M');await page.getByRole('searchbox').press('Enter');};
 const select=async()=>{await page.getByRole('textbox',{name:'Cari pelanggan dengan nomor telepon'}).fill(page.__a24.customer.phone);await page.getByRole('textbox',{name:'Cari pelanggan dengan nomor telepon'}).press('Enter');await page.getByRole('button').filter({hasText:'Synthetic Customer'}).click();};
 const clear=async()=>{await page.getByText('Synthetic Customer',{exact:true}).first().locator('../..').getByRole('button',{name:'×',exact:true}).click();};
 const panel=()=>page.getByRole('button',{name:/^Promo(?: |$)/}).first().click();
 const closePanel=()=>page.getByRole('heading',{name:'Promo & Kode Diskon'}).locator('..').getByRole('button',{name:'×',exact:true}).click();
 const applyCode=async(code)=>{await panel();await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill(code);await page.getByRole('button',{name:'Pakai',exact:true}).click();};
 const capture=async(name,method='qris',registered=false)=>{
  const before=(await box()).length;await page.getByRole('button',{name:'Bayar',exact:true}).click();
  if(!registered){assert(!(await page.locator('body').innerText()).includes('Tukar Poin Loyalti'),'guest redemption UI');assert(!(await page.locator('body').innerText()).includes('Hadiah Loyalti'),'guest reward UI');}
  if(method==='cash')await page.getByRole('spinbutton',{name:'Jumlah dibayar'}).fill('100000');else await page.getByRole('button',{name:'QRIS',exact:true}).click();
  await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();await page.getByRole('heading',{name:'Pembayaran Berhasil',exact:true}).waitFor();
  const queue=await box(), item=queue.at(-1), receipt=await page.locator('body').innerText();
  assert(queue.length===before+1,'capture creates exactly one op');assert(item.idempotencyKey.endsWith(':'+item.payload.orderUuid),'original identity');
  if(!registered){assert(item.payload.customerId===null&&item.payload.customerName===null,'guest null identity');assert(item.payload.pointsRedeemed===null,'guest redemption');assert(!item.payload.items.some(i=>i.rewardConditionId),'guest loyalty reward');assert(!receipt.includes('Synthetic Customer')&&!receipt.includes('+62000000000'),'guest receipt identity');}
  results.push({name,item,receipt});return item;
 };
 await fresh();await capture('guest-cash','cash');
 await fresh();await capture('guest-qris');
 await fresh();await panel();await page.getByRole('button').filter({hasText:'Generic Ten'}).last().click();const generic=await capture('guest-generic-direct');assert(generic.payload.promotionIds.includes('generic'),'generic direct retained');
 await fresh();await applyCode('raw-generic');const linked=await capture('guest-generic-linked');assert(linked.payload.discountCodes[0]==='Raw-Generic','raw generic code');
 for(const name of ['CUSTOMER-CAP','ASSIGNED']){await fresh();await applyCode(name);const ui=await page.locator('body').innerText();assert(ui.includes(name==='CUSTOMER-CAP'?'Pilih pelanggan':'pelanggan tertentu'),'customer eligibility message');await closePanel();const guest=await capture('guest-rejected-'+name);assert(guest.payload.discountCodes.length===0,'restricted code queued');}
 // Two independent benefits: direct generic + customer-assigned linked percentage.
 page.__a24.codes.find(c=>c.code==='ASSIGNED').promotionId='generic';
 // Use a distinct direct generic ID so stable-identity containment does not mask eligibility.
 page.__a24.promotions.push({...page.__a24.promotions[2],id:'generic-fixed',name:'Generic Fixed',type:'fixed',value:5000});
 await fresh();await select();await panel();await page.getByRole('button').filter({hasText:'Generic Fixed'}).last().click();await applyCode('ASSIGNED');await clear();
 await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button',{name:'QRIS',exact:true}).click();const n=(await box()).length;await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();
 assert((await box()).length===n,'ineligible benefit must not queue');assert((await page.locator('body').innerText()).includes('Kode diskon dibatalkan'),'revalidation feedback');
 await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();await page.getByRole('heading',{name:'Pembayaran Berhasil',exact:true}).waitFor();const cleared=(await box()).at(-1);assert(cleared.payload.customerId===null&&cleared.payload.discountCodes.length===0,'cleared guest identity/code');assert(cleared.payload.promotionIds.includes('generic-fixed'),'unrelated generic survives');results.push({name:'clear-assigned-reconfirm',item:cleared,receipt:await page.locator('body').innerText()});
 await fresh();await select();await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button').filter({hasText:'Customer gift'}).click();await page.getByRole('button',{name:/Synthetic Tester · M/}).click();await page.getByRole('button',{name:'Semua',exact:true}).last().click();await page.getByRole('heading',{name:'Konfirmasi Pembayaran'}).locator('..').getByRole('button',{name:'×',exact:true}).click();await clear();const loyaltyClear=await capture('clear-reward-points');assert(loyaltyClear.payload.items.length===1,'loyalty line removed');
 await fresh();await select();const registered=await capture('registered-preserved','qris',true);
 assert(registered.payload.customerId===page.__a24.customer.id&&registered.payload.customerName==='Synthetic Customer','registered identity preserved');
 // Browser reconstruction uses the same successful localStorage, no replacement engine or fixture payload.
 const identities=(await box()).map(i=>({key:i.idempotencyKey,payload:i.payload,created:i.clientCreatedAt}));await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();assert(JSON.stringify((await box()).map(i=>({key:i.idempotencyKey,payload:i.payload,created:i.clientCreatedAt})))===JSON.stringify(identities),'reconstruction changes captured facts');
 results.push({name:'reconstruction',identities});page.__a24.guestResults=results;return results;
}

export const addCustomer = async (page: ScenarioPage) =>{
 await page.reload();await page.getByRole('button',{name:'+ Baru',exact:true}).click();
 await page.getByRole('textbox',{name:'Nama pelanggan',exact:true}).fill('New Synthetic Customer');await page.getByRole('textbox',{name:'Nomor telepon pelanggan',exact:true}).fill('+44000000000');await page.getByRole('button',{name:'Simpan',exact:true}).click();
 await page.getByText('New Synthetic Customer',{exact:true}).first().waitFor();await page.getByRole('searchbox').fill('SYN-M');await page.getByRole('searchbox').press('Enter');await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button',{name:'QRIS',exact:true}).click();await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();await page.getByRole('heading',{name:'Pembayaran Berhasil'}).waitFor();
 const q=await page.evaluate(()=>JSON.parse(localStorage.getItem('mandalika.pos.outbox')!));const created=q.findLast(i=>i.type==='customer_create'),sale=q.at(-1);if(!created||sale.payload.customerId!==created.payload.customerId||sale.payload.customerName!=='New Synthetic Customer')throw Error('new customer sale identity');
 return {created,sale,receipt:await page.locator('body').innerText()};
}

export const posRecap = async (page: ScenarioPage) =>{
  const now=new Date().toISOString();
  const shift={id:'a26-active',outletId:'synthetic',outletName:'Synthetic Outlet',cashierId:'synthetic',cashierName:'Synthetic Cashier',openedAt:now,status:'open',startingCash:1100000,totalSales:401000,totalOrders:401,cashSales:401000,cardSales:0,qrisSales:0,transferSales:0};
  page.__a26pos={fail:null,offline:false,calls:[]};
  const routeHandler=async route=>{
    const path=route.request().url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    const query=Object.fromEntries((route.request().url().split('?')[1]||'').split('&').filter(Boolean).map(s=>s.split('=')));
    const pageNo=Number(query.page)||1,limit=Number(query.limit)||200,state=page.__a26pos;
    state.calls.push({path,page:pageNo,limit});
    if(state.offline||(state.fail===path&&pageNo===2))return route.fulfill({status:503,json:{error:'A26 unavailable page'}});
    if(path.endsWith('/current'))return route.fulfill({json:{data:shift}});
    const rows=path.endsWith('/shifts')?Array.from({length:251},(_,i)=>({...shift,id:`history-${i}`,cashierName:`Historical ${i}`,status:'closed',closedAt:now})):
      path.endsWith('/orders')?Array.from({length:401},(_,i)=>({id:`order-${i}`,status:'completed',paymentMethod:'cash',total:1000,subtotal:1000,discountAmount:0,taxAmount:0,createdAt:now,items:[{productId:'p',productName:'Synthetic Scent',variantSize:'M',quantity:1,subtotal:1000}]})):
      Array.from({length:401},(_,i)=>({id:`flow-${i}`,type:i%2?'out':'in',amount:100,description:`Synthetic flow ${i}`,createdAt:now}));
    return route.fulfill({json:{data:rows.slice((pageNo-1)*limit,pageNo*limit),meta:{page:pageNo,limit,total:rows.length}}});
  };
  for(const part of ['orders','shifts','cash-flows'])await page.route(`http://127.0.0.1:59999/api/v1/${part}**`,routeHandler);
  await page.getByRole('button',{name:'Rekapan',exact:true}).click();
  await page.getByText('201 Uang Masuk',{exact:true}).waitFor();
  const active=await page.locator('body').innerText();
  if(!active.replace(/\s/g,'').includes('Rp401.000'))throw new Error('active total not complete');
  await page.getByRole('button',{name:'Riwayat',exact:true}).last().click();
  await page.getByText('Historical 0',{exact:true}).waitFor();
  // Existing client history pagination still reaches rows past the old 50 cutoff.
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'›',exact:true}).click();
  await page.getByText('Historical 60',{exact:true}).first().click();
  await page.getByText('Kas Masuk',{exact:true}).waitFor();
  const historical=await page.locator('body').innerText();
  const cache=await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('mandalika.cache.rekap:')).map(k=>[k,localStorage.getItem(k)])));
  const activeData=JSON.parse(cache['mandalika.cache.rekap:current']!).data;
  const historyData=JSON.parse(cache['mandalika.cache.rekap:history']!).data;
  const selectedData=JSON.parse(cache['mandalika.cache.rekap:orders:history-60']!).data;
  if(activeData.orders.length!==401||activeData.flows.length!==401||historyData.length!==251||selectedData.orders.length!==401||selectedData.flows.length!==401)throw new Error('cache incomplete');
  page.__a26pos.fail='/api/v1/cash-flows';
  await page.getByText('Historical 60',{exact:true}).first().click();
  await page.getByText('Data belum diperbarui — menampilkan snapshot lengkap terakhir',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Rekapan',exact:true}).last().click();
  await page.getByText('Data belum diperbarui — menampilkan snapshot lengkap terakhir',{exact:true}).waitFor();
  const failedCache=await page.evaluate(()=>localStorage.getItem('mandalika.cache.rekap:current'));
  if(failedCache!==cache['mandalika.cache.rekap:current'])throw new Error('partial cache overwritten');
  // Unmount/remount the real panel, retaining successful storage and failing every recap request.
  page.__a26pos.offline=true;
  await page.getByRole('button',{name:'✕ Kembali ke Kasir',exact:true}).click();
  await page.getByRole('button',{name:'Menu',exact:true}).click();
  await page.getByRole('button',{name:'Rekapan',exact:true}).click();
  await page.getByText('201 Uang Masuk',{exact:true}).waitFor();
  await page.getByText('Data belum diperbarui — menampilkan snapshot lengkap terakhir',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Riwayat',exact:true}).last().click();
  await page.getByText('Historical 0',{exact:true}).waitFor();
  const finalCache=await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('mandalika.cache.rekap:')).map(k=>[k,localStorage.getItem(k)])));
  if(JSON.stringify(cache)!==JSON.stringify(finalCache))throw new Error('failed/offline reads modified cache');
  return {active,historical,cacheCounts:{activeOrders:401,activeFlows:401,history:251,historicalOrders:401,historicalFlows:401},failure:'visible stale notice; unchanged complete bytes',reconstruction:'same storage; actual panel remount offline',calls:page.__a26pos.calls};
}

// Auto-pull: a version bump is pulled by itself, but only while the cart is empty. Time is driven with
// page.clock; each step lets the real (intercepted) fetches settle before the fake clock moves on.
export const posAutoPull = async (page: ScenarioPage) => {
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m) };
  const count = (suffix: string) => page.__a24.calls.filter((c: any) => c.path.endsWith(suffix)).length;
  const pulls = () => count('/sync/pull');
  const body = () => page.locator('body').innerText();
  await page.evaluate(() => { localStorage.setItem('pos_cardStock', '1'); });
  await page.clock.install({ time: Date.now() });
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Scent/ }).first().waitFor(); // the stock line changes the card's accessible name
  const advance = async (seconds: number, until: () => Promise<boolean> | boolean = () => false) => {
    for (let i = 0; i < seconds; i++) {
      if (await until()) return true;
      await page.clock.runFor(1000);
      await page.waitForTimeout(40);
    }
    return until();
  };
  const out: any[] = [];

  // 1. Empty cart: a bump raises the chip, then exactly one pull clears it by itself.
  const n0 = pulls();
  assert(!(await body()).includes('77'), 'new stock is not on screen before the pull');
  page.__a24.products[0].variants[0].stock = 77; // real data change in the pull body
  page.__a24.version = 2;
  assert(await advance(60, async () => (await body()).includes('Pembaruan tersedia')), 'the chip shows the raised wall');
  assert(await advance(90, () => pulls() === n0 + 1), 'one automatic pull for the bump');
  assert(await advance(30, async () => (await body()).includes('Tersinkron')), 'the chip clears after the pull');
  assert((await body()).includes('77'), 'the new stock reaches the screen after the pull');
  await advance(180);
  assert(pulls() === n0 + 1, 'no further pulls once synced');
  out.push({ step: 'bump with empty cart', pulls: pulls() - n0 });

  // 2. A cart line blocks the pull however long we wait.
  await page.getByRole('searchbox').fill('SYN-M');
  await page.getByRole('searchbox').press('Enter');
  const n1 = pulls();
  page.__a24.version = 3;
  assert(await advance(60, async () => (await body()).includes('Pembaruan tersedia')), 'the chip shows the second bump');
  await advance(240);
  assert(pulls() === n1, 'no pull while the cart has an item');
  assert((await body()).includes('Pembaruan tersedia'), 'the chip stays raised while deferred');
  out.push({ step: 'bump with item in cart', pulls: pulls() - n1 });

  // 3. Clearing the cart lets it through.
  await page.getByRole('button', { name: 'Hapus semua', exact: true }).click();
  assert(await advance(60, () => pulls() === n1 + 1), 'one pull after the cart is cleared');
  assert(await advance(30, async () => (await body()).includes('Tersinkron')), 'the chip clears after the deferred pull');
  out.push({ step: 'cart cleared', pulls: pulls() - n1 });
  return out;
};

