async(page)=>{
 const out=[];const assert=(v,m)=>{if(!v)throw Error(m)};
 for(const kind of ['Bundle','BXGY'])for(const owner of ['direct','linked']){
  await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();
  for(const sku of ['SYN-M','SYN-L','TEST-M']){await page.getByRole('searchbox').fill(sku);await page.getByRole('searchbox').press('Enter');}
  const apply=async()=>{await page.getByRole('button',{name:'Promo',exact:true}).click();if(owner==='direct')await page.getByRole('button').filter({hasText:'Synthetic '+kind}).last().click();else{await page.getByRole('textbox',{name:'Kode promo',exact:true}).fill('Raw-'+kind);await page.getByRole('button',{name:'Pakai',exact:true}).click();}await page.getByRole('button',{name:kind==='Bundle'?/Synthetic Scent · MRp/:/Synthetic Tester · MRp/}).click();await page.getByRole('button',{name:'Terapkan',exact:true}).click();};
  await apply();
  await page.getByRole('button',{name:/^Promo(?: |$)/}).first().click();await page.getByRole('button',{name:'Hapus '+(owner==='direct'?'Synthetic ':'Raw-')+kind,exact:true}).click();
  await page.getByRole('heading',{name:'Promo & Diskon'}).locator('..').getByRole('button',{name:'Tutup',exact:true}).click();assert(!(await page.locator('body').innerText()).includes('Hadiah Promo'),'individual removal');
  await apply();await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button',{name:'QRIS',exact:true}).click();await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();await page.getByRole('heading',{name:'Pembayaran Berhasil'}).waitFor();
  const item=await page.evaluate(()=>JSON.parse(localStorage.getItem('mandalika.pos.outbox')).at(-1)),p=item.payload;
  assert(p.items.reduce((n,i)=>n+i.quantity,0)===(kind==='Bundle'?3:4),'physical quantity');
  assert(p.items.filter(i=>i.rewardPromotionId===(kind==='Bundle'?'bundle':'bxgy')).length===1,'physical owner');
  assert(p.customerId===null,'guest identity');
  assert(owner==='direct'?p.promotionIds.length===1&&p.discountCodes.length===0:p.promotionIds.length===0&&p.discountCodes.length===1&&p.discountCodes[0]==='Raw-'+kind,'one usage identity');
  out.push({kind,owner,individualRemoval:true,item,receipt:await page.locator('body').innerText()});
 }
 page.__a24.physicalQueue=out;return out;
}
