# Permintaan endpoint: buat outlet dari POS / Request: create outlet from the POS

Tanggal / Date: 2026-11-24. Dari / From: tim POS Mandalika. Untuk / To: tim ERP (integration API).

---

## Bahasa Indonesia

### Latar belakang

Outlet baru yang dibuat di POS (contoh: GANCIT, MANDALIKA GANDARIA CITY) belum ada di ERP. Penjualannya tertahan di antrean kirim POS sampai outlet itu ada di ERP. Saat ini integration API hanya punya `GET /outlets` dan `GET /outlets/:code`. Scope `integration:outlet:write` sudah ada, tetapi belum dipakai endpoint apa pun.

Arah sebaliknya (outlet baru di ERP muncul di POS) dikerjakan di sisi POS lewat tarikan katalog yang sudah ada, jadi tidak perlu perubahan di ERP.

### Yang kami minta

`POST /api/integration/v1/outlets`, scope `integration:outlet:write`. Mohon tambahkan scope ini ke client `pos_mandalika` (staging dulu, produksi nanti).

**Header**
- `Idempotency-Key`: wajib, harus sama dengan `external_id` di body (sama seperti `POST /stock-documents` dengan `document_id`).

**Body (JSON)**

| Field | Tipe | Wajib | Keterangan |
|---|---|---|---|
| `external_id` | string (UUID) | ya | ID outlet di POS. Disimpan ERP agar kiriman ulang dikenali. |
| `code` | string | ya | 2-20 karakter `A-Z 0-9 -`, diawali dan diakhiri huruf/angka. Unik di ERP (tanpa beda huruf besar/kecil). |
| `name` | string | ya | Nama outlet. |
| `type` | `RETAIL` \| `POPUP` | ya | POS selalu mengirim `RETAIL`. Admin ERP boleh mengubahnya nanti. `ONLINE` tidak dikirim POS. |
| `address` | string \| null | tidak | |
| `phone` | string \| null | tidak | |

**Sukses**
- `201` (dibuat) atau `200` (kiriman ulang dengan key dan body yang sama). Dua-duanya boleh `200` bila itu kebiasaan API.
- Body: `{ "success": true, "data": { "status": "applied" | "replayed", "outlet": { "slug", "code", "name", "type", "address", "phone", "created_at", "updated_at" } } }`.
- `slug` wajib ada. POS memakainya sebagai kunci tetap.
- Setelah dibuat, outlet ini harus ikut muncul di `GET /outlets` (dengan `updated_at` baru) seperti outlet lain.

**Gagal** (amplop error yang sama dengan endpoint lain: `{ success:false, error, message, code, details?, requestId }`)

| HTTP | `code` | Kapan | Yang dilakukan POS |
|---|---|---|---|
| 409 | `OUTLET_CODE_TAKEN` | `code` sudah dipakai outlet lain di ERP (dengan `external_id` berbeda atau tanpa `external_id`). `details.slug` = slug outlet yang memakai kode itu. | Tidak menautkan otomatis. Dicatat untuk admin. |
| 409 | `CONFLICT` | `Idempotency-Key` sudah dipakai untuk body lain. | Dicatat untuk admin. Pada tarikan berikutnya POS menyusun body dari data outlet POS saat itu dengan kunci (UUID) yang sama, jadi body bisa berbeda dari kiriman sebelumnya. |
| 422 | `VALIDATION_ERROR` | Field tidak valid, atau `Idempotency-Key` ≠ `external_id`. `details` menyebut field-nya. | Dicatat untuk admin. |
| 401/403 | | Key salah atau scope belum ada. | Dicatat, dicoba lagi pada tarikan berikutnya. |

**Idempotensi:** kiriman dengan `external_id` yang sudah pernah dibuat, dengan body sama, menjawab outlet yang sama (`replayed`), bukan outlet kedua. Ini penting karena POS mengirim ulang bila jawaban hilang di jaringan.

**Di luar permintaan ini:** ubah atau hapus outlet dari POS. Setelah outlet ada di kedua sisi, tiap sisi memegang namanya sendiri; POS hanya mengikuti perubahan kode ERP dan penghapusan lewat tarikan.

### Cara POS memakainya

POS mengirim paling banyak 10 outlet per tarikan (tiap 15 menit), hanya outlet aktif yang belum punya pasangan di ERP. Fitur ini mati sampai endpoint ada di staging dan pemilik menyalakannya. Pengujian pertama di staging hanya dengan persetujuan pemilik.

### Pertanyaan untuk tim ERP

