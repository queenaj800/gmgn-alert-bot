require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

// ==================== KONFIGURASI ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// PUMP_THRESHOLD & DUMP_THRESHOLD sesuai spesifikasi:
// - Siklus dimulai saat harga pertama kali >= PRICE_HIGH (PUMP_THRESHOLD)
// - Siklus berakhir (alert terkirim) saat harga turun <= PRICE_LOW (DUMP_THRESHOLD)
// - Siklus baru butuh harga turun di bawah PRICE_HIGH dulu sebelum bisa aktif lagi
const PRICE_HIGH = parseFloat(process.env.PRICE_HIGH || '0.0001');   // PUMP_THRESHOLD
const PRICE_LOW = parseFloat(process.env.PRICE_LOW || '0.00005');    // DUMP_THRESHOLD

// Di bawah likuiditas ini (USD), notifikasi diberi label risiko (tapi tetap dikirim)
const LIQUIDITY_MIN_USD = parseFloat(process.env.LIQUIDITY_MIN_USD || '10000');

// Di bawah likuiditas ini (USD), harga dianggap TIDAK BISA DIPERCAYA sama sekali
// (rawan angka palsu dari pool nyaris kosong) — token dilewati total, tidak diproses.
const MIN_LIQUIDITY_FOR_SIGNAL_USD = parseFloat(process.env.MIN_LIQUIDITY_FOR_SIGNAL_USD || '2000');

// Di bawah market cap ini (USD), token diabaikan TOTAL — dianggap sudah mati/rugpull,
// terlepas dari berapa pun harga/likuiditas pool-nya. Set ke 0 untuk menonaktifkan.
const MIN_MARKET_CAP_USD = parseFloat(process.env.MIN_MARKET_CAP_USD || '10000');

// Dua interval terpisah:
// - DISCOVER: refresh daftar koin trending dari Birdeye (mahal secara compute unit, jadi jarang)
// - CHECK: cek harga & volume koin yang ada di watchlist lewat DexScreener (gratis, jadi bisa sering)
const DISCOVER_INTERVAL_MS = parseInt(process.env.DISCOVER_INTERVAL_MINUTES || '45', 10) * 60 * 1000;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MINUTES || '1', 10) * 60 * 1000;
const TOP_N = parseInt(process.env.TOP_N || '50', 10); // maksimal 50 (batas endpoint /defi/tokenlist Birdeye)

// STATE_DIR bisa diarahkan ke path Railway Volume supaya riwayat harga tidak hilang saat redeploy
const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, 'state.json');

console.log('gmgn-alert-bot — versi 2026-09-22-v5 (discovery diperluas ke 50 koin via /defi/tokenlist)');

if (!BOT_TOKEN || !CHAT_ID || !BIRDEYE_API_KEY) {
  console.error('❌ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, dan BIRDEYE_API_KEY wajib diisi di environment variables (lihat .env.example).');
  process.exit(1);
}

