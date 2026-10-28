# Serah terima: kebutuhan POS Mandalika terhadap ERP (erp-flamboyan)

Tanggal: 2026-10-21. Penulis: tim POS. Pembaca: developer ERP.
Dasar analisis: ERP `main` @ `1c1d08f5`, POS `prod-hardening` @ `4b0f7f7`.
Analisis teknis lengkap (bahasa Inggris): `docs/plans/2026-10-21-erp-flamboyan-compatibility-assessment.md`.

> **Status 2026-10-22:** seluruh pekerjaan sisi POS di dokumen ini (§5 P-A s.d. P-H) sudah selesai, digabung, dan berjalan di
> lingkungan uji (Cloud Run revisi `00124-duv`, migrasi 0064–0066, ledger terisi, backfill selesai). Tarik katalog dan relay
> dimatikan sampai ERP tersedia. Yang tersisa ada di sisi ERP (§4) dan jawaban §11. POS juga menyediakan **stub** kontrak
> (`backend/cmd/erpstub`) dan spesifikasi OpenAPI `docs/integration/stock-documents.v1.yaml` sebagai acuan implementasi ERP.

Dokumen ini menjawab tiga hal:

1. Apa yang POS butuhkan dari ERP (endpoint, field, semantik).
2. Apa yang POS putuskan dan kerjakan di sisinya.
3. Desain target yang kami usulkan untuk disepakati bersama.

Label keyakinan mengikuti konvensi ERP: **[Pasti]**, **[Kemungkinan]**, **[Perkiraan]**.

---

## 1. Ringkasan keputusan

**Keputusan POS (sudah diputuskan pemilik, 2026-10-21):**

- POS mematuhi model data ERP. ERP adalah master katalog (finished goods, outlet) dan sumber kebenaran ledger stok.
- POS melakukan reorganisasi besar (big-bang) backend Go ke struktur modul per fitur, sebelum launch.
- POS menambah ledger `stock_movements` (append-only), idempotency key pada semua penulis stok, dan kolom id eksternal ERP. Semua perubahan aditif.
- POS menyediakan relay keluar (outbox) yang mengirim setiap dokumen stok ke ERP.
- POS tetap pemilik harga jual, tampilan, bundel, promo, loyalti, dan **counter stok live per outlet** (tablet harus bekerja offline).

**Yang POS butuhkan dari ERP:** satu endpoint tulis untuk dokumen stok, satu field tambahan di katalog FG, saldo stok outlet yang diturunkan dari ledger, dan hosting yang dapat dijangkau. Rincian di §4.

**Target demo:** 2 November 2026. Lihat §8 untuk pembagian kerja dan tanggal.

---

## 2. Konteks: alur dan fitur POS hari ini

POS adalah aplikasi kasir offline-first (tablet Android, Capacitor) + backend Go (Cloud Run, Postgres Neon) + backoffice web. Tablet menyimpan jurnal lokal, lalu mengirim batch ke `POST /sync/batch`. Setiap item batch membawa `idempotencyKey` (`device_id:order_uuid`). Server menyimpan hasil per key di `processed_keys` dan mengulang hasil yang sama bila item dikirim ulang.

Setiap peristiwa berikut mengubah stok di POS. Semua peristiwa ini harus terbaca di ERP:

| Peristiwa | Asal | Arah stok | Dokumen di POS | Idempotency hari ini |
|---|---|---|---|---|
| Penjualan (`sale`) | Tablet | − per baris | `orders`, `order_items` | Ya |
| Refund (`refund`) | Tablet/backoffice | + per baris (qty yang direfund; satu dokumen per refund, bisa sebagian sejak C4a) | `order_refunds`, `order_refund_items` | Ya |
| Kirim transfer (`transfer_out`) | Backoffice | − sumber | `transfers`, `transfer_items` | Ya (sejak 2026-10-22) |
| Terima transfer (`transfer_in`) | Tablet/backoffice | + tujuan (qty aktual) | `transfers` | Ya |
| Batal transfer in-transit (`transfer_cancel`) | Backoffice | + sumber | `transfers` | Ya (sejak 2026-10-22) |
| Penerimaan barang (`receipt`) | Backoffice | + outlet/gudang | `goods_receipts` | Ya (sejak 2026-10-22) |
| Penyesuaian stok (`adjust`) | Backoffice | set absolut | `warehouse_stock_adjustments` | Ya (sejak 2026-10-22) |
| Stock opname (`count`) | Backoffice | delta per baris | `stock_counts`, `stock_count_items` | Ya (sejak 2026-10-22) |
| Saldo awal (`opening`) | Backfill (sudah dijalankan) | + | `stock_movements` | Ya |
| Hapus varian dengan stok (`write_off`) | Backoffice | − | ditolak (409) selama stok ≠ 0 | n/a |

Peristiwa lain yang **tidak** mengubah stok FG dan **tidak** dikirim ke ERP pada fase ini: buka/tutup shift, arus kas, pelanggan dan loyalti, promo, OTA. Bahan baku (ingredients) punya alur paralel di POS, tetapi penjualan belum mengonsumsi bahan baku. Lihat §9.

Model produk POS **[Pasti]**: `products` (induk: nama, brand, kategori, gambar, flag) → `product_variants` (anak: satu baris per ukuran; `size` teks, `price`, `sku`, `barcode`). Seluruh dokumen dan stok mengacu ke anak lewat pasangan `(product_id, variant_size)`. Harga jual ada di anak dan dapat di-override per outlet.

---

