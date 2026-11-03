async(page)=>{
  const results=[];
  for(const n of [51,201,1000]) {
    page.__a26.count=n;
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    await page.getByRole('button',{name:'Laporan',exact:true}).click();
    await page.getByText(`${n} transaksi · Total:`,{exact:false}).waitFor();
    await page.evaluate(()=>{window.__a26blobs=[];URL.createObjectURL=b=>{window.__a26blobs.push(b);return 'blob:synthetic';};});
    await page.getByRole('button',{name:'Unduh Excel',exact:true}).click();
    const rows=await page.evaluate(async()=>{
      const url=performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('/xlsx.js'));
      const XLSX=await import(url);
      const wb=XLSX.read(await window.__a26blobs[0].arrayBuffer());
      return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    });
    if(rows.length!==n||rows.reduce((s,r)=>s+r.Total,0)!==n*1000)throw new Error('incomplete XLSX');
    results.push({n,xlsxRows:rows.length,total:rows.reduce((s,r)=>s+r.Total,0)});
  }
  page.__a26.fail='/api/v1/orders';
  await page.getByRole('alert').filter({hasText:'Gagal memuat data lengkap'}).waitFor({timeout:20000});
  if(!(await page.getByRole('button',{name:'Unduh Excel',exact:true}).isDisabled()))throw new Error('failure enabled export');
  results.push({laterFailure:'visible error; XLSX disabled; complete snapshot retained'});
  page.__a26.fail=null;
  return results;
}
