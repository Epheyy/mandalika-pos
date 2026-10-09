async (page) => {
  const P = '00000000-0000-4000-8300-000000000001';
  const R = '00000000-0000-4000-8300-000000000002';
  const products = [{id:P,name:'Synthetic Scent',isActive:true,variants:[{size:'M',sku:'SYN-M',price:100000,stock:100},{size:'L',sku:'SYN-L',price:120000,stock:100}]},{id:R,name:'Synthetic Tester',isActive:true,variants:[{size:'M',sku:'TEST-M',price:20000,stock:100},{size:'L',sku:'TEST-L',price:25000,stock:100}]}];
  products.forEach(p=>p.variants.forEach(v=>v.barcode=v.sku));
  const base={value:0,isActive:true,combinable:true,codeOnly:false,minPurchase:0};
  const promotions=[{...base,id:'bundle',name:'Synthetic Bundle',type:'bundle',bundleConfig:{slots:[{productKeys:[P],quantity:1},{productKeys:[R],quantity:1}],bundlePrice:105000,maxApplications:1}},{...base,id:'bxgy',name:'Synthetic BXGY',type:'buy_x_get_y',bxgyConfig:{buyProductIds:[P],getProductIds:[R],buyQuantity:1,getQuantity:1,getDiscountKind:'percentage',getDiscountValue:50,maxApplications:1}},{...base,id:'generic',name:'Generic Ten',type:'percentage',value:10},{...base,id:'invalid',name:'Invalid Legacy',type:'bundle',bundleConfig:{slots:[{productKeys:[P],quantity:1},{productKeys:[P+'|M'],quantity:1}],bundlePrice:50000,maxApplications:1}}];
  const customer={id:'00000000-0000-4000-8300-000000000081',name:'Synthetic Customer',phone:'+62000000000',points:100,totalSpent:0,visitCount:0};
  const codes=[{id:'code-bundle',code:'Raw-Bundle',promotionId:'bundle'},{id:'code-bxgy',code:'Raw-BXGY',promotionId:'bxgy'},{id:'code-generic',code:'Raw-Generic',promotionId:'generic'},{id:'code-cap',code:'CUSTOMER-CAP',perCustomerLimit:1},{id:'code-assigned',code:'ASSIGNED',customerId:customer.id}].map(c=>({...base,type:'percentage',value:10,usageCount:0,...c}));
  const settings={taxEnabled:false,taxRate:0,roundingEnabled:false,roundingType:'none',allowNegativeStock:true,autoOpenShift:false,paymentMethods:[{id:'cash',label:'Tunai',isEnabled:true},{id:'qris',label:'QRIS',isEnabled:true}],receipt:{headerText:'Synthetic receipt',footerText:'Test only',showTax:false,showCashier:true}};
  const user={id:'00000000-0000-4000-8300-000000000091',displayName:'Synthetic Cashier',role:'admin',outletId:'00000000-0000-4000-8300-000000000090',permissions:['create_order','manage_promotions']};
  const snapshot={version:1,products,categories:[],bundles:[],customers:[customer],promotions,discountCodes:codes,loyaltyConditions:[],loyaltySettings:{enabled:true,tierEnabled:false,pointsPerThousand:1,redemptionRate:100},appSettings:settings,outletName:'Synthetic Outlet',outletCode:'SYN',salesmen:[]};
  page.__a24={products,promotions,codes,customer,snapshot,calls:[],writes:[],unexpected:[]};
  await page.unrouteAll({behavior:'wait'});
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(), path=req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0], method=req.method();
    page.__a24.calls.push({path,method});
    let data=[];
    if(path.includes('/auth/')) data={access:'SYNTHETIC-NON-TOKEN',refresh:'SYNTHETIC-NON-TOKEN',user};
    else if(path.endsWith('/sync/pull')) data=snapshot;
    else if(path.endsWith('/sync/version')) data={version:1};
    else if(path.endsWith('/sync/batch')) {page.__a24.writes.push(req.postDataJSON()); return route.fulfill({status:503,json:{error:'Synthetic retain-only transport'}});}
    else if(path.endsWith('/shifts/current')) data={id:'00000000-0000-4000-8300-000000000080',status:'open',startingCash:1100000,cashierId:user.id,outletId:user.outletId,openedAt:new Date().toISOString()};
    else if(path.endsWith('/products')) data=products;
    else if(path.endsWith('/promotions')) {if(method!=='GET')page.__a24.writes.push({path,method,body:req.postDataJSON()});data=promotions;}
    else if(path.includes('/promotions/')) {if(method!=='GET')page.__a24.writes.push({path,method,body:req.postDataJSON()});data={id:'saved-synthetic'};}
    else if(path.endsWith('/discount-codes')) data=codes;
    else if(path.endsWith('/sync/loyalty-preview')) data=[{conditionId:'loyalty-one',conditionName:'Customer gift',rewardProductIds:[R],products:[products[1]]}];
    else if(path.endsWith('/customers')) data=[customer];
    else if(path.endsWith('/outlets')) data=[{id:user.outletId,name:'Synthetic Outlet',isActive:true}];
    else if(path.endsWith('/settings')) data=settings;
    return route.fulfill({status:200,json:{data,meta:{total:Array.isArray(data)?data.length:1,page:1,limit:50}}});
  });
  await page.context().route('**/*',route=>{return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(route.request().url())?route.continue():route.abort();});
  await page.goto('http://127.0.0.1:5173/');
  await page.evaluate(()=>{localStorage.clear();localStorage.setItem('mandalika.pos.refresh','SYNTHETIC-NON-TOKEN');});
  await page.reload();
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();
  return {fixture:'real apps; synthetic intercepted APIs; all external hosts blocked',products:products.length};
}