## 3. Yang sudah disediakan ERP dan akan dipakai POS

POS akan memakai Integration API v1 yang ada tanpa perubahan kontrak:

- `GET /catalog/finished-goods` — full sync dan incremental sync, protokol watermark sesuai `docs/integration/README.md`. POS upsert per `slug`, simpan `code` sebagai SKU varian, `status DISCONTINUE` atau `deleted_at` → varian nonaktif. Rekonsiliasi penuh setiap 24 jam.
- `GET /catalog/outlets` — POS upsert per `slug`. POS **tidak** menimpa `outlets.code` miliknya dari ERP (nomor struk bergantung pada kode outlet POS). POS menyimpan `code` ERP di kolom terpisah untuk memanggil endpoint stok.
- `GET /outlets/{code}/stock` — hanya untuk laporan rekonsiliasi (saldo ERP vs saldo POS). Tidak pernah dipakai sebagai sumber stok live.

Pemanggil adalah backend POS. Tablet dan browser tidak pernah memegang API key. Sesuai aturan ERP.

### 3.1 Permintaan perubahan kecil pada katalog (aditif, tetap v1)

| # | Permintaan | Alasan | Prioritas |
|---|---|---|---|
| K1 | Tambah field `product_slug` (atau nama lain) pada record FG katalog: id stabil induk produk yang menaungi beberapa ukuran. | POS butuh pengelompokan ukuran ke satu produk. Hari ini ERP `FinishGood` datar (satu baris per ukuran, tanpa `parent_id`). Developer ERP menyebut desain ERP "product-parent"; kami tidak menemukannya di schema `main` **[Pasti]**. Mohon tunjukkan tabel/kolomnya, atau tambahkan. | Tinggi (sebelum demo bila memungkinkan; bila tidak, POS memakai aturan pengelompokan sementara) |
| K2 | Konvensi `size` untuk barang non-ml (atomizer, tester, gift set, bundel). `finish_good_sizes.size` adalah integer. | POS menjual barang non-ml. | Tinggi |
| K3 | Konfirmasi: ERP tidak akan menyimpan harga jual. | POS tetap pemilik harga. | Konfirmasi saja |
| K4 | `code` FG dijamin unik lintas brand bila satu ERP melayani tiga brand. | Lihat §9 keputusan tenant. | Keputusan |

---

## 4. Yang harus disediakan ERP

### 4.1 Hosting (prasyarat demo)

ERP hari ini berjalan lokal (tanpa Docker, tanpa workflow deploy) **[Pasti]**. Backend POS berjalan di Cloud Run dan hanya dapat memanggil host publik HTTPS. Untuk demo, cukup satu instance yang dapat dijangkau (VPS, Cloud Run, atau tunnel stabil) dengan Postgres dan Redis.

### 4.2 Scope tulis baru

Tambahkan scope `integration:stock:write` ke registry scope (`packages/shared/src/integration/scope.ts`). Client POS mendapat scope `catalog:read`, `outlet-stock:read`, `stock:write`.

### 4.3 Endpoint: `POST /api/integration/v1/stock-documents`

> **Status 2026-10-26:** endpoint ini sudah digabung di `main` erp-flamboyan (rencana 1 dan 2; baris status README modul ERP
> masih menulis "not merged", itu sudah usang). Perbedaan dengan usulan di bawah, dan yang POS sudah sesuaikan:
> - `location` = `{ "type": "outlet", "code": "<kode outlet ERP>" }`. **Kuncinya `code`, bukan `slug`** (keputusan ERP
>   H01). POS mengirim `outlets.erp_code` (diisi saat tarik katalog menautkan outlet) dan, untuk satu rilis, juga
>   `slug`; ERP membuang field yang tidak dikenal sebelum menghitung hash.
> - Hanya outlet. Dokumen gudang ditolak 422 (K4 di luar lingkup), jadi POS **menahan** (`held`) dokumen gudang di
>   outbox, termasuk kaki `transfer_out` dari gudang; kaki `transfer_in` di outlet tetap terkirim.
> - Outlet harus diatur pada client pemanggil (`stock_outlet_codes`), selain itu 422 di `location.code`. POS menahan
>   dokumen seperti itu (tidak dead-letter, tanpa menghabiskan percobaan) dan membangun ulang body pada percobaan
>   berikutnya.
> - Tanda `qty` per kind: `sale`, `transfer_out`, `write_off` ≤ 0; `refund`, `transfer_in`, `transfer_cancel`,
>   `receipt` ≥ 0; `adjust`, `count`, `opening` bebas. Salah tanda → 422 → dead-letter.
> - Periode: bulan Asia/Jakarta dari `occurred_at`; lebih dari 24 jam ke depan → 422; lebih lama dari hari pertama
>   (bulan berjalan − 6 bulan) → 422. POS men-dead-letter dokumen itu dengan pesannya (tidak dicoba ulang terus).
> - Idempotensi per client API (bukan `pos:<brand>`); `Idempotency-Key` wajib sama dengan `document_id`
>   (tidak peka huruf besar/kecil); replay diperiksa sebelum validasi outlet, tanda, dan periode.
> - Sukses: `{ "status": "success", "data": { document_id, status, movement_ids } }`; 413 di atas 512 KB.

Satu endpoint untuk semua dokumen stok. Satu dokumen berisi satu atau lebih baris pergerakan. ERP memecah dokumen menjadi baris `stock_movements`.

**Header**

```
Authorization: Bearer erp_<prefix>_<secret>
Idempotency-Key: <document_id>
Content-Type: application/json
```

