require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

// ==================== KONFIGURASI ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const PRICE_HIGH = parseFloat(process.env.PRICE_HIGH || '0.0001');   // PUMP_THRESHOLD
const PRICE_LOW = parseFloat(process.env.PRICE_LOW || '0.00005');    // DUMP_THRESHOLD

const LIQUIDITY_MIN_USD = parseFloat(process.env.LIQUIDITY_MIN_USD || '10000');
const MIN_LIQUIDITY_FOR_SIGNAL_USD = parseFloat(process.env.MIN_LIQUIDITY_FOR_SIGNAL_USD || '2000');
const MIN_MARKET_CAP_USD = parseFloat(process.env.MIN_MARKET_CAP_USD || '10000');
const MIN_VOLUME_1H_USD = parseFloat(process.env.MIN_VOLUME_1H_USD || '1000');

// Skor risiko RugCheck (0-100, makin tinggi makin bahaya). Token dengan skor >= ini ditolak.
const RUGCHECK_MAX_RISK_SCORE = parseFloat(process.env.RUGCHECK_MAX_RISK_SCORE || '50');

// Daftar kata kunci brand/nama terkenal yang sering ditiru untuk scam.
// Bisa ditambah lewat env EXTRA_SCAM_KEYWORDS (pisahkan koma), digabung dengan daftar default ini.
const DEFAULT_SCAM_KEYWORDS = [
  'openai', 'chatgpt', 'gpt-5', 'gpt5', 'robinhood', 'tesla', 'elonmusk', 'elon musk', 'spacex',
  'apple inc', 'nvidia', 'microsoft', 'google', 'amazon', 'meta platforms', 'facebook',
  'trump', 'binance', 'coinbase', 'blackrock', 'jpmorgan', 'visa', 'mastercard',
  'paypal', 'netflix', 'disney', 'nike', 'samsung', 'twitter', 'anthropic', 'claude ai',
];
const EXTRA_SCAM_KEYWORDS = (process.env.EXTRA_SCAM_KEYWORDS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SCAM_KEYWORDS = [...DEFAULT_SCAM_KEYWORDS, ...EXTRA_SCAM_KEYWORDS];

const DISCOVER_INTERVAL_MS = parseInt(process.env.DISCOVER_INTERVAL_MINUTES || '45', 10) * 60 * 1000;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MINUTES || '1', 10) * 60 * 1000;
const TOP_N = parseInt(process.env.TOP_N || '50', 10);

// GeckoTerminal (gratis) izinkan hingga 10 halaman x 20 pool tanpa API key.
// Makin banyak halaman = makin luas cakupan, tapi makin lama siklus cek harga tiap menit.
// 3 halaman (60 pool) sudah keseimbangan aman; naikkan kalau mau lebih luas.
const GECKO_PAGES = parseInt(process.env.GECKO_PAGES || '3', 10);

const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, 'state.json');

console.log('gmgn-alert-bot — versi 2026-09-23-v9 (GeckoTerminal multi-page + anti-tumpang-tindih)');

if (!BOT_TOKEN || !CHAT_ID || !BIRDEYE_API_KEY) {
  console.error('❌ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, dan BIRDEYE_API_KEY wajib diisi di environment variables (lihat .env.example).');
  process.exit(1);
}

// ==================== STATE ====================
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
  const mcText = marketCap != null ? `$${Number(marketCap).toLocaleString('en-US')}` : 'Data tidak tersedia';
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
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
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
function isBrandImpersonation(symbol, name) {
  const text = `${symbol || ''} ${name || ''}`.toLowerCase();
  return SCAM_KEYWORDS.some((kw) => text.includes(kw));
}

// ==================== RUGCHECK: keamanan on-chain (mint/freeze authority, skor risiko) ====================
async function checkRugCheckSafety(address) {
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { safe: true, reason: 'RugCheck tidak tersedia untuk token ini (dilewati)' };
    const json = await res.json();

    if (json?.rugged === true) {
      return { safe: false, reason: 'RugCheck: token sudah terdeteksi rugged' };
    }
    const riskScore = json?.score_normalised ?? null;
    if (riskScore != null && riskScore >= RUGCHECK_MAX_RISK_SCORE) {
      return { safe: false, reason: `RugCheck: skor risiko ${riskScore}/100 (ambang ${RUGCHECK_MAX_RISK_SCORE})` };
    }
    const risks = json?.risks || [];
    const dangerousAuthority = risks.some((r) => {
      const t = `${r?.name || ''} ${r?.description || ''}`.toLowerCase();
      return (t.includes('mint authority') || t.includes('freeze authority')) && r?.level === 'danger';
    });
    if (dangerousAuthority) {
      return { safe: false, reason: 'RugCheck: mint/freeze authority masih aktif' };
    }
    return { safe: true, reason: null };
  } catch (err) {
    // Fail-open: kalau RugCheck error/timeout, jangan blokir sinyal hanya karena API pihak ketiga ini down
    return { safe: true, reason: `RugCheck error (dilewati): ${err.message}` };
  }
}

// ==================== SUMBER DISCOVERY 1: BIRDEYE (by volume 24 jam) ====================
async function getBirdeyeCandidates() {
  const url = `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${TOP_N}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'x-chain': 'solana', 'X-API-KEY': BIRDEYE_API_KEY },
  });
  if (!res.ok) throw new Error(`Birdeye error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json?.data?.tokens || []).map((t) => t.address).filter(Boolean);
}