// ==================== STATE ====================
// watchlist  = daftar CA koin trending saat ini (diisi ulang tiap DISCOVER_INTERVAL_MS)
// prices     = riwayat harga tertinggi per koin, key = contract address (CA)
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { watchlist: raw.watchlist || [], prices: raw.prices || {} };
  } catch {
    return { watchlist: [], prices: {} };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// ==================== TELEGRAM ====================
async function sendTelegramAlert({ symbol, name, address, price, volume1h, marketCap, liquidityUsd, pairUrl }) {
  const mcText = marketCap != null
    ? `$${Number(marketCap).toLocaleString('en-US')}`
    : 'Data tidak tersedia';

  const risky = liquidityUsd == null || liquidityUsd < LIQUIDITY_MIN_USD;
  const riskLine = risky ? `\n⚠️ RISIKO LIKUIDITAS TINGGI` : '';

  const text =
    `🚨 <b>Sinyal Ditemukan</b>\n\n` +
    `Koin: <b>${escapeHtml(symbol)}</b> (${escapeHtml(name)})\n` +
    `CA: <code>${address}</code>\n` +
    `Harga sekarang: $${price}\n` +
    `Volume 1 Jam: $${Number(volume1h).toLocaleString('en-US')}\n` +
    `Market Cap: ${mcText}` +
    riskLine + `\n` +
    (pairUrl ? `Chart: ${pairUrl}` : '');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.error('Gagal kirim notifikasi Telegram:', await res.text());
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== BIRDEYE: tahap "temukan" (jarang, hemat compute unit) ====================
// Catatan jujur: Birdeye & DexScreener sama-sama TIDAK punya endpoint gratis yang
// diurutkan by volume 1 JAM — cuma tersedia volume 24 jam. /defi/tokenlist dipakai
// di sini karena lebih murah (30 CU vs 50 CU di /defi/token_trending) dan bisa ambil
// 50 koin sekaligus (vs 20), jadi cakupannya jauh lebih luas walau urutannya tetap
// berdasar volume 24 jam. Volume 1 jam yang presisi tetap diambil per-koin dari
// DexScreener di checkPricesOnce() untuk menentukan sinyal yang sebenarnya.
async function refreshWatchlist() {
  console.log(`\n[${new Date().toISOString()}] Refresh daftar koin trending dari Birdeye...`);
  try {
    const url = `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${TOP_N}`;
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'x-chain': 'solana',
        'X-API-KEY': BIRDEYE_API_KEY,
      },
    });
    if (!res.ok) throw new Error(`Birdeye error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const addresses = (json?.data?.tokens || []).map((t) => t.address).filter(Boolean);

    const newPrices = {};
    for (const addr of addresses) {
      newPrices[addr] = state.prices[addr] || { maxPrice: 0 };
    }
    state.watchlist = addresses;
    state.prices = newPrices;
    saveState(state);
    console.log(`Watchlist diperbarui: ${addresses.length} koin.`);
  } catch (err) {
    console.error('Gagal refresh watchlist dari Birdeye:', err.message);
  }
}

// ==================== DEXSCREENER: harga, volume, marketcap, likuiditas ====================
async function getTokenMarketData(address) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const pairs = (json?.pairs || []).filter((p) => p.chainId === 'solana');
  if (pairs.length === 0) return null;

  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];

  // Aturan validasi: kalau harga tidak tersedia/valid, jangan diasumsikan 0 — anggap data tidak ada
  const priceNum = parseFloat(p.priceUsd);
  if (!p.priceUsd || Number.isNaN(priceNum)) return null;

  const liquidityUsd = p.liquidity?.usd ?? null;

  // Likuiditas terlalu tipis = harga rawan palsu/outlier (pool nyaris kosong bisa melompat liar)
  if (liquidityUsd == null || liquidityUsd < MIN_LIQUIDITY_FOR_SIGNAL_USD) return null;

  const marketCap = p.marketCap ?? p.fdv ?? null;

  // Market cap terlalu kecil (atau tidak diketahui) = koin sudah mati/rugpull, bukan target valid
  if (MIN_MARKET_CAP_USD > 0 && (marketCap == null || marketCap < MIN_MARKET_CAP_USD)) return null;

  return {
    address,
    symbol: p.baseToken?.symbol || '?',
    name: p.baseToken?.name || '?',
    price: priceNum,
    volume1h: p.volume?.h1 || 0,
    marketCap,
    liquidityUsd,
    pairUrl: p.url,
  };
}

// ==================== SIKLUS CEK HARGA (sering — default tiap 1 menit) ====================
async function checkPricesOnce() {
  if (state.watchlist.length === 0) {
    console.log('Watchlist masih kosong, tunggu refresh pertama selesai...');
    return;
  }
  console.log(`[${new Date().toISOString()}] Cek harga ${state.watchlist.length} koin di watchlist...`);

  for (const addr of state.watchlist) {
    let data;
    try {
      data = await getTokenMarketData(addr);
    } catch (err) {
      console.error(`Gagal ambil data ${addr}:`, err.message);
      continue;
    }
    if (!data) continue;

    const entry = state.prices[addr] || { maxPrice: 0 };
    if (data.price > entry.maxPrice) entry.maxPrice = data.price;

    const sudahMelambung = entry.maxPrice >= PRICE_HIGH;
    const sudahTurun = data.price <= PRICE_LOW;

    if (sudahMelambung && sudahTurun) {
      console.log(`🚨 Sinyal: ${data.symbol} (${addr}) — puncak $${entry.maxPrice} → sekarang $${data.price}`);
      await sendTelegramAlert(data);
      entry.maxPrice = data.price;
    }

    state.prices[addr] = entry;
    await sleep(150);
  }

  saveState(state);
}

// ==================== HEALTH CHECK SERVER (untuk Railway) ====================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot aktif ✅')).listen(PORT, () => {
  console.log(`Health check server jalan di port ${PORT}`);
});

// ==================== JALANKAN ====================
(async () => {
  await refreshWatchlist();
  await checkPricesOnce();

  setInterval(refreshWatchlist, DISCOVER_INTERVAL_MS);
  setInterval(checkPricesOnce, CHECK_INTERVAL_MS);
})();