**Body**

```json
{
  "document_id": "0f1c…-uuid",
  "kind": "sale",
  "source": {
    "system": "pos",
    "brand": "mandalika",
    "device_id": "tab-07",
    "actor": "kasir uuid atau nama"
  },
  "location": { "type": "outlet", "code": "KMG", "slug": "kemang" },
  "occurred_at": "2026-11-02T03:15:20+07:00",
  "recorded_at": "2026-11-02T03:15:41Z",
  "ref": { "type": "order", "id": "order uuid", "number": "KMG-AB0004" },
  "lines": [
    {
      "movement_id": "7a9e…-uuid",
      "fg_code": "FG-001",
      "qty": -1,
      "qty_before": 42,
      "qty_after": 41,
      "unit_price": 150000,
      "discount": 0,
      "reason": "sale",
      "flags": []
    }
  ],
  "tenders": [ { "method": "qris", "amount": 150000 } ],
  "customer_ref": null
}
```

**Nilai `kind`:** `sale`, `refund`, `transfer_out`, `transfer_in`, `transfer_cancel`, `receipt`, `adjust`, `count`, `opening`, `write_off`.

**Aturan field**

| Field | Aturan |
|---|---|
| `document_id` | UUID dari backend POS. Kunci idempoten dokumen. Sama dengan header `Idempotency-Key`. |
| `kind` | Enum di atas. ERP memetakan ke `MovementType` IN/OUT/CORRECTION dan menyimpan `kind` di `reason`. |
| `source.brand` | Nama deployment POS. ERP memakai `idempotency_scope = "pos:<brand>"`. |
| `location` | `type` `outlet` (gudang: lihat status di atas); `code` adalah kode outlet ERP (`slug` ikut dikirim satu rilis, diabaikan ERP). Transfer antar lokasi dikirim sebagai dua dokumen (`transfer_out` di sumber, `transfer_in` di tujuan) dengan `ref.id` yang sama. |
| `occurred_at` | Waktu kejadian di perangkat (dapat lebih lama dari `recorded_at` karena offline). ERP memakai ini untuk `period_month`. |
| `recorded_at` | Waktu backend POS menerima. |
| `ref` | Dokumen asal di POS. `number` adalah nomor yang tercetak (struk, nomor transfer). |
| `lines[].movement_id` | UUID per baris, dari POS. ERP menyimpan sebagai `stock_movements.idempotency_key`. |
| `lines[].fg_code` | `code` FG di katalog ERP. ERP mengembalikan 422 bila tidak dikenal. |
| `lines[].qty` | Bertanda. Negatif = keluar. Integer. |
| `lines[].qty_before/qty_after` | Saldo POS di lokasi itu sebelum dan sesudah. Informasi untuk rekonsiliasi; ERP tidak wajib memakainya sebagai saldo. |
| `lines[].flags` | `shortage` bila penjualan membuat saldo POS negatif (oversell). ERP tetap mencatat pergerakan. |
| `tenders` | Hanya `sale` dan `refund`. `method` ∈ `cash`, `card`, `transfer`, `qris`. |
| `customer_ref` | Opsional. Id pelanggan POS bila ada. ERP boleh mengabaikan. |

**Respons**

```
200 { "success": true, "data": { "document_id": "...", "status": "applied", "movement_ids": ["..."] } }
200 { "success": true, "data": { "document_id": "...", "status": "replayed", "movement_ids": ["..."] } }
409 { "success": false, "code": "IDEMPOTENCY_CONFLICT", ... }   // key sama, body berbeda (bandingkan request_hash)
422 { "success": false, "code": "VALIDATION_ERROR", "details": [...] }  // fg_code / slug tidak dikenal, kind salah
403 { "success": false, "code": "INTEGRATION_FORBIDDEN_SCOPE" }
429 / 503 sesuai README yang ada
```

Permintaan ulang dengan `document_id` dan body yang sama harus mengembalikan `replayed` dan tidak menulis ulang. Ini penting karena relay POS mengulang pengiriman sampai mendapat 2xx.

**Yang ERP lakukan per dokumen [usulan]**

1. Resolve `location.slug` → `outlets.id` / `warehouses.id`; resolve setiap `fg_code` → `finish_goods.id`. Gagal salah satu → 422, tidak ada yang ditulis.
2. Dalam satu transaksi: insert satu `stock_movements` per baris dengan `entity_type FG`, `location_type` sesuai, `type` IN/OUT, `qty`, `period_month` dari `occurred_at`, `reason = kind`, `idempotency_scope = "pos:<brand>"`, `idempotency_key = movement_id`, `request_hash`. Tabel ini sudah ada dan sudah punya unique `(idempotency_scope, idempotency_key)` **[Pasti]**.
3. Perbarui saldo live per outlet (§4.4).
4. Simpan header dokumen (tabel baru, mis. `integration_stock_documents`) untuk replay dan audit.

### 4.4 Saldo stok outlet yang diturunkan dari ledger

`fg_stocks` hari ini adalah snapshot bulanan yang hanya berubah lewat import/adjust admin **[Pasti]**. Untuk menjadi sumber kebenaran, ERP perlu saldo per `(fg, outlet)` yang berubah oleh setiap `stock_movements` dari POS. Dua pilihan, ERP yang memutuskan:

- **A.** Tabel saldo live baru (`outlet_fg_balances`), diperbarui atomik bersama insert movement. `fg_stocks` bulanan menjadi snapshot penutupan yang diturunkan di akhir periode.
- **B.** `fg_stocks` baris bulan berjalan diperbarui langsung oleh movement. Lebih sedikit tabel, tetapi mengubah arti `fg_stocks` hari ini.