0. Outlet yang dibuat lewat endpoint ini (dan outlet baru di ERP pada umumnya) perlu otomatis terdaftar untuk client `pos_mandalika`, agar POS bisa mengirim penjualan dan stok ke outlet itu. Saat ini di staging client ini hanya untuk BSD, LWB dan MKS. Bisakah itu otomatis? Bila tidak, bagaimana cara mendaftarkannya?
1. Apakah outlet baru dari API perlu field lain agar bisa dipakai di ERP (gudang default, supplier, koordinat)? Bila ya, apa default-nya?
2. Bolehkah `201` untuk buat baru, atau API selalu `200`?
3. Kapan kira-kira tersedia di staging?
4. Mohon `Idempotency-Key` hanya diikat ke body bila kiriman BERHASIL. Bila kiriman ditolak dengan 422 lalu admin memperbaiki data outlet di POS, kiriman berikutnya (kunci sama, body baru) tidak boleh terkunci selamanya di `CONFLICT`.

---

## English

### Background

Outlets created in the POS (example: GANCIT, MANDALIKA GANDARIA CITY) do not exist in the ERP. Their sales wait in the POS sending queue until the outlet exists in the ERP. Today the integration API has only `GET /outlets` and `GET /outlets/:code`. The scope `integration:outlet:write` exists, but no endpoint uses it.

The other direction (a new ERP outlet appears in the POS) is handled on the POS side by the existing catalog pull. It needs no ERP change.

### What we ask for

`POST /api/integration/v1/outlets`, scope `integration:outlet:write`. Please add the scope to client `pos_mandalika` (staging first, production later).

**Header**
- `Idempotency-Key`: required, must equal body `external_id` (same rule as `POST /stock-documents` with `document_id`).

**Body (JSON)**

| Field | Type | Required | Notes |
|---|---|---|---|
| `external_id` | string (UUID) | yes | The POS outlet id. The ERP stores it so a re-send is recognised. |
| `code` | string | yes | 2-20 chars of `A-Z 0-9 -`, starting and ending with a letter or digit. Unique in the ERP, case-insensitive. |
| `name` | string | yes | Outlet name. |
| `type` | `RETAIL` \| `POPUP` | yes | The POS always sends `RETAIL`. An ERP admin may change it later. The POS never sends `ONLINE`. |
| `address` | string \| null | no | |
| `phone` | string \| null | no | |

**Success**
- `201` (created) or `200` (re-send with the same key and body). Both may be `200` if that is the API's habit.
- Body: `{ "success": true, "data": { "status": "applied" | "replayed", "outlet": { "slug", "code", "name", "type", "address", "phone", "created_at", "updated_at" } } }`.
- `slug` is required. The POS uses it as the stable key.
- Once created, the outlet must appear in `GET /outlets` (with a fresh `updated_at`) like any other outlet.

**Errors** (same envelope as the other endpoints: `{ success:false, error, message, code, details?, requestId }`)

| HTTP | `code` | When | What the POS does |
|---|---|---|---|
| 409 | `OUTLET_CODE_TAKEN` | `code` is already used by another ERP outlet (with a different or no `external_id`). `details.slug` = the slug of the outlet holding the code. | Does not link automatically. Notes it for an admin. |
| 409 | `CONFLICT` | `Idempotency-Key` already used for a different body. | Notes it for an admin. On the next pull the POS rebuilds the body from the current POS outlet with the same key (UUID), so the body can differ from the earlier send. |
| 422 | `VALIDATION_ERROR` | A field is invalid, or `Idempotency-Key` ≠ `external_id`. `details` names the field. | Notes it for an admin. |
| 401/403 | | Wrong key or missing scope. | Notes it, retries on the next pull. |

**Idempotency:** a send with an `external_id` that was already created, with the same body, answers the same outlet (`replayed`), never a second outlet. This matters because the POS re-sends when a response is lost on the network.

**Out of scope:** editing or deleting outlets from the POS. Once an outlet exists on both sides, each side keeps its own name; the POS only follows ERP code changes and deletions through the pull.

### How the POS will use it

The POS sends at most 10 outlets per pull (every 15 minutes), only active outlets with no ERP twin yet. The feature stays off until the endpoint is on staging and the owner turns it on. The first staging test happens only with the owner's approval.

### Questions for the ERP team

0. An outlet created through this endpoint (and any new ERP outlet) needs to be registered for client `pos_mandalika` automatically, so the POS can send sales and stock for it. On staging this client is set up only for BSD, LWB and MKS today. Can that be automatic? If not, how is it done?
1. Does an outlet created through the API need other fields to be usable in the ERP (default warehouse, suppliers, coordinates)? If so, what defaults?
2. Is `201` fine for a new outlet, or does the API always answer `200`?
3. Roughly when could it be on staging?
4. Please bind the `Idempotency-Key` to the body only when the request SUCCEEDS. If a request is rejected with 422 and an admin then corrects the outlet in the POS, the next send (same key, new body) must not be stuck in a permanent `CONFLICT`.
