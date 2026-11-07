// Ordinary imported scenario functions, converted from the accepted manual scripts.
import type { ScenarioPage } from './fixture'
import { BAYAR_SHOT_VIEWPORTS, POS_SHOT_VIEWPORTS, SHOT_VIEWPORTS, captureShot, type ShotViewport } from './shots'

// A04: an outlet-less (admin) account on an unbound terminal must pick the outlet once. The
// real picker is clicked here, exactly as a person would; the choice is then stored in the
// app's own durable terminal binding, so later reloads in the same scenario do not ask again.
export const passTerminalPicker = async (page: ScenarioPage, outletName = 'Synthetic Outlet') => {
  const product = page.getByRole('button', { name: /^Synthetic Scent/ }).first();
  const picker = page.getByRole('heading', { name: 'Pilih outlet terminal ini' });
  await picker.or(product).first().waitFor();
  if (await picker.isVisible()) {
    await page.getByRole('button', { name: outletName, exact: true }).click();
  }
};

// Optional variants of the fixture: `user` overrides fields of the signed-in user (e.g. a cashier), `extraRoute`
// answers API calls first (return true when it fulfilled the route), `netDown` on page.__a24 aborts every API call.
export interface PosSetupOpts {
  user?: Record<string, unknown>;
  extraRoute?: (route: any, path: string, method: string, req: any) => Promise<boolean>;
  /** C3: seed an outlet giveaway (a stocked bag product in the catalog + `outletGiveaway` in the pull bundle). */
  giveaway?: { stock: number };
  /** C6: the server setting `splitTenderEnabled` (omitted = the key is absent, as on a backend without C6a). */
  splitTender?: boolean;
  /** Promo auto-apply: seed one Otomatis 10% promotion (non-combinable, no minimum). */
  autoPromo?: boolean;
  /** Kaca P6a: N extra single-size products (Filler 01..) so the catalogue scrolls. */
  fillerProducts?: number;
}

