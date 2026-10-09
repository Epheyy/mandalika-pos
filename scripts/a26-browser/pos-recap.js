async(page)=>{
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
  for(const part of ['orders','shifts','cash-flows'])await page.route(`**/api/v1/${part}**`,routeHandler);
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
  const activeData=JSON.parse(cache['mandalika.cache.rekap:current']).data;
  const historyData=JSON.parse(cache['mandalika.cache.rekap:history']).data;
  const selectedData=JSON.parse(cache['mandalika.cache.rekap:orders:history-60']).data;
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
