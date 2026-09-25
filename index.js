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
const RUGCHECK_MAX_RISK_SCORE = parseFloat(process.env.RUGCHECK_MAX_RISK_SCORE || '50');

const MIN_HOLDER_COUNT = parseInt(process.env.MIN_HOLDER_COUNT || '600', 10);
const ENABLE_HOLDER_CHECK = (process.env.ENABLE_HOLDER_CHECK ?? 'true') === 'true';

const EXCLUDE_DEX_IDS = (process.env.EXCLUDE_DEX_IDS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const DEFAULT_SCAM_KEYWORDS = [
  'openai', 'chatgpt', 'gpt-5', 'gpt5', 'robinhood', 'tesla', 'elonmusk', 'elon musk', 'spacex',
  'apple inc', 'nvidia', 'microsoft', 'google', 'amazon', 'meta platforms', 'facebook',
  'trump', 'binance', 'coinbase', 'blackrock', 'jpmorgan', 'visa', 'mastercard',
  'paypal', 'netflix', 'disney', 'nike', 'samsung', 'twitter', 'anthropic', 'claude ai', 'claude',
];
const EXTRA_SCAM_KEYWORDS = (process.env.EXTRA_SCAM_KEYWORDS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SCAM_KEYWORDS = [...DEFAULT_SCAM_KEYWORDS, ...EXTRA_SCAM_KEYWORDS];

const MIN_TOKEN_AGE_MINUTES = parseFloat(process.env.MIN_TOKEN_AGE_MINUTES || '20');
const MAX_TOKEN_AGE_MINUTES = parseFloat(process.env.MAX_TOKEN_AGE_MINUTES || '60');

const DISCOVER_INTERVAL_MS = parseInt(process.env.DISCOVER_INTERVAL_MINUTES || '45', 10) * 60 * 1000;

const CHECK_INTERVAL_MS = process.env.CHECK_INTERVAL_SECONDS
  ? parseFloat(process.env.CHECK_INTERVAL_SECONDS) * 1000
  : parseFloat(process.env.CHECK_INTERVAL_MINUTES || '1') * 60 * 1000;

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '5', 10);

// Momentum: jumlah pembacaan harga terakhir yang disimpan per koin, dipakai untuk
// menghitung apakah harga masih turun / mulai stabil / mulai naik saat sinyal terkirim.
const MOMENTUM_WINDOW = parseInt(process.env.MOMENTUM_WINDOW || '5', 10);
// Di dalam rentang +/- persen ini dianggap "stabil" (bukan naik atau turun berarti).
const MOMENTUM_FLAT_THRESHOLD_PCT = parseFloat(process.env.MOMENTUM_FLAT_THRESHOLD_PCT || '3');

const TOP_N = parseInt(process.env.TOP_N || '50', 10);
const GECKO_PAGES = parseInt(process.env.GECKO_PAGES || '3', 10);

const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, 'state.json');

