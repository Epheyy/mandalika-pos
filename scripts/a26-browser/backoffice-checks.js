async (page) => {
  const results=[];
  const check=(ok,msg)=>{if(!ok)throw new Error(msg);};
  const capture=async()=>{await page.evaluate(()=>window.__a26csv=[]);await page.getByRole('button',{name:'Export CSV',exact:true}).click();return (await page.evaluate(()=>Promise.all(window.__a26csv)))[0];};
  for(const n of [51,201,1000]) {
    page.__a26.count=n;page.__a26.calls=[];
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    await page.getByText(`${n} transaksi`,{exact:true}).waitFor();
    const dashboard=await page.locator('main').innerText();
    check(dashboard.includes(`Rp ${(n*1000).toLocaleString('id-ID')}`)||dashboard.replace(/\s/g,'').includes(`Rp${(n*1000).toLocaleString('id-ID')}`),'dashboard total');
    check(dashboard.includes('Product 200'),'last-page low stock missing');
    await page.getByRole('button',{name:'Laporan',exact:true}).click();
    await page.getByRole('button',{name:'Ekspor',exact:true}).click();
    await page.getByText(`${n} transaksi`,{exact:true}).waitFor();
    const csv=await capture();const csvRows=csv.split('\n').length-1;
    check(csvRows===n,`CSV ${csvRows} expected ${n}`);
    const report=await page.locator('main').innerText();
    check(report.replace(/\s/g,'').includes(`Rp${(n*1000).toLocaleString('id-ID')}`),'report total');
    await page.locator('select').filter({has:page.locator('option[value="qris"]')}).selectOption('qris');
    const filtered=await capture();check(filtered.split('\n').length-1===Math.floor(n/2),'payment filter');
    await page.locator('select').filter({has:page.locator('option[value="refunded"]')}).selectOption('refunded');
    check((await page.locator('main').innerText()).includes('0 transaksi'),'status filter');
    await page.locator('select').filter({has:page.locator('option[value="refunded"]')}).selectOption('');
    await page.locator('select').filter({has:page.locator('option[value="qris"]')}).selectOption('');
    await page.locator('input[type=date]').first().fill('2099-01-01');
    check((await page.locator('main').innerText()).includes('0 transaksi'),'date filter');
    await page.locator('input[type=date]').first().fill(new Date().toISOString().slice(0,10));
    await page.getByRole('button',{name:'Shift',exact:true}).click();
    const shifts=await capture();check(shifts.split('\n').length-1===n,'shift CSV');
    results.push({n,csvRows,shiftCsvRows:n,reportTotal:n*1000,filteredQris:Math.floor(n/2),dashboard,requests:page.__a26.calls});
  }
  await page.getByRole('button',{name:'Ekspor',exact:true}).click();
  page.__a26.fail='/api/v1/orders';
  await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor({timeout:20000});
  check(await page.getByRole('button',{name:'Export CSV',exact:true}).isDisabled(),'failed export enabled');
  check((await page.locator('main').innerText()).includes('1000 transaksi'),'complete snapshot lost');
  results.push({laterPageFailure:'visible error; original1000 snapshot retained; export disabled'});
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor();
  results.push({dashboardInitialFailure:'error instead of prefix KPIs'});
  page.__a26.fail=null;
  return results;
}