Kami menyarankan A. Dengan A, `GET /outlets/{code}/stock` dapat membaca saldo live tanpa mengubah kontraknya.

### 4.5 Endpoint baca untuk rekonsiliasi (setelah demo)

- `GET /api/integration/v1/stock-documents/{document_id}` — status dokumen, untuk tombol "cek di ERP" di backoffice POS.
- `GET /api/integration/v1/outlets/{code}/movements?since=&cursor=` — daftar movement, untuk laporan selisih.

### 4.6 Batas dan operasional

- Rate limit 600/menit per client cukup. POS mengirim batch kecil setiap 1–5 menit, bukan per transaksi sinkron.
- Ukuran body: satu dokumen ≤ 200 baris. POS memecah dokumen yang lebih besar (stock opname) menjadi beberapa dokumen dengan `ref.id` sama dan `part` berbeda bila ERP menginginkannya.
- Penghapusan permanen FG di ERP harus menolak bila FG punya movement dari POS, atau movement tetap tersimpan dengan tombstone.

---

## 5. Yang dilakukan POS

**Status 2026-10-22: semua butir di bawah SELESAI dan berjalan di lingkungan uji.** Rincian: ledger
`stock_movements` (migrasi 0064) ditulis dalam transaksi yang sama oleh setiap penulis stok; outbox `erp_outbox` (0065) diisi
oleh ledger; relay dan tarik katalog siap tetapi dimatikan; kolom id eksternal (0066) ada; pemetaan SKU satu kali menunggu
ekspor `code` + `slug` dari ERP (Q6).

| # | Pekerjaan | Perubahan | Catatan |
|---|---|---|---|
| P-A | Reorganisasi backend Go ke modul per fitur (`internal/catalog`, `internal/stock`, `internal/orders`, …) dengan tes aturan dependensi. | Tanpa perubahan perilaku. CI harus hijau sebelum pekerjaan lain. | Menjawab temuan developer ERP tentang struktur. |
| P-B | Ledger `stock_movements` (append-only) ditulis dalam transaksi yang sama oleh **setiap** penulis stok; backfill `opening` per baris stok yang ada. | Migrasi aditif. | Tanpa ini, "setiap peristiwa terlacak" tidak mungkin. |
| P-C | Idempotency key pada penerimaan barang, kirim transfer, batal transfer, adjust, stock opname. | Migrasi aditif. | |
| P-D | Blokir hapus varian yang masih punya stok (atau catat `write_off`); hentikan penulisan kolom `product_variants.stock`; hentikan seeding stok saat buat produk bila ERP master. | | |
| P-E | Kolom id eksternal: `product_variants.erp_slug`, `products.erp_group_key`, `outlets.erp_slug`, `outlets.erp_code`. SKU varian menjadi unik global dan sama dengan `code` FG. Pemetaan satu kali untuk varian yang sudah ada. | Migrasi aditif. | |
| P-F | Job tarik katalog (Cloud Scheduler → endpoint admin), client Go dari `openapi.v1.json` ERP, watermark, rekonsiliasi 24 jam. | | Memakai API ERP yang sudah ada. |
| P-G | Outbox `erp_outbox` + relay terjadwal + dead-letter yang tampil di backoffice. | | Menunggu §4.3 di ERP. Untuk demo, POS dapat memakai stub yang mengikuti kontrak §4.3 bila ERP belum siap. |
| P-H | Laporan rekonsiliasi harian: saldo POS vs saldo ERP per outlet × SKU. | | Setelah demo. |

Hal yang tetap di POS dan tidak dikirim ke ERP: harga dan override harga per outlet, bundel, promo, loyalti, pelanggan, shift, arus kas, OTA.

---

## 6. Desain target yang diusulkan untuk disepakati

```
Tablet (jurnal offline) ──POST /sync/batch──▶ Backend POS (Cloud Run)
                                               │ satu transaksi: dokumen + saldo live + baris stock_movements + baris erp_outbox
                                               ▼
                                          erp_outbox (idempoten, retry, dead-letter)
                                               │ Cloud Scheduler → /admin/erp/relay tiap 1–5 menit
                                               ▼
                               ERP  POST /api/integration/v1/stock-documents
                                               │
                                     ERP stock_movements (ledger, unique scope+key)
                                               │ turunan
                                     saldo live per outlet + snapshot bulanan fg_stocks
Backend POS ◀── poll + watermark ── ERP katalog FG dan outlet            (sudah ada)
Backend POS ◀── laporan harian ─── saldo ERP vs saldo POS → selisih → dokumen adjust yang disetujui manusia
```

Aturan desain:

