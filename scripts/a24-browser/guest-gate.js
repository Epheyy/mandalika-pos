async(page)=>{
 await page.reload();await page.getByRole('button',{name:'S Synthetic Scent',exact:true}).waitFor();
 await page.getByRole('searchbox').fill('SYN-M');await page.getByRole('searchbox').press('Enter');
 await page.getByRole('button',{name:'Bayar',exact:true}).click();
 if(await page.getByRole('heading',{name:'Konfirmasi Pembayaran',exact:true}).count()!==1)throw Error('A24: ordinary guest with active shift cannot open checkout');
 return {guestCheckoutOpened:true};
}