export const setupPos = async (page: ScenarioPage, opts: PosSetupOpts = {}) => {
  const P = '00000000-0000-4000-8300-000000000001';
  const R = '00000000-0000-4000-8300-000000000002';
  const products: any[] = [{id:P,name:'Synthetic Scent',isActive:true,variants:[{size:'M',sku:'SYN-M',price:100000,stock:100},{size:'L',sku:'SYN-L',price:120000,stock:100}]},{id:R,name:'Synthetic Tester',isActive:true,variants:[{size:'M',sku:'TEST-M',price:20000,stock:100},{size:'L',sku:'TEST-L',price:25000,stock:100}]}];
  for(let i=1;i<=(opts.fillerProducts??0);i++)products.push({id:'00000000-0000-4000-8400-'+String(i).padStart(12,'0'),name:'Filler '+String(i).padStart(2,'0'),isActive:true,variants:[{size:'STD',sku:'FILL-'+i,price:50000,stock:100}]});
  products.forEach(p=>p.variants.forEach(v=>v.barcode=v.sku));
  const base={value:0,isActive:true,combinable:true,codeOnly:false,minPurchase:0};
  const promotions: any[] =[{...base,id:'bundle',name:'Synthetic Bundle',type:'bundle',bundleConfig:{slots:[{productKeys:[P],quantity:1},{productKeys:[R],quantity:1}],bundlePrice:105000,maxApplications:1}},{...base,id:'bxgy',name:'Synthetic BXGY',type:'buy_x_get_y',bxgyConfig:{buyProductIds:[P],getProductIds:[R],buyQuantity:1,getQuantity:1,getDiscountKind:'percentage',getDiscountValue:50,maxApplications:1}},{...base,id:'generic',name:'Generic Ten',type:'percentage',value:10},{...base,id:'invalid',name:'Invalid Legacy',type:'bundle',bundleConfig:{slots:[{productKeys:[P],quantity:1},{productKeys:[P+'|M'],quantity:1}],bundlePrice:50000,maxApplications:1}}];
  if (opts.autoPromo) promotions.push({...base,id:'auto-ten',name:'Otomatis Sepuluh',type:'percentage',value:10,combinable:false,autoApply:true,createdAt:'2026-01-01T00:00:00Z'});
  const customer={id:'00000000-0000-4000-8300-000000000081',name:'Synthetic Customer',phone:'+62000000000',points:100,totalSpent:0,visitCount:0};
  const codes=[{id:'code-bundle',code:'Raw-Bundle',promotionId:'bundle'},{id:'code-bxgy',code:'Raw-BXGY',promotionId:'bxgy'},{id:'code-generic',code:'Raw-Generic',promotionId:'generic'},{id:'code-cap',code:'CUSTOMER-CAP',perCustomerLimit:1},{id:'code-assigned',code:'ASSIGNED',customerId:customer.id}].map(c=>({...base,type:'percentage',value:10,usageCount:0,...c}));
  const settings={taxEnabled:false,taxRate:0,roundingEnabled:false,roundingType:'none',allowNegativeStock:true,autoOpenShift:false,paymentMethods:[{id:'cash',label:'Tunai',isEnabled:true},{id:'qris',label:'QRIS',isEnabled:true}],receipt:{headerText:'Synthetic receipt',footerText:'Test only',showTax:false,showCashier:true}};
  if (opts.splitTender !== undefined) (settings as any).splitTenderEnabled=opts.splitTender;
  const user={id:'00000000-0000-4000-8300-000000000091',displayName:'Synthetic Cashier',role:'admin',outletId:'00000000-0000-4000-8300-000000000090',permissions:['create_order','manage_promotions'],...opts.user};
  const snapshot={version:1,products,categories:[],bundles:[],customers:[customer],promotions,discountCodes:codes,loyaltyConditions:[],loyaltySettings:{enabled:true,tierEnabled:false,pointsPerThousand:1,redemptionRate:100},appSettings:settings,outletName:'Synthetic Outlet',outletCode:'SYN',salesmen:[]};
  if (opts.giveaway) {
    const bag = {id:'00000000-0000-4000-8300-0000000000b9',name:'Synthetic Bag',isActive:true,variants:[{size:'STD',sku:'BAG-STD',barcode:'BAG-STD',price:0,stock:opts.giveaway.stock}]};
    products.push(bag);
    (snapshot as any).outletGiveaway={productId:bag.id,variantSize:'STD',productName:bag.name,stock:opts.giveaway.stock};
  }
  page.__a24={products,promotions,codes,customer,snapshot,version:1,calls:[],writes:[],unexpected:[]};
  await page.unrouteAll({behavior:'wait'});
  await page.route('http://127.0.0.1:59999/api/v1/**',async route=>{
    const req=route.request(), path=req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0], method=req.method();
    page.__a24.calls.push({path,method});
    if(page.__a24.netDown) return route.abort('failed');
    if(opts.extraRoute&&await opts.extraRoute(route,path,method,req)) return;
    let data: any=[];
    if(path.includes('/auth/')) data={access:'SYNTHETIC-NON-TOKEN',refresh:'SYNTHETIC-NON-TOKEN',user};
    else if(path.endsWith('/sync/pull')) data={...snapshot,version:page.__a24.version,...(page.__a24.stockSeq===undefined?{}:{stockSeq:page.__a24.stockSeq})};
    else if(path.split('?')[0].endsWith('/sync/version')) data={version:page.__a24.version,...(page.__a24.stockSeq===undefined?{}:{stockSeq:page.__a24.stockSeq})};
    else if(path.endsWith('/sync/batch')&&page.__a24.ackBatch) {const sent=req.postDataJSON(); page.__a24.writes.push(sent); const results=sent.items.map((i:any)=>({idempotencyKey:i.idempotencyKey,status:'ok',...(i.type==='order'?{stockSeq:++page.__a24.stockSeq}:{})})); return route.fulfill({status:200,json:{data:{processed:results.length,version:page.__a24.version,stockSeq:page.__a24.stockSeq,results}}});}
    else if(path.endsWith('/sync/batch')) {page.__a24.writes.push(req.postDataJSON()); return route.fulfill({status:503,json:{error:'Synthetic retain-only transport'}});}
    else if(path.endsWith('/shifts/current')) data={id:'00000000-0000-4000-8300-000000000080',status:'open',startingCash:1100000,cashierId:user.id,outletId:user.outletId,openedAt:new Date().toISOString()};
    else if(path.endsWith('/products')) {const q=new URL(req.url()).searchParams;const n=Number(q.get('page'))||1,lim=Number(q.get('limit'))||50;return route.fulfill({status:200,json:{data:products.slice((n-1)*lim,n*lim),meta:{total:products.length,page:n,limit:lim}}});}
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
  await page.getByRole('button',{name:/^Synthetic Scent/}).first().waitFor();
  return {fixture:'real apps; synthetic intercepted APIs; all external hosts blocked',products:products.length};
}

export const qualifyPos = async (page: ScenarioPage) =>{
 const result: any[]=[]; const assert=(v,m)=>{if(!v)throw Error(m)};
 page.__a24.products.forEach(p=>p.variants.forEach(v=>v.barcode=v.sku));
 const body=()=>page.locator('body').innerText();
 const fresh=async()=>{await page.evaluate(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('mandalika.pos.openCart.'))localStorage.removeItem(k);});await page.reload();await page.getByRole('button',{name:/^Synthetic Scent/}).first().waitFor();for(const sku of ['SYN-M','SYN-L','TEST-M']){await page.getByRole('searchbox').fill(sku);await page.getByRole('searchbox').press('Enter');}await page.getByRole('button',{name:'Bayar',exact:true}).waitFor();};
 const panel=async()=>{await page.getByRole('button',{name:'Promo & Diskon',exact:true}).click();};
 const direct=async(kind)=>{await panel();await page.getByRole('button').filter({hasText:'Synthetic '+kind}).last().click();};
 const code=async(kind)=>{await panel();await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-'+kind);await page.getByRole('button',{name:'Pakai',exact:true}).click();};
 const confirm=async(kind)=>{if(process.env.A34C_RUN_DIR)await captureShot(page,'p7-picker-'+kind.toLowerCase(),POS_SHOT_VIEWPORTS);await page.getByRole('button',{name:kind==='Bundle'?/Synthetic Scent · MRp/:/Synthetic Tester · MRp/}).click();await page.getByRole('button',{name:'Terapkan',exact:true}).click();};
 for(const kind of ['Bundle','BXGY'])for(const owner of ['direct','linked']){
  await fresh();const before=await body();
  await (owner==='direct'?direct(kind):code(kind));
  assert(await page.getByRole('button',{name:'Batal',exact:true}).count()===1,owner+kind+' opens picker');
  await page.getByRole('button',{name:'Batal',exact:true}).click();
  await page.getByRole('heading',{name:'Promo & Diskon'}).locator('..').getByRole('button',{name:'Tutup',exact:true}).click();
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
  const panelRoot=page.getByRole('heading',{name:'Promo & Diskon'}).locator('../..');
  const remove=panelRoot.getByRole('button',{name:/^Hapus (?!semua)/});
  if(await remove.count()===1)await remove.first().click();
  else await panelRoot.getByRole('button',{name:'Hapus semua',exact:true}).click();
  if(await page.getByRole('heading',{name:'Promo & Diskon'}).count())await page.getByRole('heading',{name:'Promo & Diskon'}).locator('..').getByRole('button',{name:'Tutup',exact:true}).click();
  assert(!(await body()).includes('Hadiah Promo'),'removal clears reward');
  result.push({kind,owner,removed:await body()});
 }
 page.__a24.qualification=result;return result;
}