1. **Dua sumber kebenaran, dipisah oleh pertanyaan.** POS menjawab "berapa stok di rak outlet X sekarang" dan "apa yang dijual kasir ini" (harus bisa offline). ERP menjawab "berapa posisi stok tervaluasi dan tertutup periode; apa yang dibeli, diproduksi, dipindah, dan dijual" untuk seluruh perusahaan. ERP memegang ledger; POS memegang counter live. Keduanya diturunkan dari baris movement yang sama, jadi selalu sama setelah sinkron.
2. **Satuan integrasi adalah movement, dibawa oleh dokumennya.** POS mengirim dokumen; ERP memecahnya menjadi movement. Saldo tidak pernah dikirim sebagai umpan utama; saldo hanya untuk rekonsiliasi.
3. **Idempoten ujung ke ujung.** `movement_id` dibuat di backend POS, disimpan ERP sebagai `(scope, key)`. Pengiriman ulang mengembalikan hasil yang tersimpan.
4. **Near-real-time, bukan sinkron.** Penjualan commit di POS dulu; ERP tahu dalam hitungan menit. Penulisan POS tidak pernah menunggu ERP. Penutupan bulan ERP adalah snapshot turunan, bukan input.
5. **Katalog turun, movement naik.** ERP memiliki identitas dan siklus hidup FG. POS memiliki harga, tampilan, bundel, loyalti, dan counter live. Koreksi stok dari ERP turun sebagai dokumen adjust (fase berikutnya).
6. **Rekonsiliasi harian adalah laporan, bukan penulisan.**

Pola ini sama dengan praktik umum: POS memiliki stok live, ERP/akuntansi menerima dokumen secara berkala (Moka → Accurate/Jurnal, Pawoon → Accurate menarik transaksi tiap 1–2 jam), dan setiap perubahan kuantitas adalah baris ledger (Odoo `stock.move`). Perbedaan kami: dokumen dikirim per peristiwa dalam hitungan menit, bukan tarikan per jam.

---

## 7. Pemetaan field

| ERP | POS | Aturan |
|---|---|---|
| FG `code` | `product_variants.sku` | Sama persis. Unik global di POS. |
| FG `slug` | `product_variants.erp_slug` | Kunci upsert. |
| FG `product_slug` (K1, usulan) | `products.erp_group_key` | Kunci pengelompokan induk. Sementara: aturan nama tanpa ukuran dalam kategori yang sama. |
| FG `name` | `products.name` | Nama induk; POS menampilkan ukuran dari anak. |
| FG `size` (Int ml) | `product_variants.size` (teks) | POS menurunkan label sekali saat varian dibuat; tidak pernah mengganti nama ukuran yang sudah punya stok secara otomatis. |
| FG `category` | `categories` | Upsert per nama. |
| FG `status`, `deleted_at` | `product_variants` aktif / `products.is_active` | `DISCONTINUE` atau tombstone → nonaktif. Produk nonaktif bila semua anak nonaktif. |
| FG `unit`, `gender`, `is_others` | disimpan, tidak dipakai | |
| Harga | `product_variants.price`, `outlet_variant_price` | Milik POS. |
| Outlet `slug` | `outlets.erp_slug` | Kunci upsert. |
| Outlet `code` | `outlets.erp_code` | Dipakai untuk `GET /outlets/{code}/stock`. **Bukan** `outlets.code` POS. |
| Outlet `name`, `type`, alamat | `outlets.*` | Diperbarui dari ERP. |
| `stock_movements` | `stock_movements` POS | Satu banding satu lewat `movement_id`. |
| Saldo outlet ERP (`qty`, GOOD) | `outlet_variant_stock.stock` | Hanya dibandingkan di laporan rekonsiliasi. |

---

## 8. Timeline demo 2 November 2026 dan pembagian kerja

**Status 2026-10-22: seluruh kolom POS di tabel ini selesai lebih awal.** Yang tersisa: kolom ERP (hosting, scope tulis,
endpoint `stock-documents`, saldo live, client + API key) dan jawaban §11. Tanggal uji bersama bergeser mengikuti kesiapan ERP.

Hari kerja tersisa: 22, 23, 26, 27, 28, 29, 30 Oktober (7 hari). 2 November adalah hari demo.

| Tanggal | ERP | POS |
|---|---|---|
| 22–23 Okt | Sepakati dokumen ini (§4.3, §4.4, K1, K2, tenant). Mulai hosting. | Reorganisasi backend (mekanis, CI hijau). |
| 24–27 Okt | Scope `stock:write`, endpoint `stock-documents`, resolver, header dokumen, saldo live (opsi A). Deploy ke host demo. Buat client + API key untuk POS. | Ledger + key + blokir jalur tanpa dokumen (P-B, P-C, P-D). Kolom id eksternal + pemetaan SKU (P-E). |
| 28–29 Okt | Uji endpoint dengan smoke test ERP (`integration:smoke`) + contoh dokumen dari dokumen ini. | Job tarik katalog (P-F). Outbox + relay (P-G) ke endpoint ERP; stub bila ERP belum siap. |
| 30 Okt | Uji bersama ujung ke ujung: FG baru di ERP → muncul di POS; jual di tablet → movement di ERP; refund; transfer. | Sama. Perbaiki temuan. |
| 2 Nov | Demo. | Demo. |

Lingkup demo yang realistis: katalog turun, penjualan dan refund naik, transfer naik, saldo ERP berubah, dokumen ulang tidak ganda. Di luar lingkup demo: rekonsiliasi harian, koreksi dari ERP ke POS, bahan baku, laporan movement di ERP.

---

## 9. Keputusan dan pertanyaan terbuka

Keputusan yang dibutuhkan dari ERP (atau pemilik):

