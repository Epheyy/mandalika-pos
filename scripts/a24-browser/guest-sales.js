async(page)=>{
 const results=[]; const assert=(v,m)=>{if(!v)throw Error(m)};
 const box=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('mandalika.pos.outbox')||'[]'));
 const fresh=async()=>{await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();await page.getByRole('searchbox').fill('SYN-M');await page.getByRole('searchbox').press('Enter');};
 const select=async()=>{await page.getByRole('textbox',{name:'Cari nama atau nomor telepon pelanggan'}).fill('Synthetic');await page.getByRole('button').filter({hasText:'Synthetic Customer'}).click();};
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
 await fresh();await select();await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button').filter({hasText:'Customer gift'}).click();await page.getByRole('button',{name:/Synthetic Tester · M/}).click();await page.getByRole('button',{name:/^Tukar [0-9]+ poin/}).click();await page.getByRole('button',{name:'Semua',exact:true}).last().click();await page.getByRole('heading',{name:'Bayar',exact:true}).locator('..').getByRole('button',{name:'Kembali'}).click();await clear();const loyaltyClear=await capture('clear-reward-points');assert(loyaltyClear.payload.items.length===1,'loyalty line removed');
 await fresh();await select();await capture('registered-preserved','qris',true);
 // Browser reconstruction uses the same successful localStorage, no replacement engine or fixture payload.
 const identities=(await box()).map(i=>({key:i.idempotencyKey,payload:i.payload,created:i.clientCreatedAt}));await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();assert(JSON.stringify((await box()).map(i=>({key:i.idempotencyKey,payload:i.payload,created:i.clientCreatedAt})))===JSON.stringify(identities),'reconstruction changes captured facts');
 results.push({name:'reconstruction',identities});page.__a24.guestResults=results;return results;
}
