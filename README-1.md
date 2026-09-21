# GMGN Alert Bot

Bot Telegram yang memantau koin trending di Solana (mirip menu "temukan" GMGN,
diurutkan volume tinggi ke rendah), lalu mengirim notifikasi saat sebuah koin
**pernah menyentuh harga ≥ $0.0001** kemudian **turun ke ≤ $0.00003**.

## Cara kerja (dua kecepatan berbeda)

Bot ini sengaja dipisah jadi dua siklus, karena `token_trending` di Birdeye
memakan **40 compute unit per panggilan**, sementara jatah gratis cuma
30.000 CU/bulan (~750 panggilan/bulan, setara sekali per jam). Kalau dipaksa
polling cepat lewat Birdeye saja, jatah gratis akan habis jauh sebelum
sebulan.

1. **Refresh watchlist** (default: **tiap 1 jam**) — bot minta daftar token
   Solana trending dari **Birdeye API**, diurutkan volume 24 jam. Ini yang
   menggantikan tahap "temukan" di GMGN.
2. **Cek harga** (default: **tiap 1 menit**) — untuk tiap koin di watchlist,
   bot ambil harga & volume 1 jam yang akurat dari **DexScreener API**
   (gratis, tanpa API key, tanpa batas compute unit). Karena bagian ini yang
   paling menentukan buat menangkap momentum naik-turun cepat, dia dibuat
   jauh lebih sering daripada refresh watchlist-nya.
3. Bot menyimpan harga tertinggi yang pernah tercatat untuk tiap koin (di
   `state.json`). Kalau harga tertinggi itu ≥ 0.0001 dan harga sekarang
   ≤ 0.00003 → bot kirim notifikasi ke Telegram berisi nama koin, CA, harga,
   dan volume 1 jam.
4. Setelah notifikasi terkirim, koin itu "di-reset" — perlu melambung lagi ke
   atas ambang batas sebelum bisa memicu notifikasi berikutnya (biar tidak spam).

## Setup

### 1. Buat bot Telegram
- Chat ke [@BotFather](https://t.me/BotFather) di Telegram → `/newbot` → ikuti instruksi → salin **token** yang diberikan.

### 2. Dapatkan Chat ID kamu
- Kirim pesan apa saja ke bot yang baru dibuat.
- Buka browser ke: `https://api.telegram.org/bot<TOKEN>/getUpdates`
- Cari nilai `"chat":{"id": ...}` — itu Chat ID kamu.

### 3. Daftar Birdeye API key (gratis)
- Buat akun di [birdeye.so](https://birdeye.so) → ambil API key dari dashboard.
- Free tier: 30.000 compute unit/bulan, cukup untuk refresh watchlist tiap jam.

### 4. Isi environment variables
Salin `.env.example` jadi `.env` dan isi semua nilainya.

### 5. Jalankan lokal (opsional, untuk testing)
```bash
npm install
npm start
```

## Deploy ke Railway

1. Push folder ini ke repo GitHub baru.
2. Di Railway: **New Project → Deploy from GitHub repo** → pilih repo ini.
3. Buka tab **Variables**, masukkan semua isi `.env.example` dengan nilai asli.
4. Railway otomatis jalankan `npm start`. Selesai — bot jalan 24/7.

**Catatan:** disk di Railway bisa ter-reset saat redeploy, artinya `state.json`
(watchlist + riwayat harga puncak) bisa hilang. Untuk pemakaian jangka panjang
yang lebih andal, tambahkan **Railway Volume** dan arahkan `STATE_FILE` ke
path volume tersebut — beri tahu saya kalau mau saya bantu setup itu.

## Menyesuaikan

Ubah `PRICE_HIGH`, `PRICE_LOW`, `DISCOVER_INTERVAL_MINUTES`,
`CHECK_INTERVAL_MINUTES`, atau `TOP_N` di environment variables kapan saja
tanpa perlu ubah kode.

⚠️ Kalau mau `DISCOVER_INTERVAL_MINUTES` lebih kecil dari 60, cek dulu jatah
CU Birdeye kamu (dashboard birdeye.so) supaya tidak kehabisan sebelum akhir
bulan.