1. **Tenant.** Tiga brand (Mandalika, Flamboyan, Performance): satu instance ERP per brand, atau satu ERP untuk semua dengan `code` unik global dan client per brand? ERP hari ini tidak punya model organisasi **[Pasti]**.
2. **Induk produk (K1).** Tabel/kolom mana yang menjadi induk, atau apakah `product_slug` ditambahkan?
3. **Ukuran non-ml (K2).**
4. **Saldo live (§4.4):** opsi A atau B.
5. **Oversell.** POS mengizinkan saldo negatif (dengan peringatan dan catatan). Apakah ERP menerima movement dengan `flags: ["shortage"]` dan mencatat saldo negatif, atau menahan? Usulan: terima dan catat.
6. **Bahan baku.** POS belum mengonsumsi bahan baku saat penjualan. Apakah konsumsi RM dihitung ERP dari resep/BOM berdasarkan movement `sale`, atau di luar lingkup? Usulan: di luar lingkup fase 1; ERP menghitung dari BOM bila perlu.
7. **Tender dan pelanggan.** Apakah ERP memerlukan `tenders` dan `customer_ref` sekarang, atau cukup kuantitas? Usulan: terima dan simpan, belum dipakai.
8. **Penerimaan barang dari PO ERP.** Bila barang datang ke outlet dari PO yang dibuat di ERP, siapa yang mencatat penerimaan: POS (`receipt` naik ke ERP) atau ERP (turun ke POS)? Usulan fase 1: POS mencatat; ERP mencocokkan ke PO secara manual.

Pertanyaan untuk developer ERP:

- Apakah spec domain Sales sudah mulai dirancang? Dokumen ini dapat menjadi dasarnya.
- Di mana ERP akan di-host, dan kapan host demo tersedia?
- Berapa lama `revoke` key berlaku di host demo (README: ≤ 60 detik)?
- Apakah `finish_goods.code` boleh dipakai sebagai SKU tercetak di struk POS?

---

## 10. Lampiran: contoh dokumen per `kind`

```json
// refund seluruh order
{ "document_id": "…", "kind": "refund", "location": { "type": "outlet", "slug": "kemang" },
  "ref": { "type": "order", "id": "order uuid", "number": "KMG-AB0004" },
  "lines": [ { "movement_id": "…", "fg_code": "FG-001", "qty": 1, "qty_before": 41, "qty_after": 42, "reason": "refund",
               "refund_of_movement_id": "7a9e…" } ],
  "tenders": [ { "method": "cash", "amount": -150000 } ] }

// transfer: dua dokumen, ref.id sama
{ "document_id": "…", "kind": "transfer_out", "location": { "type": "warehouse", "slug": "gudang-pusat" },
  "ref": { "type": "transfer", "id": "transfer uuid", "number": "TRF-000123" },
  "lines": [ { "movement_id": "…", "fg_code": "FG-001", "qty": -10, "qty_before": 100, "qty_after": 90, "reason": "transfer_out" } ] }
{ "document_id": "…", "kind": "transfer_in", "location": { "type": "outlet", "slug": "kemang" },
  "ref": { "type": "transfer", "id": "transfer uuid", "number": "TRF-000123" },
  "lines": [ { "movement_id": "…", "fg_code": "FG-001", "qty": 9, "qty_before": 41, "qty_after": 50, "reason": "transfer_in",
               "expected_qty": 10 } ] }

// stock opname
{ "document_id": "…", "kind": "count", "location": { "type": "outlet", "slug": "kemang" },
  "ref": { "type": "stock_count", "id": "count uuid", "number": "SO-2026-11-01" },
  "lines": [ { "movement_id": "…", "fg_code": "FG-001", "qty": -2, "qty_before": 50, "qty_after": 48, "reason": "count" } ] }

// saldo awal (backfill satu kali)
{ "document_id": "…", "kind": "opening", "location": { "type": "outlet", "slug": "kemang" },
  "ref": { "type": "backfill", "id": "2026-10-27", "number": "OPENING-KMG" },
  "lines": [ { "movement_id": "…", "fg_code": "FG-001", "qty": 42, "qty_before": 0, "qty_after": 42, "reason": "opening" } ] }
```

---

## 11. Daftar pertanyaan terbuka terkonsolidasi (status 2026-10-22; §11.4 ditambah 2026-10-26)

Semua langkah kode di sisi POS sudah selesai dan digabung (reorganisasi, ledger `stock_movements`, outbox + relay, tarik
katalog + id eksternal). Backend dengan ledger dan outbox sudah berjalan di lingkungan uji (relay masih mati; akan dinyalakan
saat ERP punya endpoint tulis). Daftar ini menggabungkan §9, §4, dan temuan implementasi. **[D]** = perlu jawaban sebelum demo
2 Nov; yang lain boleh menyusul.

### 11.1 Katalog dan identitas

