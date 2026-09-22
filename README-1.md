# GMGN Alert Bot

Bot Telegram yang memantau koin trending di Solana (mirip menu "temukan" GMGN,
diurutkan volume tinggi ke rendah), lalu mengirim notifikasi saat sebuah token
mengalami satu siklus **pump lalu dump**.

## Definisi siklus

- **PUMP_THRESHOLD** (`PRICE_HIGH`, default `0.0001`): siklus dimulai saat
  harga token pertama kali mencapai atau melewati nilai ini.
- **DUMP_THRESHOLD** (`PRICE_LOW`, default `0.00005`): siklus berakhir —
  notifikasi terkirim — saat harga kemudian turun mencapai atau melewati
  nilai ini.
- Setelah notifikasi terkirim, siklus untuk token itu di-reset. Token perlu
  naik ke atas `PRICE_HIGH` lagi sebelum siklus baru bisa aktif dan memicu
  notifikasi berikutnya.
- Target token: baik token yang relatif baru, maupun koin lama berharga
  rendah yang tiba-tiba pump ke atas `PRICE_HIGH` — tidak dibedakan, karena
  keduanya sama-sama valid selama pola harga cocok.

## Cara kerja (dua kecepatan berbeda)

Bot ini sengaja dipisah jadi dua siklus polling, karena `token_trending` di
Birdeye memakan **40 compute unit per panggilan**, sementara jatah gratis
cuma 30.000 CU/bulan (~750 panggilan/bulan, setara sekali per jam).

1. **Refresh watchlist** (default: tiap **1 jam**) — bot minta daftar token
   Solana trending dari **Birdeye API**, diurutkan volume 24 jam. Ini yang
   menggantikan tahap "temukan" di GMGN.
2. **Cek harga** (default: tiap **1 menit**) — untuk tiap koin di watchlist,
   bot ambil harga, volume 1 jam, market cap, dan likuiditas dari
   **DexScreener API** (gratis, tanpa API key, tanpa batas compute unit).

## Isi notifikasi

Nama token, CA, harga sekarang, volume 1 jam, market cap, link chart, dan
(kalau relevan) label risiko likuiditas.

## Aturan validasi data yang diterapkan

- Harga selalu dalam USD (`priceUsd` dari DexScreener), tidak pernah
  dicampur dengan harga native token.
- Kalau harga tidak tersedia/tidak valid untuk suatu token, token itu
  **dilewati** di siklus itu — tidak diasumsikan 0 atau nilai lain.
- Kalau market cap tidak tersedia, notifikasi menampilkan **"Data tidak
  tersedia"**, bukan angka yang diasumsikan atau dibulatkan sembarangan.
- Kalau likuiditas tidak diketahui **atau** di bawah `LIQUIDITY_MIN_USD`
  (default $10.000), notifikasi diberi label tambahan
  **"⚠️ RISIKO LIKUIDITAS TINGGI"**.
- **Keterbatasan yang perlu diketahui:** DexScreener (API gratis yang kita
  pakai) tidak menyediakan data deteksi wash trading. Aturan "abaikan
  transaksi wash trading" dari spesifikasi kamu belum bisa diterapkan
  dengan sumber data ini — butuh API berbayar/khusus (mis. analitik on-chain
  tingkat lanjut) untuk itu. Beri tahu saya kalau ini penting, supaya bisa
  dicarikan opsi sumber data lain.

## Kenapa sempat muncul sinyal palsu (sudah diperbaiki)

Kalau `state.json` hilang (misalnya karena redeploy — lihat bagian Railway
Volume di bawah), bot "melupakan" riwayat harga koin. Saat koin itu dibaca
ulang dari nol, kadang DexScreener sempat mengembalikan harga dari **pool
yang likuiditasnya nyaris kosong**, yang harganya bisa melompat liar dan
tidak mencerminkan harga wajar. Sekarang bot **menolak memakai harga dari
pool dengan likuiditas di bawah `MIN_LIQUIDITY_FOR_SIGNAL_USD`** (default
$2.000) — token itu dilewati di siklus tersebut, bukan diproses dengan
angka yang meragukan.