console.log('gmgn-alert-bot — versi 2026-09-25-v18 (indikator momentum di notifikasi)');
console.log(`Interval cek harga: ${(CHECK_INTERVAL_MS / 1000).toFixed(0)} detik. Batch size: ${BATCH_SIZE}. Jendela momentum: ${MOMENTUM_WINDOW} pembacaan.`);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== ANTREAN KHUSUS BIRDEYE & RUGCHECK ====================
function makeThrottledQueue(minSpacingMs) {
  let queue = Promise.resolve();
  return function throttled(fn) {
    const run = queue.then(async () => {
      const result = await fn();
      await sleep(minSpacingMs);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  };
}
const throttledBirdeye = makeThrottledQueue(1100);
const throttledRugCheck = makeThrottledQueue(300);

// ==================== MOMENTUM ====================
function computeMomentum(recentPrices) {
  if (!recentPrices || recentPrices.length < 2) {
    return { label: 'data belum cukup', pct: null, seconds: null };
  }
  const oldest = recentPrices[0];
  const newest = recentPrices[recentPrices.length - 1];
  const pct = ((newest.price - oldest.price) / oldest.price) * 100;
  const seconds = Math.max(1, Math.round((newest.t - oldest.t) / 1000));

  let label;
  if (pct <= -MOMENTUM_FLAT_THRESHOLD_PCT) label = '📉 Masih turun';
  else if (pct >= MOMENTUM_FLAT_THRESHOLD_PCT) label = '📈 Mulai naik';
  else label = '➡️ Mulai stabil';

  return { label, pct, seconds };
}

// ==================== TELEGRAM ====================
async function sendTelegramAlert({ symbol, name, address, price, volume1h, marketCap, liquidityUsd, pairUrl, momentum }) {
  const mcText = marketCap != null ? `$${Number(marketCap).toLocaleString('en-US')}` : 'Data tidak tersedia';
  const risky = liquidityUsd == null || liquidityUsd < LIQUIDITY_MIN_USD;
  const riskLine = risky ? `\n⚠️ RISIKO LIKUIDITAS TINGGI` : '';

  const momentumLine = momentum && momentum.pct != null
    ? `\nMomentum: ${momentum.label} (${momentum.pct.toFixed(1)}% dalam ${momentum.seconds}d terakhir)`
    : `\nMomentum: data belum cukup`;

  const text =
    `🚨 <b>Sinyal Ditemukan</b>\n\n` +
    `Koin: <b>${escapeHtml(symbol)}</b> (${escapeHtml(name)})\n` +
    `CA: <code>${address}</code>\n` +
    `Harga sekarang: $${price}\n` +
    `Volume 1 Jam: $${Number(volume1h).toLocaleString('en-US')}\n` +
    `Market Cap: ${mcText}` +
    riskLine +
    momentumLine + `\n` +
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
function isBrandImpersonation(symbol, name) {
  const text = `${symbol || ''} ${name || ''}`.toLowerCase();
  return SCAM_KEYWORDS.some((kw) => text.includes(kw));
}

// ==================== RUGCHECK: skor risiko + status mint/freeze authority ====================
async function checkRugCheckSafety(address) {
  return throttledRugCheck(async () => {
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
      return { safe: true, reason: `RugCheck error (dilewati): ${err.message}` };
    }
  });
}

// ==================== BIRDEYE: jumlah holder ====================
async function getHolderCount(address) {
  return throttledBirdeye(async () => {
    try {
      const url = `https://public-api.birdeye.so/defi/token_overview?address=${address}`;
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'x-chain': 'solana', 'X-API-KEY': BIRDEYE_API_KEY },
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json?.data?.holder ?? null;
    } catch {
      return null;
    }
  });
}

// ==================== SUMBER DISCOVERY 1: BIRDEYE ====================
async function getBirdeyeCandidates() {
  return throttledBirdeye(async () => {
    const url = `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${TOP_N}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'x-chain': 'solana', 'X-API-KEY': BIRDEYE_API_KEY },
    });
    if (!res.ok) throw new Error(`Birdeye error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return (json?.data?.tokens || []).map((t) => t.address).filter(Boolean);
  });
}

// ==================== SUMBER DISCOVERY 2: GECKOTERMINAL ====================
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
    if (pageAddrs.length === 0) break;
    allAddresses.push(...pageAddrs);
    await sleep(2500);
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

// ==================== GABUNGKAN KEDUA SUMBER ====================
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

  const dexId = (p.dexId || '').toLowerCase();
  if (EXCLUDE_DEX_IDS.length > 0 && EXCLUDE_DEX_IDS.some((ex) => dexId.includes(ex))) return null;

  if (!p.pairCreatedAt) return null;
  const ageMinutes = (Date.now() - p.pairCreatedAt) / 60000;
  if (ageMinutes < MIN_TOKEN_AGE_MINUTES || ageMinutes > MAX_TOKEN_AGE_MINUTES) return null;

  const priceNum = parseFloat(p.priceUsd);
  if (!p.priceUsd || Number.isNaN(priceNum)) return null;

  const symbol = p.baseToken?.symbol || '?';
  const name = p.baseToken?.name || '?';
  if (isBrandImpersonation(symbol, name)) return null;

  const liquidityUsd = p.liquidity?.usd ?? null;
  if (liquidityUsd == null || liquidityUsd < MIN_LIQUIDITY_FOR_SIGNAL_USD) return null;

  const marketCap = p.marketCap ?? p.fdv ?? null;
  if (MIN_MARKET_CAP_USD > 0 && (marketCap == null || marketCap < MIN_MARKET_CAP_USD)) return null;

  const volume1h = p.volume?.h1 || 0;
  if (volume1h < MIN_VOLUME_1H_USD) return null;

  const cached = state.prices[address] || {};
  state.prices[address] = state.prices[address] || { maxPrice: 0 };

  if (cached.rugcheckSafe === undefined) {
    const rc = await checkRugCheckSafety(address);
    state.prices[address].rugcheckSafe = rc.safe;
    if (!rc.safe) {
      console.log(`Ditolak (RugCheck): ${symbol} (${address}) — ${rc.reason}`);
      return null;
    }
  } else if (cached.rugcheckSafe === false) {
    return null;
  }

  if (ENABLE_HOLDER_CHECK) {
    if (cached.holderCount === undefined) {
      const holderCount = await getHolderCount(address);
      if (holderCount == null) {
        console.log(`Ditolak (holder tidak terbaca): ${symbol} (${address}) — belum terindeks Birdeye, dicoba lagi siklus berikutnya.`);
        return null;
      }
      state.prices[address].holderCount = holderCount;
      if (holderCount < MIN_HOLDER_COUNT) {
        console.log(`Ditolak (holder): ${symbol} (${address}) — ${holderCount} holder (min ${MIN_HOLDER_COUNT})`);
        return null;
      }
    } else if (cached.holderCount != null && cached.holderCount < MIN_HOLDER_COUNT) {
      return null;
    }
  }

  return { address, symbol, name, price: priceNum, volume1h, marketCap, liquidityUsd, pairUrl: p.url };
}