export const posBoundaries = async (page: ScenarioPage) =>{
 const out: any[]=[]; const P=page.__a24.products[0].id;const legacy=page.__a24.promotions[3];legacy.type='bundle';legacy.bundleConfig={slots:[{productKeys:[P],quantity:1},{productKeys:[P+'|M'],quantity:1}],bundlePrice:50000,maxApplications:1};
 page.__a24.codes.push({...page.__a24.codes[0],id:'invalid-code',code:'Raw-Invalid',promotionId:'invalid'});
 const scan=async(sku)=>{await page.getByRole('searchbox').fill(sku);await page.getByRole('searchbox').press('Enter');};
 const fresh=async()=>{await page.evaluate(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('mandalika.pos.openCart.'))localStorage.removeItem(k);});await page.reload();await page.getByRole('button',{name:/^Synthetic Scent/}).first().waitFor();for(const sku of ['SYN-M','SYN-L','TEST-M'])await scan(sku);};
 const apply=async(kind,owner)=>{await page.getByRole('button',{name:'Promo & Diskon',exact:true}).click();if(owner==='direct')await page.getByRole('button').filter({hasText:'Synthetic '+kind}).last().click();else {await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-'+kind);await page.getByRole('button',{name:'Pakai',exact:true}).click();}await page.getByRole('button',{name:kind==='Bundle'?/Synthetic Scent · MRp/:/Synthetic Tester · MRp/}).click();await page.getByRole('button',{name:'Terapkan',exact:true}).click();};
 for(const kind of ['Bundle','BXGY'])for(const owner of ['direct','linked']){
  await fresh();await apply(kind,owner);
  // Remove both qualifying paid scent lines through the real cart controls.
  await page.getByRole('button',{name: 'Kurangi', exact: true}).first().click();
  await page.getByRole('button',{name: 'Kurangi', exact: true}).first().click();
  // The reducer drops a promo whose participants are gone in a post-commit effect (CashierScreen "Whole-owner cleanup"),
  // so the DOM clears one render after the last Kurangi click: wait for it instead of reading the body at once.
  await page.waitForFunction(()=>!/Hadiah Promo|Kode:/.test(document.body.innerText),undefined,{timeout:5000}).catch(()=>{});
  const edited=await page.locator('body').innerText();if(edited.includes('Hadiah Promo')||edited.includes('Kode:'))throw Error('participant edit left effect '+kind+owner);if((await page.getByRole('button',{name:/Hapus promo|Hapus kode/}).count())!==0)throw Error('no leftover promo line');
  out.push({kind,owner,participantEdit:edited});
  await fresh();await apply(kind,owner);await page.getByRole('button',{name: 'Kosongkan', exact: true}).click();await page.getByRole('dialog').filter({hasText:'Kosongkan keranjang?'}).getByRole('button',{name:'Kosongkan',exact:true}).click();if(await page.getByRole('button',{name:'Bayar',exact:true}).count())throw Error('clear left cart');out.push({kind,owner,clear:true});
 }
 await fresh();await page.getByRole('button',{name:'Promo & Diskon',exact:true}).click();if(await page.getByRole('button').filter({hasText:'Invalid Legacy'}).last().isEnabled())throw Error('invalid direct enabled');
 await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-Invalid');await page.getByRole('button',{name:'Pakai',exact:true}).click();
 if(await page.getByRole('button',{name:'Terapkan',exact:true}).count())throw Error('invalid linked picker');
 await page.getByRole('heading',{name:'Promo & Diskon'}).locator('..').getByRole('button',{name:'Tutup',exact:true}).click();const invalid=await page.locator('body').innerText();if(invalid.includes('Hadiah Promo')||invalid.includes('Kode Promo:'))throw Error('invalid effect');out.push({invalidRefused:invalid});
 page.__a24.posBoundaries=out;return out;
}

export const physicalQueue = async (page: ScenarioPage) =>{
 const out: any[]=[];const assert=(v,m)=>{if(!v)throw Error(m)};
 for(const kind of ['Bundle','BXGY'])for(const owner of ['direct','linked']){
  await page.reload();await page.getByRole('button',{name:/^Synthetic Scent/}).first().waitFor();
  for(const sku of ['SYN-M','SYN-L','TEST-M']){await page.getByRole('searchbox').fill(sku);await page.getByRole('searchbox').press('Enter');}
  const apply=async()=>{await page.getByRole('button',{name:'Promo & Diskon',exact:true}).click();if(owner==='direct')await page.getByRole('button').filter({hasText:'Synthetic '+kind}).last().click();else{await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-'+kind);await page.getByRole('button',{name:'Pakai',exact:true}).click();}await page.getByRole('button',{name:kind==='Bundle'?/Synthetic Scent · MRp/:/Synthetic Tester · MRp/}).click();await page.getByRole('button',{name:'Terapkan',exact:true}).click();};
  await apply();
  await page.getByRole('button',{name:/^Promo(?: |$)/}).first().click();await page.getByRole('button',{name:'Hapus '+(owner==='direct'?'Synthetic ':'Raw-')+kind,exact:true}).click();
  await page.getByRole('heading',{name:'Promo & Diskon'}).locator('..').getByRole('button',{name:'Tutup',exact:true}).click();assert(!(await page.locator('body').innerText()).includes('Hadiah Promo'),'individual removal');
  await apply();await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button',{name:'QRIS',exact:true}).click();await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();await page.getByRole('heading',{name:'Pembayaran Berhasil'}).waitFor();
  const item=await page.evaluate(()=>JSON.parse(localStorage.getItem('mandalika.pos.outbox')!).at(-1)),p=item.payload;
  assert(p.items.reduce((n,i)=>n+i.quantity,0)===(kind==='Bundle'?3:4),'physical quantity');
  assert(p.items.filter(i=>i.rewardPromotionId===(kind==='Bundle'?'bundle':'bxgy')).length===1,'physical owner');
  assert(p.customerId===null,'guest identity');
  assert(owner==='direct'?p.promotionIds.length===1&&p.discountCodes.length===0:p.promotionIds.length===0&&p.discountCodes.length===1&&p.discountCodes[0]==='Raw-'+kind,'one usage identity');
  out.push({kind,owner,individualRemoval:true,item,receipt:await page.locator('body').innerText()});
 }
 // A01a: a sale whose outbox write fails must not look successful, and a double tap must queue exactly one.
 await page.reload();await page.getByRole('button',{name:/^Synthetic Scent/}).first().waitFor();
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
 const fresh=async()=>{await page.evaluate(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('mandalika.pos.openCart.'))localStorage.removeItem(k);});await page.reload();await page.getByRole('button',{name:/^Synthetic Scent/}).first().waitFor();await page.getByRole('searchbox').fill('SYN-M');await page.getByRole('searchbox').press('Enter');};
 const select=async()=>{await page.getByRole('button',{name:'+ Pelanggan',exact:true}).click();await page.getByRole('textbox',{name:'Cari pelanggan dengan nomor telepon'}).fill(page.__a24.customer.phone);await page.getByRole('textbox',{name:'Cari pelanggan dengan nomor telepon'}).press('Enter');await page.getByRole('button').filter({hasText:'Synthetic Customer'}).click();};
 const clear=async()=>{await page.getByRole('button',{name:'Lepas',exact:true}).click();const ok=page.getByRole('dialog').getByRole('button',{name:'Lanjutkan',exact:true});if(await ok.count())await ok.click();};
 const panel=()=>page.getByRole('button',{name:/^Promo(?: |$)/}).first().click();
 const closePanel=()=>page.getByRole('heading',{name:'Promo & Diskon'}).locator('..').getByRole('button',{name:'Tutup',exact:true}).click();
 const applyCode=async(code)=>{await panel();await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill(code);await page.getByRole('button',{name:'Pakai',exact:true}).click();};
 const capture=async(name,method='qris',registered=false)=>{
  const before=(await box()).length;await page.getByRole('button',{name:'Bayar',exact:true}).click();
  if(!registered){assert(!(await page.locator('body').innerText()).includes('Tukar Poin Loyalti'),'guest redemption UI');assert(!(await page.locator('body').innerText()).includes('Hadiah Loyalti'),'guest reward UI');assert(!(await page.locator('body').innerText()).includes('Hadiah & Poin'),'guest reward card');assert((await page.getByRole('button',{name:/^Tukar [0-9]+ poin/}).count())===0,'guest points chip');}
  if(method==='cash'){const amt=page.getByRole('textbox',{name:'Jumlah dibayar'});await amt.fill('100000');assert((await amt.inputValue()).replace(/\s/g,' ')==='Rp 100.000','cash amount is formatted while typing');if(!registered)await captureShot(page,'p6b-bayar-cash',['pos-a9',...BAYAR_SHOT_VIEWPORTS]);}else await page.getByRole('button',{name:'QRIS',exact:true}).click();
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
 assert((await box()).length===n,'ineligible benefit must not queue');assert((await page.locator('body').innerText()).includes('tidak berlaku lagi'),'revalidation feedback');
 await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();await page.getByRole('heading',{name:'Pembayaran Berhasil',exact:true}).waitFor();const cleared=(await box()).at(-1);assert(cleared.payload.customerId===null&&cleared.payload.discountCodes.length===0,'cleared guest identity/code');assert(cleared.payload.promotionIds.includes('generic-fixed'),'unrelated generic survives');results.push({name:'clear-assigned-reconfirm',item:cleared,receipt:await page.locator('body').innerText()});
 await fresh();await select();await page.getByRole('button',{name:'Bayar',exact:true}).click();await bayarFit(page,'f2-bayar-customer-reward');await page.getByRole('button').filter({hasText:'Customer gift'}).click();await page.getByRole('button',{name:/Synthetic Tester · M/}).click();await page.getByRole('button',{name:/^Tukar [0-9]+ poin/}).click();await page.getByRole('button',{name:'Semua',exact:true}).last().click();await page.getByRole('heading',{name:'Bayar',exact:true}).locator('..').getByRole('button',{name:'Tutup'}).click();await clear();const loyaltyClear=await capture('clear-reward-points');assert(loyaltyClear.payload.items.length===1,'loyalty line removed');
 await fresh();await select();const registered=await capture('registered-preserved','qris',true);
 assert(registered.payload.customerId===page.__a24.customer.id&&registered.payload.customerName==='Synthetic Customer','registered identity preserved');
 // Browser reconstruction uses the same successful localStorage, no replacement engine or fixture payload.
 const identities=(await box()).map(i=>({key:i.idempotencyKey,payload:i.payload,created:i.clientCreatedAt}));await page.reload();await page.getByRole('button',{name:/^Synthetic Scent/}).first().waitFor();assert(JSON.stringify((await box()).map(i=>({key:i.idempotencyKey,payload:i.payload,created:i.clientCreatedAt})))===JSON.stringify(identities),'reconstruction changes captured facts');
 results.push({name:'reconstruction',identities});page.__a24.guestResults=results;return results;
}

export const addCustomer = async (page: ScenarioPage) =>{
 await page.reload();await page.getByRole('button',{name:'+ Pelanggan',exact:true}).click();await page.getByRole('button',{name:'+ Baru',exact:true}).click();
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
  await page.getByRole('button',{name:'Rekap Shift',exact:true}).click();
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
  await page.getByRole('button',{name:'Rekap Shift',exact:true}).click();
  await page.getByText('201 Uang Masuk',{exact:true}).waitFor();
  await page.getByText('Data belum diperbarui — menampilkan snapshot lengkap terakhir',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Riwayat',exact:true}).last().click();
  await page.getByText('Historical 0',{exact:true}).waitFor();
  const finalCache=await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('mandalika.cache.rekap:')).map(k=>[k,localStorage.getItem(k)])));
  const sortedKeys=(o:Record<string,unknown>)=>JSON.stringify(Object.entries(o).sort(([a],[b])=>a<b?-1:a>b?1:0)); // localStorage enumeration order is not stable; compare keys and bytes, not order
  if(sortedKeys(cache)!==sortedKeys(finalCache)){const diff=Object.keys({...cache,...finalCache}).filter(k=>cache[k]!==finalCache[k]).map(k=>{const a=cache[k]??'',b=finalCache[k]??'';let i=0;while(i<a.length&&a[i]===b[i])i++;return `${k} len ${a.length}->${b.length} first diff @${i}: ${a.slice(Math.max(0,i-60),i+60)} => ${b.slice(Math.max(0,i-60),i+60)}`});throw new Error('failed/offline reads modified cache: '+diff.join(' | '))}
  if(process.env.A34C_RUN_DIR){
    // Kaca P3 evidence (display only), last so it cannot disturb the checks above: blind count ON after a reload,
    // then the denomination sheet and the selisih confirm (cancelled again, nothing is closed).
    page.__a26pos.offline=false;
    await page.addInitScript(()=>{localStorage.setItem('pos_blindCount','1')}); // runs after the spec's '0' init script
    await page.reload();
    await page.getByRole('button',{name:'Menu',exact:true}).click();
    await page.getByRole('button',{name:'Rekap Shift',exact:true}).click();
    await page.getByText('201 Uang Masuk',{exact:true}).waitFor();
    await captureShot(page,'p3-recap-blind',POS_SHOT_VIEWPORTS);
    await page.getByRole('button',{name:'Hitung lembar',exact:true}).first().click();
    await page.getByTestId('denomination-sheet').waitFor();
    await page.getByLabel('Jumlah lembar Rp 100.000').fill('3');
    await captureShot(page,'p3-denomination',POS_SHOT_VIEWPORTS);
    await page.getByTestId('denomination-sheet').getByRole('button',{name:'Batal',exact:true}).click();
    await page.getByLabel('Terhitung').nth(0).fill('1000000');await page.getByLabel('Terhitung').nth(1).fill('5000');
    await captureShot(page,'p3-recap-counted',POS_SHOT_VIEWPORTS);
    await page.getByRole('button',{name:'Tutup Shift',exact:true}).last().click();
    await page.getByRole('alert').filter({hasText:'Ada selisih'}).waitFor();
    await captureShot(page,'p3-recap-selisih-confirm',POS_SHOT_VIEWPORTS);
    await page.getByRole('button',{name:'Batal',exact:true}).last().click();
  }
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
  assert(await advance(60, async () => (await body()).includes('Data baru siap')), 'the chip shows the raised wall');
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
  assert(await advance(60, async () => (await body()).includes('Data baru siap')), 'the chip shows the second bump');
  await advance(240);
  assert(pulls() === n1, 'no pull while the cart has an item');
  assert((await body()).includes('Data baru siap'), 'the chip stays raised while deferred');
  out.push({ step: 'bump with item in cart', pulls: pulls() - n1 });

  // 3. Clearing the cart lets it through.
  await page.getByRole('button', { name: 'Kosongkan', exact: true }).click();
  await page.getByRole('dialog').filter({ hasText: 'Kosongkan keranjang?' }).getByRole('button', { name: 'Kosongkan', exact: true }).click();
  assert(await advance(60, () => pulls() === n1 + 1), 'one pull after the cart is cleared');
  assert(await advance(30, async () => (await body()).includes('Tersinkron')), 'the chip clears after the deferred pull');
  out.push({ step: 'cart cleared', pulls: pulls() - n1 });
  return out;
};

