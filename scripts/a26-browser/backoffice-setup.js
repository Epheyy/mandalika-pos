async (page) => {
  await page.unrouteAll({behavior:'wait'});
  const now = new Date().toISOString();
  const user = {id:'synthetic-cashier',displayName:'A26 Cashier',role:'admin',outletId:'outlet-a',permissions:[]};
  const order = i => ({id:`order-${i}`,orderNumber:`A26-${i}`,outletId:'outlet-a',cashierId:user.id,cashierName:user.displayName,customerId:null,customerName:null,status:'completed',paymentMethod:i%2?'qris':'cash',subtotal:1000,total:1000,discountAmount:0,taxAmount:0,createdAt:now,items:[{productId:'p',productName:'A26 Product',variantSize:'M',quantity:1,subtotal:1000,unitPrice:1000}]});
  page.__a26 = {count:51,fail:null,calls:[],csv:[],order};
  await page.context().route('**/*',route=>/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(route.request().url())?route.continue():route.abort());
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(), path=req.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    const query=Object.fromEntries((req.url().split('?')[1]||'').split('&').filter(Boolean).map(s=>s.split('=')));
    const n=Number(query.page)||1, requested=Number(query.limit)||50, limit=requested>200||requested<1?50:requested;
    const state=page.__a26;state.calls.push({path,page:n,requested,limit});
    if(state.fail===path && n===2) return route.fulfill({status:503,json:{error:'A26 synthetic page 2 failure'}});
    let data=[];
    if(path.includes('/auth/')) data={access:'SYNTHETIC-NON-TOKEN',refresh:'SYNTHETIC-NON-TOKEN',user};
    else if(path.endsWith('/outlets')) data=[{id:'outlet-a',name:'A26 Outlet',isActive:true}];
    else if(path.endsWith('/orders')) data=Array.from({length:state.count},(_,i)=>order(i));
    else if(path.endsWith('/shifts')) data=Array.from({length:state.count},(_,i)=>({id:`shift-${i}`,outletId:'outlet-a',cashierName:`Cashier ${i}`,status:'closed',openedAt:now,closedAt:now,startingCash:0,closingCash:1000,totalSales:1000,totalOrders:1,cashSales:1000,cardSales:0,transferSales:0,qrisSales:0}));
    else if(path.endsWith('/products')) data=Array.from({length:201},(_,i)=>({id:`p-${i}`,name:`Product ${i}`,isActive:true,variants:[{size:'M',price:1000,stock:i===200?0:100}]}));
    const total=Array.isArray(data)?data.length:1;
    if(['/orders','/shifts','/products'].some(s=>path.endsWith(s))) data=data.slice((n-1)*limit,n*limit);
    return route.fulfill({json:{data,meta:{total,page:n,limit}}});
  });
  await page.goto('http://127.0.0.1:5174');
  await page.evaluate(()=>{localStorage.clear();localStorage.setItem('mandalika.backoffice.refresh','SYNTHETIC-NON-TOKEN');localStorage.setItem('mandalika.backoffice.loginDate',new Date().toISOString().slice(0,10));});
  await page.reload();
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Laporan',exact:true}).click();
  await page.getByRole('button',{name:'Ekspor',exact:true}).click();
  await page.evaluate(()=>{window.__a26csv=[];URL.createObjectURL=b=>{window.__a26csv.push(b.text());return 'blob:synthetic';};HTMLAnchorElement.prototype.click=function(){};});
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  const csv=await page.evaluate(()=>Promise.all(window.__a26csv));
  return {expected:51,rows:csv[0]?.split('\n').length-1,calls:page.__a26.calls,body:(await page.locator('body').innerText()).slice(-1300)};
}