// ==================== SIKLUS CEK HARGA (paralel per batch) ====================
async function processOneToken(addr) {
  let data;
  try {
    data = await getTokenMarketData(addr);
  } catch (err) {
    console.error(`Gagal ambil data ${addr}:`, err.message);
    return;
  }
  if (!data) return;

  const entry = state.prices[addr] || { maxPrice: 0 };
  if (data.price > entry.maxPrice) entry.maxPrice = data.price;

  // Rekam histori harga singkat untuk hitung momentum saat sinyal terkirim
  entry.recentPrices = entry.recentPrices || [];
  entry.recentPrices.push({ price: data.price, t: Date.now() });
  if (entry.recentPrices.length > MOMENTUM_WINDOW) {
    entry.recentPrices = entry.recentPrices.slice(-MOMENTUM_WINDOW);
  }

  const sudahMelambung = entry.maxPrice >= PRICE_HIGH;
  const sudahTurun = data.price <= PRICE_LOW;

  if (sudahMelambung && sudahTurun) {
    const momentum = computeMomentum(entry.recentPrices);
    console.log(`🚨 Sinyal: ${data.symbol} (${addr}) — puncak $${entry.maxPrice} → sekarang $${data.price} — momentum: ${momentum.label}`);
    await sendTelegramAlert({ ...data, momentum });
    entry.maxPrice = data.price;
    entry.recentPrices = []; // mulai segar untuk siklus/sinyal berikutnya
  }

  state.prices[addr] = entry;
}

let isChecking = false;
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
  console.log(`[${new Date().toISOString()}] Cek harga ${state.watchlist.length} koin di watchlist (batch ${BATCH_SIZE})...`);

  for (let i = 0; i < state.watchlist.length; i += BATCH_SIZE) {
    const batch = state.watchlist.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((addr) => processOneToken(addr)));
    await sleep(50);
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
