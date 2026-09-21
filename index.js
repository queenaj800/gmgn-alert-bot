require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

// ==================== KONFIGURASI ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
const PRICE_HIGH = parseFloat(process.env.PRICE_HIGH || '0.0001');
const PRICE_LOW = parseFloat(process.env.PRICE_LOW || '0.00003');

// Dua interval terpisah:
// - DISCOVER: refresh daftar koin trending dari Birdeye (mahal secara compute unit, jadi jarang)
// - CHECK: cek harga & volume koin yang ada di watchlist lewat DexScreener (gratis, jadi bisa sering)
const DISCOVER_INTERVAL_MS = parseInt(process.env.DISCOVER_INTERVAL_MINUTES || '60', 10) * 60 * 1000;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MINUTES || '1', 10) * 60 * 1000;
const TOP_N = parseInt(process.env.TOP_N || '20', 10); // maksimal 20 (batas endpoint trending Birdeye)
const STATE_FILE = path.join(__dirname, 'state.json');

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
async function sendTelegramAlert({ symbol, name, address, price, volume1h, pairUrl }) {
  const text =
    `🚨 <b>Sinyal Ditemukan</b>\n\n` +
    `Koin: <b>${escapeHtml(symbol)}</b> (${escapeHtml(name)})\n` +
    `CA: <code>${address}</code>\n` +
    `Harga sekarang: $${price}\n` +
    `Volume 1 Jam: $${Number(volume1h).toLocaleString('en-US')}\n` +
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
async function refreshWatchlist() {
  console.log(`\n[${new Date().toISOString()}] Refresh daftar koin trending dari Birdeye...`);
  try {
    const url = `https://public-api.birdeye.so/defi/token_trending?sort_by=volume24hUSD&sort_type=desc&offset=0&limit=${TOP_N}`;
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

    // watchlist baru, tapi tetap bawa riwayat harga puncak koin yang masih ada di daftar
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

// ==================== DEXSCREENER: harga & volume 1h akurat (gratis, bisa sering) ====================
async function getTokenMarketData(address) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const pairs = (json?.pairs || []).filter((p) => p.chainId === 'solana');
  if (pairs.length === 0) return null;

  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];

  return {
    address,
    symbol: p.baseToken?.symbol || '?',
    name: p.baseToken?.name || '?',
    price: parseFloat(p.priceUsd || '0'),
    volume1h: p.volume?.h1 || 0,
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
      entry.maxPrice = data.price; // reset: butuh melambung lagi untuk trigger berikutnya
    }

    state.prices[addr] = entry;
    await sleep(150); // jaga-jaga rate limit DexScreener
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
  await refreshWatchlist(); // isi watchlist pertama kali
  await checkPricesOnce();  // langsung cek begitu watchlist terisi

  setInterval(refreshWatchlist, DISCOVER_INTERVAL_MS);
  setInterval(checkPricesOnce, CHECK_INTERVAL_MS);
})();