| # | Pertanyaan | Konteks |
|---|---|---|
| Q1 **[D]** | Induk produk: apakah ERP menambah `product_slug` (atau field setara) di record FG katalog? Bila tidak, POS memakai aturan "nama tanpa ukuran dalam kategori yang sama" sebagai `erp_group_key` sementara. | §3.1 K1, §14.4 analisis |
| Q2 **[D]** | Konvensi `size` non-ml (`finish_good_sizes.size` integer). Hari ini POS menurunkan label "30pcs" bila `unit` = PCS. Apakah itu benar, dan bagaimana tester, gift set, bundel? | §3.1 K2 |
| Q3 **[D]** | Apakah FG berstatus `PENDING` boleh dijual? | **DIJAWAB (pemilik, 2026-10-22): tidak boleh dijual.** POS kini memperlakukan `PENDING`, `DISCONTINUE`, dan tombstone sebagai nonaktif; `ACTIVE`, `FAVOURITE`, `NEW_LAUNCHING` aktif. |
| Q4 | Perubahan nama kategori, unit, atau nilai `size` tidak mengubah `updated_at` FG (README ERP). POS hanya melihatnya pada full run harian. Bisakah ERP mem-bump `updated_at` FG saat data turunan berubah? | README §Full sync |
| Q5 | Hapus permanen (purge) dari trash hanya tertangkap oleh full reconcile. Apakah ada jeda minimum sebelum purge, atau endpoint daftar id yang dipurge? | README §Record yang dihapus |
| Q6 **[D]** | Ekspor `code` + `slug` FG (CSV) untuk pemetaan SKU satu kali di POS. Bisakah ERP menyediakannya dari UI atau endpoint? | pemetaan SKU |
| Q7 | Gudang: tidak ada endpoint katalog gudang. POS mengirim dokumen dengan `location.type = "warehouse"` dan butuh `slug` gudang ERP. Apakah akan ada `GET /catalog/warehouses`? | **DIJAWAB (kode ERP digabung 2026-10-26): gudang di luar lingkup (K4), 422.** POS menahan semua dokumen gudang di outbox. |
| Q8 | Spec dipublikasikan sebagai OpenAPI 3.1. Generator Go POS (oapi-codegen v2.7.2) butuh 3.0, jadi POS menurunkan versi secara mekanis. Bisakah ERP juga menerbitkan 3.0, atau konfirmasi bahwa konversi `type: [x, "null"]` menjadi `nullable: true` cukup? | §4.3 klien |
| Q9 **[D]** | Tenant: satu ERP per brand, atau satu ERP untuk tiga brand? | **DIJAWAB (pemilik, 2026-10-22): satu ERP per brand.** Scope `pos:<brand>` per deployment; tidak perlu scoping client per outlet. |
| Q10 **[D]** | Hosting: di mana ERP di-host untuk demo, dan kapan API key client POS tersedia? | §4.1 |

### 11.2 Kontrak `POST /stock-documents` (yang POS sudah implementasikan)

POS sudah mengirim dokumen sesuai §4.3 dan file `docs/integration/stock-documents.v1.yaml`. Butir berikut adalah perbedaan
atau detail yang perlu disepakati agar ERP tidak menolak dokumen yang sah.

| # | Pertanyaan | Perilaku POS saat ini |
|---|---|---|
| Q11 **[D]** | **DIJAWAB (kode ERP 2026-10-26): replay diperiksa setelah skema, sebelum outlet/tanda/periode/FG/movement_id.** Urutan idempotensi vs validasi: pemeriksaan `document_id` harus dilakukan **sebelum** validasi isi. Bila validasi dulu, kirim ulang setelah timeout mendapat 422 "movement_id sudah dipakai" dan POS men-dead-letter dokumen yang sebenarnya sudah diterima. Stub POS memeriksa idempotensi dulu; mohon samakan dan perbaiki kalimat di yaml. | kirim ulang = key sama, body sama, harap `replayed` |
| Q12 **[D]** | Tidak ada jaminan urutan antar dokumen: `refund` bisa tiba sebelum `sale`-nya, `transfer_in` sebelum `transfer_out`, part dalam urutan acak. ERP harus menerapkan tiap dokumen secara independen (saldo sementara negatif diizinkan). Setuju? | relay paralel, retry per dokumen |
| Q13 **[D]** | **DIJAWAB (kode ERP 2026-10-26): 403 hanya untuk scope/suspended; outlet yang tidak diatur pada client = 422 di `location.code`, yang POS tahan (bukan dead-letter).** 401/403 vs 400/409/422: POS memperlakukan 401 dan 403 sebagai kondisi **seluruh client** (jeda, coba lagi nanti) dan 400/409/422 sebagai masalah **dokumen** (dead-letter). Mohon pakai 403 hanya untuk kondisi client (scope, suspended), bukan per dokumen. | §4.3 respons |
| Q14 **[D]** | **DIJAWAB: ERP mengembalikan `data.document_id`, `data.status` (`applied`/`replayed`) dan `movement_ids`.** Body 2xx: POS mewajibkan `data.document_id` (echo) dan `data.status` bernilai `applied` atau `replayed`. | §4.3 |
| Q15 | Nilai `ref.type` yang POS kirim: `order`, `transfer`, `goods_receipt`, `stock_adjustment`, `stock_count`, `backfill` (contoh §10 memakai `receipt` / `adjustment`; nilai di atas yang benar). | §10 |
| Q16 | `tenders`: metode pembayaran POS bebas; hanya `cash`, `card`, `transfer`, `qris` yang dikirim, lainnya dilewati. Tender `sale` hanya di part 1; tender `refund` = minus jumlah refund (`order_refunds.amount`, jumlah yang dibayarkan di kasir, dibatasi sisa yang masih bisa direfund (D-49), bisa 0; pada refund seluruh order sama dengan total order). Sejak C4a satu order bisa punya beberapa dokumen `refund` (satu per refund, `document key` `refund:<refund id>`, refund lama `refund:<order id>`), baris `qty` = qty yang direfund, `unit_price` tetap harga kotor `order_items.price`. | §4.3 |
| Q17 | Dokumen `opening` (backfill): `ref.type = backfill`, `ref.id` = uuid dokumen part 0, `ref.number` kosong; baris boleh `qty = 0` dengan `qty_before` = jumlah ledger sebelumnya. Apakah baris qty 0 diterima? | rencana §2.4 |
| Q18 | `part.count` = jumlah part untuk `ref.id` itu saat di-queue; part yang semua barisnya sudah tercatat di tempat lain tidak dikirim. | §4.6 |
| Q19 | `transfer_in`: `expected_qty` = qty kirim; `flags: ["variance"]` bila terima tidak sama dengan kirim. `flags: ["shortage"]` pada baris `sale` yang oversold. | §4.3 flags |
| Q20 | `occurred_at` dan `recorded_at` dalam UTC (`Z`, presisi detik); `recorded_at` = waktu enqueue di backend POS, tetap sama pada retry. | §4.3 |
| Q21 | Belum dikirim: `customer_ref`, `discount`, dan `unit_price` untuk kind selain `sale`. Apakah ERP membutuhkannya di v1? | §4.3 |
| Q22 | `Retry-After`: POS menerima detik (integer) atau HTTP-date, dan membatasi maksimum 1 jam. | §4.6 |

