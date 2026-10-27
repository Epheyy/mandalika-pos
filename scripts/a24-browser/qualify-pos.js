async(page)=>{
 const result=[]; const assert=(v,m)=>{if(!v)throw Error(m)};
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
  const remove=page.getByRole('button',{name:/Hapus promo|Hapus kode/});
  if(await remove.count())await remove.first().click();
  else await page.getByRole('button',{name:/Hapus semua/}).last().click();
  if(await page.getByRole('heading',{name:'Promo & Diskon'}).count())await page.getByRole('heading',{name:'Promo & Diskon'}).locator('..').getByRole('button',{name:'Tutup',exact:true}).click();
  assert(!(await body()).includes('Hadiah Promo'),'removal clears reward');
  result.push({kind,owner,removed:await body()});
 }
 page.__a24.qualification=result;return result;
}