// A15 phase B: another tablet's sale moves only the outlet stock counter (the content version is unchanged).
// The POS pulls once by itself, silently (no update chip), and does not pull again. Omitting __a24.stockSeq
// keeps every other scenario on the old-server path.
export const posStockDrift = async (page: ScenarioPage) => {
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m) };
  const pulls = () => page.__a24.calls.filter((c: any) => c.path.endsWith('/sync/pull')).length;
  const body = () => page.locator('body').innerText();
  page.__a24.stockSeq = 10; // from here on the fixture server sends a counter, so the boot pull binds the snapshot
  await page.evaluate(() => { localStorage.setItem('pos_cardStock', '1'); });
  await page.clock.install({ time: Date.now() });
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Scent/ }).first().waitFor();
  const advance = async (seconds: number, until: () => Promise<boolean> | boolean = () => false) => {
    for (let i = 0; i < seconds; i++) {
      if (await until()) return true;
      await page.clock.runFor(1000);
      await page.waitForTimeout(40);
    }
    return until();
  };
  let sawChip = false;
  const n0 = pulls();
  // The card's own "Stok N" figure (the sum over the product's variants), compared as a whole number.
  const card = () => page.getByRole('button', { name: /Synthetic Scent/ }).first().innerText();
  const figure = async () => Number(/Stok (\d+)/.exec(await card())?.[1]);
  const before = page.__a24.products[0].variants.reduce((t: number, v: any) => t + v.stock, 0);
  assert((await figure()) === before, 'the card shows the old stock figure before the pull');
  page.__a24.products[0].variants[0].stock -= 3;
  page.__a24.stockSeq = 11; // another tablet sold; version unchanged
  assert(await advance(120, async () => { const t = await body(); if (t.includes('Data baru siap')) sawChip = true; return pulls() === n0 + 1; }), 'one automatic stock pull');
  assert(await advance(30, async () => (await figure()) === before - 3), 'the card shows exactly the new stock figure after the pull');
  await advance(420, async () => { if ((await body()).includes('Data baru siap')) sawChip = true; return false; });
  assert(!sawChip, 'a stock-only pull never raises the update chip');
  assert(pulls() === n0 + 1, 'no further pulls once the counter is covered');
  // An own sale acked at local seq + 1 is explained by its settling entry: no pull.
  const n1 = pulls();
  page.__a24.ackBatch = true;
  await page.getByRole('searchbox').fill('SYN-M');
  await page.getByRole('searchbox').press('Enter');
  await page.getByRole('button', { name: 'Bayar', exact: true }).click();
  await page.getByRole('button', { name: 'QRIS', exact: true }).click();
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click();
  await page.getByRole('heading', { name: 'Pembayaran Berhasil', exact: true }).waitFor();
  assert(await advance(60, () => page.__a24.stockSeq === 12), 'the sale was acked with the next counter value');
  await advance(420);
  assert(pulls() === n1, 'an own sale acked at local seq + 1 causes no pull');
  return [{ step: 'foreign stock bump', pulls: n1 - n0 }, { step: 'own sale ack', pulls: pulls() - n1 }];
};

