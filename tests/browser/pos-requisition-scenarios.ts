// POS-REQUISITION (inventory-controls S6): the cashier's Permintaan Barang screen against an in-memory
// synthetic /requisitions server. Asserts (a)-(g) of the S6 plan: menu gating, create with the
// idempotency key and outlet, submit retry with the SAME key, the transfer chain and the receive hand-off,
// cancel, offline refusal, and zero warehouse calls (approve / reject / fulfil) across the whole run.
import type { ScenarioPage } from './fixture';
import { setupPos } from './pos-scenarios';

const OUTLET = '00000000-0000-4000-8300-000000000090';
const CASHIER = { role: 'cashier', permissions: ['create_order'] };
const NOW = '2026-10-26T01:00:00.000Z';

const requisitionServer = () => {
  const state: any = { rows: [] as any[], posts: [] as any[], submits: [] as any[], lists: [] as any[], forbidden: [] as string[], submitFailsLeft: 1, seq: 0 };
  state.rows.push({
    id: 'req-seed', number: 'PB-2026-00099', status: 'fulfilled', outletId: OUTLET, requestedBy: 'u', requestedByName: 'Synthetic Cashier',
    transfer: { id: 'tr-1', transferNo: 'TR-2026-00007', status: 'in_transit' },
    items: [{ id: 'i-seed', productId: 'p', productName: 'Synthetic Scent', variantSize: 'M', sku: 'SYN-M', requestedQty: 2, approvedQty: 2, transferQty: 2 }],
    events: [{ id: 1, action: 'created', actorName: 'Synthetic Cashier', at: NOW }], createdAt: NOW, updatedAt: NOW,
  });
  const summary = (r: any) => ({ ...r, items: undefined, events: undefined });
  const extraRoute = async (route: any, path: string, method: string, req: any) => {
    if (!/\/requisitions(\/|$)/.test(path)) return false;
    const headers = req.headers();
    const id = path.split('/requisitions/')[1]?.split('/')[0];
    const action = path.split('/requisitions/')[1]?.split('/')[1];
    const url = new URL(req.url());
    if (['approve', 'reject', 'fulfil'].includes(action)) {
      state.forbidden.push(path);
      await route.fulfill({ status: 403, json: { error: 'forbidden' } });
      return true;
    }
    if (method === 'GET' && !id) {
      state.lists.push(Object.fromEntries(url.searchParams));
      await route.fulfill({ status: 200, json: { data: state.rows.map(summary), meta: { total: state.rows.length, page: 1, limit: 50 } } });
      return true;
    }
    if (method === 'GET') {
      const row = state.rows.find((r: any) => r.id === id);
      await route.fulfill(row ? { status: 200, json: { data: row } } : { status: 404, json: { error: 'not found' } });
      return true;
    }
    if (method === 'POST' && !id) {
      const body = req.postDataJSON();
      state.posts.push({ key: headers['idempotency-key'], outlet: headers['x-outlet-id'], body });
      const n = ++state.seq;
      const row = {
        id: `req-${n}`, number: `PB-2026-${String(n).padStart(5, '0')}`, status: 'draft', outletId: OUTLET, requestedBy: 'u',
        requestedByName: 'Synthetic Cashier', note: body.note, neededBy: body.neededBy,
        items: body.items.map((i: any, k: number) => ({ id: `i-${n}-${k}`, ...i, productName: i.productId.endsWith('1') ? 'Synthetic Scent' : 'Synthetic Tester', sku: i.productId.endsWith('1') ? 'SYN-M' : 'TEST-M' })),
        events: [{ id: 1, action: 'created', actorName: 'Synthetic Cashier', at: NOW }], createdAt: NOW, updatedAt: NOW,
      };
      state.rows.unshift(row);
      await route.fulfill({ status: 201, json: { data: row } });
      return true;
    }
    const row = state.rows.find((r: any) => r.id === id);
    if (method === 'POST' && row && action === 'submit') {
      state.submits.push({ key: headers['idempotency-key'] });
      if (state.submitFailsLeft > 0) {
        state.submitFailsLeft--;
        await route.fulfill({ status: 503, json: { error: 'Synthetic outage' } });
        return true;
      }
      row.status = 'submitted';
      await route.fulfill({ status: 200, json: { data: row } });
      return true;
    }
    if (method === 'POST' && row && action === 'cancel') {
      row.status = 'cancelled';
      await route.fulfill({ status: 200, json: { data: row } });
      return true;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
    return true;
  };
  return { state, extraRoute };
};

export const posRequisition = async (page: ScenarioPage) => {
  const assert = (v: unknown, m: string) => { if (!v) throw Error(m); };
  const result: any[] = [];
  const menu = async () => { await page.getByRole('button', { name: 'Menu', exact: true }).click(); };
  const openPanel = async () => {
    await menu();
    await page.getByRole('button', { name: 'Permintaan Barang', exact: true }).click();
    await page.getByRole('heading', { name: 'Permintaan Barang', exact: true }).waitFor();
  };
  const warehouseCalls: string[] = [];
  const noteWarehouse = (srv: any) => { warehouseCalls.push(...srv.state.forbidden); };

  // (a) a cashier without request_stock never sees the menu item
  const denied = requisitionServer();
  await setupPos(page, { user: CASHIER, extraRoute: denied.extraRoute });
  await menu();
  await page.getByRole('button', { name: 'Terima Transfer', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Permintaan Barang', exact: true }).count() === 0, '(a) no menu item without request_stock');
  assert(!page.__a24.calls.some((c: any) => c.path.includes('/requisitions')), '(a) no requisition call was made');
  noteWarehouse(denied);
  result.push({ assert: 'a', menuItemHidden: true });

  // (b) with request_stock: create 2 lines + date + note + "Diminta oleh"
  const srv = requisitionServer();
  await setupPos(page, { user: { ...CASHIER, permissions: ['create_order', 'request_stock'] }, extraRoute: srv.extraRoute });
  const P1 = page.__a24.products[0].id, P2 = page.__a24.products[1].id;
  await openPanel();
  await page.getByText('PB-2026-00099').waitFor();
  assert(srv.state.lists.length > 0 && srv.state.lists.every((q: any) => q.outletId === OUTLET), '(b) every list call is pinned to the outlet');
  await page.getByRole('button', { name: 'Buat Permintaan', exact: true }).click();
  await page.getByLabel('Cari barang').fill('SYN-M');
  await page.getByRole('button', { name: /Synthetic Scent · M \(SYN-M\)/ }).click();
  await page.getByLabel('Cari barang').fill('TEST-M');
  await page.getByRole('button', { name: /Synthetic Tester · M \(TEST-M\)/ }).click();
  await page.getByLabel('Qty Synthetic Tester M').fill('3');
  await page.getByLabel('Dibutuhkan pada (opsional)').fill('2026-11-03');
  await page.getByLabel('Diminta oleh (opsional)').fill('Sari');
  await page.getByLabel('Catatan (opsional)').fill('untuk event');
  await page.getByRole('button', { name: 'Simpan Draf', exact: true }).click();
  await page.getByRole('button', { name: 'Ajukan', exact: true }).waitFor();
  assert(srv.state.posts.length === 1, '(b) one create call');
  const post = srv.state.posts[0];
  assert(typeof post.key === 'string' && post.key.length > 8, '(b) the create carries an Idempotency-Key');
  assert(post.outlet === OUTLET, '(b) the create carries the outlet');
  assert(post.body.items.length === 2 && post.body.items.some((i: any) => i.productId === P1) && post.body.items.some((i: any) => i.productId === P2 && i.requestedQty === 3), '(b) both lines sent');
  assert(post.body.neededBy === '2026-11-03' && post.body.note === 'Diminta oleh: Sari\nuntuk event', '(b) date and note (Diminta oleh first)');
  result.push({ assert: 'b', key: true, outlet: post.outlet, lines: post.body.items.length });

  // (c) submit answers a synthetic 503, then "Coba Lagi"-style retry sends the SAME key
  await page.getByRole('button', { name: 'Ajukan', exact: true }).click();
  await page.getByText(/Server belum menjawab/).waitFor();
  await page.getByRole('button', { name: 'Ajukan', exact: true }).click();
  await page.getByRole('button', { name: 'Batalkan Permintaan', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Ajukan', exact: true }).waitFor({ state: 'detached' });
  assert(srv.state.submits.length === 2, '(c) two submit calls');
  assert(srv.state.submits[0].key && srv.state.submits[0].key === srv.state.submits[1].key, '(c) the retry reuses the same Idempotency-Key');
  result.push({ assert: 'c', sameKey: true });

  // (d) the transfer chain shows Dikirim and "Buka Terima Transfer" opens the receive panel
  await page.getByRole('button', { name: 'Kembali', exact: true }).click();
  await page.getByRole('button', { name: /PB-2026-00099/ }).click();
  await page.getByText('Dikirim', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Buka Terima Transfer', exact: true }).click();
  await page.getByRole('heading', { name: 'Terima Transfer' }).waitFor();
  assert(await page.getByRole('heading', { name: 'Permintaan Barang', exact: true }).count() === 0, '(d) the requisition panel closed');
  await page.getByRole('heading', { name: 'Terima Transfer' }).locator('..').getByRole('button', { name: 'Tutup', exact: true }).click();
  result.push({ assert: 'd', receivePanelOpened: true });

  // (e) cancel a draft
  await openPanel();
  await page.getByRole('button', { name: 'Buat Permintaan', exact: true }).click();
  await page.getByLabel('Cari barang').fill('SYN-M');
  await page.getByRole('button', { name: /Synthetic Scent · M \(SYN-M\)/ }).click();
  await page.getByRole('button', { name: 'Simpan Draf', exact: true }).click();
  await page.getByRole('button', { name: 'Batalkan Permintaan', exact: true }).click();
  await page.getByText(/tidak bisa dibuka lagi/).waitFor();
  await page.getByRole('button', { name: 'Batalkan Permintaan', exact: true }).first().click();
  await page.getByText('Dibatalkan', { exact: true }).first().waitFor();
  assert(srv.state.rows.find((r: any) => r.id === 'req-2')?.status === 'cancelled', '(e) the draft was cancelled on the server');
  result.push({ assert: 'e', cancelled: true });

  // (f) offline: the save is refused with "butuh koneksi" and no write call leaves the tablet
  await page.getByRole('button', { name: 'Kembali', exact: true }).click();
  await page.getByRole('button', { name: 'Buat Permintaan', exact: true }).click();
  await page.getByLabel('Cari barang').fill('SYN-M');
  await page.getByRole('button', { name: /Synthetic Scent · M \(SYN-M\)/ }).click();
  const postsBefore = srv.state.posts.length;
  page.__a24.netDown = true;
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); });
  await page.getByTitle('Offline', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Simpan Draf', exact: true }).click();
  await page.getByText('Permintaan Barang butuh koneksi internet.').waitFor();
  assert(srv.state.posts.length === postsBefore, '(f) no create call while offline');
  assert(await page.getByLabel('Qty Synthetic Scent M').inputValue() === '1', '(f) the form content is kept');
  page.__a24.netDown = false;
  result.push({ assert: 'f', writesWhileOffline: srv.state.posts.length - postsBefore });

  // (g) zero warehouse calls across the whole run, in the synthetic server and in the raw call log
  noteWarehouse(srv);
  const raw = page.__a24.calls.filter((c: any) => /\/requisitions\/[^/]+\/(approve|reject|fulfil)$/.test(c.path));
  assert(warehouseCalls.length === 0 && raw.length === 0, '(g) no approve / reject / fulfil request');
  result.push({ assert: 'g', warehouseCalls: warehouseCalls.length + raw.length });
  return result;
};