## Setup Railway Volume (mencegah riwayat harga hilang)

Tanpa ini, `state.json` bisa ter-reset tiap kali kamu redeploy (upload
ulang kode), yang bisa memicu pembacaan awal yang salah seperti di atas.

1. Di Railway, buka service `gmgn-alert-bot` → tab **Settings** → cari
   bagian **Volumes**
2. Tap **"+ New Volume"**, isi mount path misalnya `/data`
3. Buka tab **Variables**, tambahkan `STATE_DIR` = `/data`
4. Railway redeploy otomatis — sejak itu `state.json` disimpan permanen di
   volume tersebut, tidak hilang lagi walau kamu upload kode baru

## Kenapa satu koin bisa muncul berkali-kali

Kalau sebuah koin sudah "mati" (harga sangat rendah, likuiditas tipis) tapi
harganya berkali-kali sempat mantul tipis di atas `PRICE_HIGH` lalu jatuh
lagi ke bawah `PRICE_LOW`, bot akan menganggapnya sebagai siklus baru tiap
kali — ini bukan bug, tapi konsekuensi wajar dari definisi siklus di atas.
Label **risiko likuiditas** dan **market cap** di notifikasi membantu kamu
mengenali sinyal semacam ini dengan cepat tanpa perlu buka chart dulu.

## Setup

### 1. Buat bot Telegram
- Chat ke [@BotFather](https://t.me/BotFather) di Telegram → `/newbot` → ikuti instruksi → salin **token** yang diberikan.

### 2. Dapatkan Chat ID kamu
- Kirim pesan apa saja ke bot yang baru dibuat.
- Buka browser ke: `https://api.telegram.org/bot<TOKEN>/getUpdates`
- Cari nilai `"chat":{"id": ...}` — itu Chat ID kamu.

### 3. Daftar Birdeye API key (gratis)
- Buat akun di [birdeye.so](https://birdeye.so) → Menu → API → Security → **Generate key**.
- Free tier: 30.000 compute unit/bulan, cukup untuk refresh watchlist tiap jam.

### 4. Isi environment variables
Salin `.env.example` jadi `.env` dan isi semua nilainya.

### 5. Jalankan lokal (opsional, untuk testing)
```bash
npm install
npm start
```

## Deploy ke Railway

1. Push folder ini ke repo GitHub.
2. Di Railway: **New Project → Deploy from GitHub repo** → pilih repo ini.
3. Buka tab **Variables**, masukkan semua isi `.env.example` dengan nilai asli.
4. Railway otomatis jalankan `npm start`. Selesai — bot jalan 24/7.

**Update dari deploy sebelumnya?** Cukup ubah nilai `PRICE_LOW` yang sudah
ada dari `0.00003` menjadi `0.00005`, lalu tap **Add**/simpan — Railway
otomatis redeploy. Tidak perlu bikin variable baru kecuali kamu mau
mengubah `LIQUIDITY_MIN_USD` dari default $10.000.

**Catatan:** disk di Railway bisa ter-reset saat redeploy, artinya
`state.json` (watchlist + riwayat harga puncak) bisa hilang. Untuk
pemakaian jangka panjang yang lebih andal, tambahkan **Railway Volume**
dan arahkan `STATE_FILE` ke path volume tersebut — beri tahu saya kalau
mau saya bantu setup itu.

## Menyesuaikan

Ubah `PRICE_HIGH`, `PRICE_LOW`, `LIQUIDITY_MIN_USD`,
`DISCOVER_INTERVAL_MINUTES`, `CHECK_INTERVAL_MINUTES`, atau `TOP_N` di
environment variables kapan saja tanpa perlu ubah kode.