// Kaca F2 (W2-10): with a customer and the reward row, the method switch, amount field, keypad, quick chips and Konfirmasi
// are all inside the viewport and the sheet body does not scroll, at the fleet tablet (1006x601) and the short laptop size.
const bayarFit = async (page: any, shotName: string) => {
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
  for (const vp of ['pos-a9', 'pos-short', 'pos'] as ShotViewport[]) {
    await page.setViewportSize(SHOT_VIEWPORTS[vp])
    await page.evaluate(async () => { await document.fonts.ready })
    const fit = await page.evaluate(() => {
      const h = window.innerHeight
      const inView = (el: Element | null) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= h + 0.5 }
      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0'].map((k) => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === k) ?? null)
      const backspace = document.querySelector('[role=dialog] button[aria-label="Hapus satu angka"]')
      const confirm = [...document.querySelectorAll('[role=dialog] button')].find((b) => /^Konfirmasi\s*Rp/.test(b.textContent ?? '')) ?? null
      const field = document.getElementById('checkout-amount')
      const method = document.querySelector('[role=dialog] [aria-label="Metode pembayaran"]')
      const body = field?.closest('.overflow-y-auto') as HTMLElement | null
      return { keys: keys.every(inView), backspace: inView(backspace), confirm: inView(confirm), field: inView(field), method: inView(method), noScroll: !!body && body.scrollHeight <= body.clientHeight + 1, h }
    })
    assert(fit.keys && fit.backspace && fit.confirm && fit.field && fit.method, `Bayar fit @${vp}: ${JSON.stringify(fit)}`)
    assert(fit.noScroll, `Bayar body does not scroll @${vp}: ${JSON.stringify(fit)}`)
  }
  await captureShot(page, shotName, ['pos-a9', 'pos', 'pos-short'])
}