### 11.3 Keputusan yang sudah diambil POS (informasi)

- Rekonsiliasi outlet hanya laporan; pull katalog hanya menonaktifkan (`is_active`) dan tidak pernah menghapus.
- Outlet ERP terhubung otomatis ke outlet POS hanya bila `code` sama persis; selain itu dipetakan manual. `outlets.code` POS tidak pernah ditimpa.
- Varian terhubung hanya lewat pemetaan SKU (CSV: SKU lama ke `code` FG, impor dry-run lalu commit); pull tidak pernah menautkan berdasarkan kesamaan SKU.
- Keunikan global SKU (migrasi 0067) dikirim sebagai deploy terpisah setelah jumlah duplikat di DB uji = 0.
- Jadwal tarik katalog (saat diaktifkan): incremental tiap 15 menit, full 02:07 WIB. Relay stok tiap 2 menit.

### 11.4 Pertanyaan baru setelah kode ERP digabung (2026-10-26)

Sisi POS sudah menyesuaikan diri dengan kode ERP di `main` (lihat status di §4.3): POS mengirim `location.code`, menahan
dokumen gudang, menahan dokumen yang outletnya belum diatur pada client, dan men-dead-letter 409/422 lainnya dengan
pesannya. Yang masih perlu dijawab pengembang ERP:

| # | Pertanyaan | Konteks |
|---|---|---|
| Q23 **[D]** | Kapan kode `main` (rencana 1 + 2, migrasi `20261026022551`, `20261026041607`, `20261026090000`) terpasang di `https://erp.mandalika.web.id`? Relay POS baru dinyalakan setelah itu. | runbook cutover langkah 9 |
| Q24 **[D]** | Client `pos_mandalika` per 2026-10-26 pagi hanya punya dua scope baca. Mohon admin ERP menambah `integration:stock:write` dan mengatur outlet BSD, LWB, MKS, PMS (kode ERP-nya) pada client itu **sebelum** relay dinyalakan. Tanpa itu setiap dokumen mendapat 403 (POS jeda) atau 422 `location.code` (POS tahan). | BR5, AC10 |
| Q25 | Jendela periode vs `opening` hasil backfill: `opening` dihitung saat backfill (`occurred_at` = waktu backfill) dari stok live dikurangi semua pergerakan ledger sebelumnya. Pergerakan yang `occurred_at`-nya lebih lama dari 6 bulan saat dikirim (mis. dokumen yang lama tertahan karena varian belum dipetakan) ditolak 422, sehingga saldo ERP kurang tepat sebesar pergerakan itu. Apakah ERP bisa menerima dokumen lama ke periode tertentu (mis. dipindah ke bulan tertua yang terbuka), atau POS sebaiknya mengirim satu `adjust` pengganti saat cutover? Hari ini ledger POS dimulai Oktober 2026, jadi belum ada yang terkena. | BR12, BR10 |
| Q26 | `slug`: aturan H01 menyatakan slug bukan pengenal kontrak. Konfirmasi bahwa field `location.slug` akan tetap dibuang tanpa error (Zod `z.object`, bukan `strict`), dan POS boleh berhenti mengirimnya mulai rilis berikutnya. | BR15, H01 |
| Q27 | Baris status README modul `docs/modules/integration/stock-document/README.md` masih menulis kedua rencana "not merged", padahal sudah di `main`. Mohon perbarui (sekalian tanggal deploy) agar kedua tim membaca status yang sama. | dokumen ERP |
| Q28 **[D]** | **BARU 2026-10-28 (C4a, per-baris refund; E-1)** Apakah ERP menerima beberapa dokumen `refund` dengan `ref.id` (order) yang sama? Sebelumnya tiap order paling banyak satu. | §4.3 |
| Q29 **[D]** | **BARU (E-2)** Apakah tender refund boleh tidak sama dengan Σ(`unit_price` × `qty`) baris refund, karena tender sudah dikurangi diskon? Atau ERP ingin `unit_price` bersih (`net_amount / quantity`) pada baris refund? POS saat ini mengirim harga kotor + tender bersih. | §4.3 |
| Q30 **[D]** | **BARU (E-3)** Apakah ERP memeriksa total qty refund ≤ qty terjual per `refund_of_movement_id`? Jika ya, urutan tiba penting (lihat Q12: refund bisa tiba sebelum sale). | §4.3 |
| Q31 | **BARU (E-4)** Apakah dokumen refund tanpa baris tetapi dengan tender diterima? (Hanya diperlukan bila kelak ada refund "tidak dikembalikan ke stok"; v1 selalu mengembalikan stok.) | §4.3 |
| Q32 | **BARU (E-5)** Teks kontrak "refund selalu seluruh order" sudah diganti di dokumen ini dan di `stock-documents.v1.yaml`: satu dokumen per refund, boleh sebagian. Mohon konfirmasi. | §4.3 |