// ==================== SUMBER DISCOVERY 2: GECKOTERMINAL (by volume 1 JAM — asli) ====================
async function getGeckoTerminalTrendingPools() {
  const allAddresses = [];
  for (let page = 1; page <= GECKO_PAGES; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=${page}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.error(`GeckoTerminal halaman ${page} gagal (${res.status}), lanjut dengan yang sudah ada.`);
      break;
    }
    const json = await res.json();
    const pageAddrs = (json?.data || []).map((p) => p.attributes?.address).filter(Boolean);
    if (pageAddrs.length === 0) break; // sudah habis halamannya
    allAddresses.push(...pageAddrs);
    await sleep(300); // jaga-jaga rate limit GeckoTerminal (30 req/menit)
  }
  return allAddresses;
}
async function resolvePoolToTokenAddress(pairAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const p = json?.pair || (json?.pairs && json.pairs[0]);
    return p?.baseToken?.address || null;
  } catch {
    return null;
  }
}

// ==================== GABUNGKAN KEDUA SUMBER (jarang, hemat compute unit Birdeye) ====================
async function refreshWatchlist() {
  console.log(`\n[${new Date().toISOString()}] Refresh watchlist (Birdeye + GeckoTerminal)...`);

  let birdeyeAddresses = [];
  try {
    birdeyeAddresses = await getBirdeyeCandidates();
    console.log(`Birdeye (volume 24 jam): ${birdeyeAddresses.length} koin.`);
  } catch (err) {
    console.error('Gagal ambil daftar dari Birdeye:', err.message);
  }

  let geckoAddresses = [];
  try {
    const poolAddrs = await getGeckoTerminalTrendingPools();
    for (const poolAddr of poolAddrs) {
      const tokenAddr = await resolvePoolToTokenAddress(poolAddr);
      if (tokenAddr) geckoAddresses.push(tokenAddr);
      await sleep(150);
    }
    console.log(`GeckoTerminal (volume 1 jam): ${geckoAddresses.length} koin.`);
  } catch (err) {
    console.error('Gagal ambil trending dari GeckoTerminal (dilewati, lanjut pakai Birdeye saja):', err.message);
  }

  const addresses = Array.from(new Set([...birdeyeAddresses, ...geckoAddresses]));

  const newPrices = {};
  for (const addr of addresses) {
    newPrices[addr] = state.prices[addr] || { maxPrice: 0 };
  }
  state.watchlist = addresses;
  state.prices = newPrices;
  saveState(state);
  console.log(`Watchlist gabungan diperbarui: ${addresses.length} koin unik.`);
}

// ==================== DEXSCREENER: harga, volume, marketcap, likuiditas + semua gate ====================
async function getTokenMarketData(address) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const pairs = (json?.pairs || []).filter((p) => p.chainId === 'solana');
  if (pairs.length === 0) return null;

  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];

  const priceNum = parseFloat(p.priceUsd);
  if (!p.priceUsd || Number.isNaN(priceNum)) return null;

  const symbol = p.baseToken?.symbol || '?';
  const name = p.baseToken?.name || '?';

  // Gate 1 (gratis, instan): tolak token yang meniru nama brand terkenal
  if (isBrandImpersonation(symbol, name)) return null;

  const liquidityUsd = p.liquidity?.usd ?? null;
  // Gate 2: likuiditas terlalu tipis = harga rawan palsu/outlier
  if (liquidityUsd == null || liquidityUsd < MIN_LIQUIDITY_FOR_SIGNAL_USD) return null;

  const marketCap = p.marketCap ?? p.fdv ?? null;
  // Gate 3: market cap terlalu kecil/tidak diketahui = koin sudah mati/rugpull
  if (MIN_MARKET_CAP_USD > 0 && (marketCap == null || marketCap < MIN_MARKET_CAP_USD)) return null;

  const volume1h = p.volume?.h1 || 0;
  // Gate 4: volume 1 jam nyaris nol = tidak ada aktivitas trading nyata
  if (volume1h < MIN_VOLUME_1H_USD) return null;

  // Gate 5: RugCheck (mint/freeze authority, skor risiko) — di-cache per token supaya tidak
  // memanggil API ini berkali-kali tiap menit untuk token yang sama.
  const cached = state.prices[address];
  if (cached && cached.rugcheckSafe === false) return null;
  if (!cached || cached.rugcheckSafe === undefined) {
    const rc = await checkRugCheckSafety(address);
    state.prices[address] = state.prices[address] || { maxPrice: 0 };
    state.prices[address].rugcheckSafe = rc.safe;
    if (!rc.safe) {
      console.log(`Ditolak (RugCheck): ${symbol} (${address}) — ${rc.reason}`);
      return null;
    }
  }

  return { address, symbol, name, price: priceNum, volume1h, marketCap, liquidityUsd, pairUrl: p.url };
}

// ==================== SIKLUS CEK HARGA (sering — default tiap 1 menit) ====================
let isChecking = false; // cegah dua siklus cek harga berjalan bersamaan kalau watchlist besar
async function checkPricesOnce() {
  if (isChecking) {
    console.log('Siklus cek harga sebelumnya masih berjalan, lewati siklus ini.');
    return;
  }
  isChecking = true;
  try {
    await checkPricesOnceInner();
  } finally {
    isChecking = false;
  }
}
async function checkPricesOnceInner() {
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
