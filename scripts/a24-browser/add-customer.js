async(page)=>{
 await page.reload();await page.getByRole('button',{name:'+ Pelanggan',exact:true}).click();await page.getByRole('button',{name:'+ Baru',exact:true}).click();
 await page.getByRole('textbox',{name:'Nama pelanggan',exact:true}).fill('New Synthetic Customer');await page.getByRole('textbox',{name:'Nomor telepon pelanggan',exact:true}).fill('+44000000000');await page.getByRole('button',{name:'Simpan',exact:true}).click();
 await page.getByText('New Synthetic Customer',{exact:true}).first().waitFor();await page.getByRole('searchbox').fill('SYN-M');await page.getByRole('searchbox').press('Enter');await page.getByRole('button',{name:'Bayar',exact:true}).click();await page.getByRole('button',{name:'QRIS',exact:true}).click();await page.getByRole('button',{name:/^Konfirmasi Rp/}).click();await page.getByRole('heading',{name:'Pembayaran Berhasil'}).waitFor();
 const q=await page.evaluate(()=>JSON.parse(localStorage.getItem('mandalika.pos.outbox')));const created=q.findLast(i=>i.type==='customer_create'),sale=q.at(-1);if(!created||sale.payload.customerId!==created.payload.customerId||sale.payload.customerName!=='New Synthetic Customer')throw Error('new customer sale identity');
 return {created,sale,receipt:await page.locator('body').innerText()};
}
