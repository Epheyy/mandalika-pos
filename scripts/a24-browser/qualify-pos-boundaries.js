async(page)=>{
 const out=[]; const P=page.__a24.products[0].id;const legacy=page.__a24.promotions[3];legacy.type='bundle';legacy.bundleConfig={slots:[{productKeys:[P],quantity:1},{productKeys:[P+'|M'],quantity:1}],bundlePrice:50000,maxApplications:1};
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