// B1 (POS UX direction, D-10): a multi-size tile opens the variant sheet, a size row adds one unit
// and closes it; the cart line opens the line sheet (stepper, size switch as remove + add, Hapus).
// Also measures the "sell one variant product, cash, exact" path: tile → size → Bayar → Konfirmasi.
export const posLineSheet = async (page: ScenarioPage) => {
  const out: any[] = []
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
  const dialog = page.getByRole('dialog')
  // formatRupiah separates "Rp" with a non-breaking space; \s matches both.
  const money = (n: number) => new RegExp(String.raw`Rp\s` + n.toLocaleString('id-ID').replace(/\./g, String.raw`\.`))
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'p1-catalogue', POS_SHOT_VIEWPORTS)
  // Tap 1: the tile. Tap 2: a size row (no quantity to build, no confirm button).
  await page.getByRole('button', { name: /^Synthetic Scent/ }).first().click()
  await dialog.getByRole('button', { name: /^Tambah L · / }).waitFor()
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'p1-variant-sheet', POS_SHOT_VIEWPORTS)
  assert((await dialog.getByRole('button', { name: 'Tambah ke Keranjang', exact: true }).count()) === 0, 'no confirm step in the variant sheet')
  assert((await dialog.getByRole('button', { name: 'Kurangi', exact: true }).count()) === 0, 'no stepper in the variant sheet')
  await dialog.getByRole('button', { name: /^Tambah L · / }).click()
  await page.getByRole('button', { name: 'Ubah Synthetic Scent L', exact: true }).waitFor()
  assert((await dialog.count()) === 0, 'the variant sheet closes after one tap')
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'p1-catalogue-with-cart', POS_SHOT_VIEWPORTS)
  // Tap 3: Bayar (cash is the default). Tap 4: Konfirmasi (blank cash = exact total).
  await page.getByRole('button', { name: 'Bayar', exact: true }).click()
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
  await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
  out.push({ tapPath: ['tile', 'size row', 'Bayar', 'Konfirmasi'], taps: 4 })
  await page.getByRole('button', { name: 'Transaksi Baru', exact: true }).click()

  // Line sheet: open from the line body, +1, switch M → L (same qty, L price), −1, Hapus.
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).click()
  await dialog.getByRole('button', { name: 'Tambah', exact: true }).click()
  assert(money(200000).test(await dialog.innerText()), 'line sheet shows the live subtotal after +1')
  await dialog.getByRole('button', { name: /^L · / }).click()
  await page.getByRole('button', { name: 'Ubah Synthetic Scent L', exact: true }).waitFor()
  assert((await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).count()) === 0, 'the M line is gone after the switch')
  assert(money(240000).test(await dialog.innerText()), 'the switched line keeps qty 2 at the L price')
  await dialog.getByRole('button', { name: 'Kurangi', exact: true }).click()
  // The unit price and the L chip always read 120.000, so prove the 2-unit subtotal is gone.
  assert(!money(240000).test(await dialog.innerText()), 'Kurangi takes the line to 1')
  await dialog.getByRole('button', { name: 'Hapus', exact: true }).click()
  assert((await dialog.count()) === 0, 'Hapus closes the line sheet')
  assert((await page.getByRole('button', { name: 'Bayar', exact: true }).count()) === 0, 'Hapus emptied the cart')
  out.push({ lineSheet: ['open from line body', '+1 → 200.000', 'M→L keeps qty 2 → 240.000', 'Kurangi → 120.000', 'Hapus → cart empty'] })
  return out
}

