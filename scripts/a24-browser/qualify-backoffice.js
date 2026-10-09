async(page)=>{
 const out=[];const P=page.__a24.products[0].id;const fixture=page.__a24.promotions[3];const initial=JSON.parse(JSON.stringify(fixture));
 const rows=[['bundle',P,P+'|M',false],['bundle',P+'|M',P,false],['bundle',P+'|M',P+'|L',true],['buy_x_get_y',P,P+'|M',false],['buy_x_get_y',P+'|M',P+'|L',true]];
 for(const [type,a,b,valid]of rows){
  fixture.type=type;fixture.bundleConfig={slots:[{productKeys:[a],quantity:1},{productKeys:[b],quantity:1}],bundlePrice:100000,maxApplications:1};fixture.bxgyConfig={buyProductIds:[a],getProductIds:[b],buyQuantity:1,getQuantity:1,getDiscountKind:'percentage',getDiscountValue:50,maxApplications:1};
  await page.reload();await page.getByRole('button',{name:'Promosi',exact:true}).first().click();
  await page.getByRole('row').filter({hasText:'Invalid Legacy'}).locator('button').nth(1).click();
  await page.getByRole('button',{name:'Lanjutkan',exact:true}).click();const mechanics=await page.locator('.fixed.inset-0.z-50').innerText();
  await page.getByRole('button',{name:'Lanjutkan',exact:true}).click();const save=page.getByRole('button',{name:'Simpan',exact:true});
  if((await save.isEnabled())!==valid)throw Error(type+a+b+' wrong Save gate');
  const n=page.__a24.writes.length;
  if(valid){await save.click();await page.locator('.fixed.inset-0.z-50').waitFor({state:'hidden'});if(page.__a24.writes.length!==n+1)throw Error('missing save');}
  else {await save.evaluate(b=>b.click());if(page.__a24.writes.length!==n)throw Error('invalid API mutation');await page.getByRole('button',{name:'Batal',exact:true}).click();}
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
 out.push({interactiveError,duplicateAndToggle:page.__a24.writes.slice(-2)});
 Object.assign(fixture,initial);page.__a24.boQualification=out;return out;
}