// B2: one "Promo & Diskon" door, manual discount inline in it, and Kosongkan asks first.
export const posPromoSheet = async (page: ScenarioPage) => {
  const out: any[] = []
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
  const body = () => page.locator('body').innerText()
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Bayar', exact: true }).waitFor()
  // One door: the two old buttons are gone; the single one opens the sheet.
  assert((await page.getByRole('button', { name: 'Diskon manual', exact: true }).count()) === 0, 'no separate Diskon manual button')
  assert((await page.getByRole('button', { name: 'Promo & Kode', exact: true }).count()) === 0, 'old Promo & Kode button is gone')
  await page.getByRole('button', { name: 'Promo & Diskon', exact: true }).click()
  const heading = page.getByRole('heading', { name: 'Promo & Diskon' })
  await heading.waitFor()
  assert((await page.getByRole('textbox', { name: 'Kode promo', exact: true }).count()) === 1, 'the code field sits in the sheet')
  // Manual discount is collapsed, opens inline, and applying keeps the sheet open (replaces, no gate).
  const section = page.getByRole('button', { name: /^Diskon manual \/ Biaya tambahan/ })
  assert((await section.getAttribute('aria-expanded')) === 'false', 'manual section starts collapsed')
  await section.click()
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'p7-promo-sheet', POS_SHOT_VIEWPORTS)
  await page.getByRole('button', { name: 'Persen (%)', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Nilai diskon atau biaya tambahan' }).fill('10')
  await page.getByRole('button', { name: 'Diskon −', exact: true }).click()
  assert(await heading.count(), 'applying a manual discount keeps the sheet open')
  assert((await body()).includes('Diskon manual 10%'), 'manual discount summary is shown')
  await heading.locator('..').getByRole('button', { name: 'Tutup', exact: true }).click()
  assert((await heading.count()) === 0, 'the sheet closes')
  assert((await body()).includes('Total hemat'), 'the cart shows the saving')
  out.push({ singleDoor: ['Promo & Diskon', 'Kode promo field', 'manual 10% inline'] })

  // Kosongkan asks first: Batal keeps the cart, the confirm clears it.
  const confirm = page.getByRole('dialog').filter({ hasText: 'Kosongkan keranjang?' })
  await page.getByRole('button', { name: 'Kosongkan', exact: true }).click()
  await confirm.waitFor()
  assert((await confirm.innerText()).includes('Pelanggan, promo dan catatan ikut terhapus'), 'confirm copy')
  await confirm.getByRole('button', { name: 'Batal', exact: true }).click()
  assert((await page.getByRole('button', { name: 'Bayar', exact: true }).count()) === 1, 'Batal keeps the cart')
  await page.getByRole('button', { name: 'Kosongkan', exact: true }).click()
  await confirm.getByRole('button', { name: 'Kosongkan', exact: true }).click()
  assert((await page.getByRole('button', { name: 'Bayar', exact: true }).count()) === 0, 'confirm clears the cart')
  out.push({ kosongkan: ['dialog', 'Batal keeps cart', 'Kosongkan clears cart'] })
  return out
}

// B3: the customer chip, the Profil Pelanggan sheet and "Ulangi" (adds the last sale's paid lines, never a reward line).
export const posCustomerProfile = async (page: ScenarioPage) => {
  const out: any[] = []
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
  const body = () => page.locator('body').innerText()
  const [scent, tester] = page.__a24.products
  const profile = {
    customer: { id: page.__a24.customer.id, name: 'Synthetic Customer', phone: page.__a24.customer.phone, tier: 'Gold', points: 100, since: '2026-01-01T00:00:00Z', orderCount: 4, totalSpend: 2500000 },
    rewardsAvailable: 1,
    lastOrders: [{ id: 'ord-1', number: 'SYN-0001', at: new Date(Date.now() - 21 * 86400000).toISOString(), outletCode: 'SYN', paymentMethod: 'cash', total: 200000,
      lines: [{ productId: scent.id, name: 'Synthetic Scent', size: 'M', qty: 2, free: false }, { productId: tester.id, name: 'Synthetic Tester', size: 'M', qty: 1, free: true }] }],
    frequentItems: [{ productId: scent.id, size: 'M', name: 'Synthetic Scent', count: 6 }],
    notes: [], pitch: { lastItem: 'Synthetic Scent', lastAt: new Date(Date.now() - 21 * 86400000).toISOString(), usualIntervalDays: 30, neverTriedCategories: ['Woody'] },
  }
  await page.route(/\/api\/v1\/sync\/customers\/[^/]+\/profile(\?|$)/, (route) => route.fulfill({ status: 200, json: { data: profile } }))
  // Empty state: "+ Pelanggan" opens the Pelanggan sheet; a phone search lists the match with a Profil entry.
  await page.getByRole('button', { name: '+ Pelanggan', exact: true }).click()
  await page.getByRole('heading', { name: 'Pelanggan', exact: true }).waitFor()
  await page.getByRole('textbox', { name: 'Cari pelanggan dengan nomor telepon' }).fill(page.__a24.customer.phone)
  await page.getByRole('textbox', { name: 'Cari pelanggan dengan nomor telepon' }).press('Enter')
  if (process.env.A34C_RUN_DIR) await captureShot(page as any, 'p2-pelanggan', POS_SHOT_VIEWPORTS)
  await page.getByRole('button', { name: 'Profil Synthetic Customer', exact: true }).click()
  await page.getByRole('heading', { name: 'Profil Pelanggan' }).waitFor()
  await page.getByText('Bahan obrolan', { exact: true }).waitFor()
  if (process.env.A34C_RUN_DIR) await captureShot(page as any, 'p2-profil-pelanggan', POS_SHOT_VIEWPORTS)
  const text = await body()
  assert(text.includes('Terakhir beli Synthetic Scent') && text.includes('3 minggu lalu'), 'the pitch sentence is built from the profile')
  assert(text.includes('Woody belum pernah dicoba'), 'never-tried line')
  // Ulangi adds the paid line (2 × Scent M) and not the Rp0 Tester.
  await page.getByRole('button', { name: 'Ulangi SYN-0001', exact: true }).click()
  await page.getByText('2 item ditambahkan ke keranjang').waitFor()
  // The gold bar attaches the customer and closes the profile; the cart shows the chip with Ganti / Lepas.
  await page.getByRole('button', { name: 'Pilih untuk transaksi ini', exact: true }).click()
  await page.getByRole('button', { name: 'Lepas', exact: true }).waitFor()
  const cart = await body()
  assert(cart.includes('Synthetic Customer') && cart.includes('Ganti'), 'chip shows the customer with Ganti')
  assert(await page.getByRole('button', { name: 'Bayar', exact: true }).count() === 1, 'Ulangi filled the cart')
  assert(/200\.000/.test(cart) && !/220\.000/.test(cart), 'a reward line is never repeated: the total is 2 x Scent M only')
  assert((await page.getByRole('heading', { name: 'Profil Pelanggan' }).count()) === 0, 'the profile closed')
  out.push({ customerProfile: ['+ Pelanggan', 'Cari + Profil', 'Bahan obrolan', 'Ulangi paid lines only', 'Pilih untuk transaksi ini', 'chip Ganti/Lepas'] })
  // Lepas releases the customer (no promo or reward to drop: no confirm).
  await page.getByRole('button', { name: 'Lepas', exact: true }).click()
  assert((await page.getByRole('button', { name: 'Lepas', exact: true }).count()) === 0, 'Lepas releases the customer')
  out.push({ release: ['Lepas'] })
  return out
}

// B4 (D-6): park the cart under a name, find it again from the hamburger menu, restore it and pay.
export const posHeldOrders = async (page: ScenarioPage) => {
  const out: any[] = []
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
  const sheet = page.getByTestId('held-orders-sheet')
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  // Simpan: name it, save; the cart empties without a confirm (nothing is lost).
  await page.getByRole('button', { name: 'Simpan keranjang', exact: true }).click()
  await sheet.waitFor()
  assert((await sheet.innerText()).includes('Hanya di tablet ini'), 'the sheet says held orders stay on this tablet')
  await sheet.getByRole('textbox', { name: 'Nama pesanan', exact: true }).fill('Bu Sari')
  await sheet.getByRole('button', { name: 'Simpan pesanan', exact: true }).click()
  await sheet.waitFor({ state: 'detached' })
  assert((await page.getByRole('button', { name: 'Bayar', exact: true }).count()) === 0, 'saving empties the cart')
  assert((await page.getByRole('button', { name: 'Pesanan tersimpan (1)', exact: true }).count()) === 1, 'the empty catalog keeps a chip to the held order')
  out.push({ saved: ['name Bu Sari', 'cart emptied', 'chip (1)'] })

  // Restore from the hamburger menu, then pay.
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'Pesanan tersimpan (1)' }).last().click()
  await sheet.waitFor()
  assert((await sheet.innerText()).includes('Bu Sari'), 'the held order is listed')
  await sheet.getByRole('button', { name: 'Lanjutkan Bu Sari', exact: true }).click()
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  assert((await sheet.count()) === 0, 'Lanjutkan closes the sheet')
  assert((await page.getByRole('button', { name: /^Pesanan tersimpan \(/ }).count()) === 0, 'a restored order leaves the held list')
  await page.getByRole('button', { name: 'Bayar', exact: true }).click()
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
  await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
  out.push({ restored: ['Lanjutkan Bu Sari', 'line back in cart', 'paid in cash'] })
  await page.getByRole('button', { name: 'Transaksi Baru', exact: true }).click()
  return out
}

// C3: the outlet giveaway is shown, not sent. A paid line brings a HADIAH/GRATIS bag line to the cart, the sale
// carries no bag order line (the server adds it), the on-screen receipt lists it, and the bag's tile stock drops by
// the one unit the server will take.
export const posGiveaway = async (page: ScenarioPage) => {
  const out: any[] = []
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
  const line = page.getByTestId('giveaway-line')
  const bagTile = async () => {
    await page.getByRole('searchbox').fill('Synthetic Bag')
    const tile = page.getByRole('button', { name: /^Synthetic Bag/ }).first()
    await tile.waitFor()
    const text = await tile.innerText()
    await page.getByRole('searchbox').fill('')
    return text
  }
  assert((await bagTile()).includes('50'), 'the bag tile starts at stock 50')
  assert((await line.count()) === 0, 'no giveaway line while the cart is empty')

  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  await line.waitFor()
  const text = await line.innerText()
  assert(text.includes('Synthetic Bag') && text.includes('HADIAH') && text.includes('GRATIS') && text.includes('Hadiah pembelian'), 'the cart shows the bag as a HADIAH / GRATIS line: ' + text)
  assert((await line.getByRole('button').count()) === 0, 'the giveaway line has no stepper or remove control')
  out.push({ cart: text.replace(/\s+/g, ' ') })

  await page.getByRole('button', { name: 'Bayar', exact: true }).click()
  await page.getByRole('button', { name: /^Konfirmasi Rp/ }).click()
  await page.getByRole('heading', { name: 'Pembayaran Berhasil' }).waitFor()
  assert((await page.getByTestId('receipt-giveaway').innerText()).includes('GRATIS'), 'the receipt lists the bag as GRATIS')
  const sent = (page.__a24.writes as any[]).flatMap((w: any) => w.items ?? []).filter((i: any) => i.type === 'order')
  assert(sent.length === 1, 'one order was sent')
  assert(!sent[0].payload.items.some((i: any) => /Bag/.test(i.productName)), 'the bag is not an order line')
  assert(sent[0].payload.receiptSnapshot.lines.some((l: any) => /Bag/.test(l.name) && l.isReward === true && l.amount === 0), 'the quote carries the bag as a Rp0 reward line')
  out.push({ receipt: 'bag row GRATIS', payload: 'no bag order line, quote carries it' })
  await page.getByRole('button', { name: 'Transaksi Baru', exact: true }).click()
  assert((await bagTile()).includes('49'), 'the bag tile drops to 49 once the sale is queued')
  out.push({ stock: '50 -> 49' })
  return out
}
