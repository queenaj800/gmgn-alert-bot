require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

// ==================== KONFIGURASI ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const PRICE_HIGH = parseFloat(process.env.PRICE_HIGH || '0.0001');
const PRICE_LOW = parseFloat(process.env.PRICE_LOW || '0.00005');

// Kriteria KEDUA (opsional): untuk pump yang lebih moderat, minta bukti dump yang JAUH
// lebih dalam sebelum dianggap sinyal valid. Kalau harga ternyata terus naik sampai
// menyentuh PRICE_HIGH (kriteria 1), otomatis "naik kelas" dan ikut aturan kriteria 1
// (dump ke PRICE_LOW yang lebih dangkal), karena kriteria 1 dianggap lebih kuat/prioritas.
// Kosongkan PRICE_HIGH_2 untuk menonaktifkan (cuma pakai 1 kriteria seperti sebelumnya).
const PRICE_HIGH_2 = process.env.PRICE_HIGH_2 ? parseFloat(process.env.PRICE_HIGH_2) : null;
const PRICE_LOW_2 = process.env.PRICE_LOW_2 ? parseFloat(process.env.PRICE_LOW_2) : null;

const LIQUIDITY_MIN_USD = parseFloat(process.env.LIQUIDITY_MIN_USD || '10000');
const MIN_LIQUIDITY_FOR_SIGNAL_USD = parseFloat(process.env.MIN_LIQUIDITY_FOR_SIGNAL_USD || '2000');
const MIN_MARKET_CAP_USD = parseFloat(process.env.MIN_MARKET_CAP_USD || '10000');
const MIN_VOLUME_1H_USD = parseFloat(process.env.MIN_VOLUME_1H_USD || '1000');
const RUGCHECK_MAX_RISK_SCORE = parseFloat(process.env.RUGCHECK_MAX_RISK_SCORE || '50');

const MIN_HOLDER_COUNT = parseInt(process.env.MIN_HOLDER_COUNT || '600', 10);
const ENABLE_HOLDER_CHECK = (process.env.ENABLE_HOLDER_CHECK ?? 'false') === 'true';

const MIN_AVG_TRADE_SIZE_USD = parseFloat(process.env.MIN_AVG_TRADE_SIZE_USD || '15');

// Bundle buys % dari Solana Tracker (API terpisah, perlu daftar akun sendiri, gratis
// 2.500 request/bulan). Kalau SOLANATRACKER_API_KEY kosong, cek ini otomatis dilewati
// (tidak mengganggu apa pun) — cuma jadi KETERANGAN tambahan, tidak memblokir sinyal.
const SOLANATRACKER_API_KEY = process.env.SOLANATRACKER_API_KEY || '';
const BUNDLE_WARNING_PCT = parseFloat(process.env.BUNDLE_WARNING_PCT || '65');

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

// Dua interval discovery TERPISAH: Birdeye (mahal secara CU, jarang) vs GeckoTerminal
// (gratis tanpa batas CU, bisa lebih sering) — supaya koin yang baru mulai ramai
// terdeteksi lebih cepat tanpa membebani jatah gratis Birdeye.
const BIRDEYE_DISCOVER_INTERVAL_MS = parseInt(process.env.DISCOVER_INTERVAL_MINUTES || '45', 10) * 60 * 1000;
const GECKO_DISCOVER_INTERVAL_MS = parseInt(process.env.GECKO_DISCOVER_INTERVAL_MINUTES || '15', 10) * 60 * 1000;

const CHECK_INTERVAL_MS = process.env.CHECK_INTERVAL_SECONDS
  ? parseFloat(process.env.CHECK_INTERVAL_SECONDS) * 1000
  : parseFloat(process.env.CHECK_INTERVAL_MINUTES || '1') * 60 * 1000;

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '5', 10);

// Jalur cepat KHUSUS untuk koin yang sudah "armed" (pernah tembus PRICE_HIGH/PRICE_HIGH_2,
// tinggal tunggu dump). Dicek jauh lebih sering daripada siklus umum, karena koin volatil
// bisa jatuh puluhan persen dalam hitungan detik — polling umum (20 detik) terlalu lambat
// untuk menangkap momen persis itu. Jumlah koin "armed" biasanya sedikit, jadi aman dicek
// sesering ini tanpa membebani API.
const FAST_CHECK_INTERVAL_MS = parseInt(process.env.FAST_CHECK_INTERVAL_SECONDS || '5', 10) * 1000;

// Jalur SUPER CEPAT khusus koin armed yang bundle buys-nya sudah terbukti tinggi —
// hipotesis: bundle tinggi = wallet terkoordinasi, lebih rawan dump instan/serentak,
// jadi diberi prioritas pengecekan tercepat. Bundle % sekarang dicek SEJAK koin armed
// (bukan nunggu sampai mau dump), supaya prioritas ini bisa langsung berlaku.
const HIGH_RISK_FAST_CHECK_INTERVAL_MS = parseInt(process.env.HIGH_RISK_FAST_CHECK_INTERVAL_SECONDS || '2', 10) * 1000;

const MOMENTUM_WINDOW = parseInt(process.env.MOMENTUM_WINDOW || '5', 10);
const MOMENTUM_FLAT_THRESHOLD_PCT = parseFloat(process.env.MOMENTUM_FLAT_THRESHOLD_PCT || '3');

const TOP_N = parseInt(process.env.TOP_N || '50', 10);
const GECKO_PAGES = parseInt(process.env.GECKO_PAGES || '3', 10);

const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, 'state.json');

console.log('gmgn-alert-bot — versi 2026-09-27-v30 (jalur super cepat untuk koin armed berbundle tinggi)');
console.log(`Discovery Birdeye: tiap ${(BIRDEYE_DISCOVER_INTERVAL_MS / 60000).toFixed(0)} menit. Discovery GeckoTerminal: tiap ${(GECKO_DISCOVER_INTERVAL_MS / 60000).toFixed(0)} menit. Cek harga: tiap ${(CHECK_INTERVAL_MS / 1000).toFixed(0)} detik.`);

if (!BOT_TOKEN || !CHAT_ID || !BIRDEYE_API_KEY) {
  console.error('❌ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, dan BIRDEYE_API_KEY wajib diisi di environment variables (lihat .env.example).');
  process.exit(1);
}

// ==================== STATE ====================
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      watchlist: raw.watchlist || [],
      prices: raw.prices || {},
      birdeyeAddresses: raw.birdeyeAddresses || [],
      geckoAddresses: raw.geckoAddresses || [],
    };
  } catch {
    return { watchlist: [], prices: {}, birdeyeAddresses: [], geckoAddresses: [] };
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
async function sendTelegramAlert({ symbol, name, address, price, volume1h, marketCap, liquidityUsd, pairUrl, momentum, tierLabel, clusterWarning, bundleWarning, bundlePercentage }) {
  const mcText = marketCap != null ? `$${Number(marketCap).toLocaleString('en-US')}` : 'Data tidak tersedia';
  const risky = liquidityUsd == null || liquidityUsd < LIQUIDITY_MIN_USD;
  const riskLine = risky ? `\n⚠️ RISIKO LIKUIDITAS TINGGI` : '';
  const clusterLine = clusterWarning ? `\n⚠️ Hati-hati: terdeteksi cluster wallet (mirip pola diagram gelembung mencurigakan)` : '';
  const bundleLine = bundleWarning ? `\n⚠️ Hati-hati: Bundle buys tinggi (${bundlePercentage.toFixed(1)}%)` : '';

  const momentumLine = momentum && momentum.pct != null
    ? `\nMomentum: ${momentum.label} (${momentum.pct.toFixed(1)}% dalam ${momentum.seconds}d terakhir)`
    : `\nMomentum: data belum cukup`;

  const tierLine = tierLabel ? ` (kriteria ${tierLabel})` : '';
  const text =
    `🚨 <b>Sinyal Ditemukan</b>${tierLine}\n\n` +
    `Koin: <b>${escapeHtml(symbol)}</b> (${escapeHtml(name)})\n` +
    `CA: <code>${address}</code>\n` +
    `Harga sekarang: $${price}\n` +
    `Volume 1 Jam: $${Number(volume1h).toLocaleString('en-US')}\n` +
    `Market Cap: ${mcText}` +
    riskLine +
    clusterLine +
    bundleLine +
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

// ==================== RUGCHECK ====================
async function checkRugCheckSafety(address) {
  return throttledRugCheck(async () => {
    try {
      const url = `https://api.rugcheck.xyz/v1/tokens/${address}/report`;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return { safe: true, reason: 'RugCheck tidak tersedia untuk token ini (dilewati)', clusterWarning: false };
      const json = await res.json();

      // Deteksi cluster/insider wallet (fungsi mirip diagram gelembung GMGN) — MASIH
      // TAHAP PENGUMPULAN DATA. Sengaja HANYA jadi keterangan di notifikasi, TIDAK
      // memblokir sinyal, sampai ada bukti data yang cukup untuk dijadikan filter keras.
      let clusterWarning = false;
      const risks = json?.risks || [];
      const clusterKeywords = ['insider', 'cluster', 'bundle', 'bundled', 'sniper'];
      if (json?.graphInsidersDetected) clusterWarning = true;
      const clusterRisk = risks.find((r) => {
        const t = `${r?.name || ''} ${r?.description || ''}`.toLowerCase();
        return clusterKeywords.some((kw) => t.includes(kw));
      });
      if (clusterRisk) clusterWarning = true;

      if (json?.rugged === true) {
        return { safe: false, reason: 'RugCheck: token sudah terdeteksi rugged', clusterWarning };
      }
      const riskScore = json?.score_normalised ?? null;
      if (riskScore != null && riskScore >= RUGCHECK_MAX_RISK_SCORE) {
        return { safe: false, reason: `RugCheck: skor risiko ${riskScore}/100 (ambang ${RUGCHECK_MAX_RISK_SCORE})`, clusterWarning };
      }
      const dangerousAuthority = risks.some((r) => {
        const t = `${r?.name || ''} ${r?.description || ''}`.toLowerCase();
        return (t.includes('mint authority') || t.includes('freeze authority')) && r?.level === 'danger';
      });
      if (dangerousAuthority) {
        return { safe: false, reason: 'RugCheck: mint/freeze authority masih aktif', clusterWarning };
      }
      return { safe: true, reason: null, clusterWarning };
    } catch (err) {
      return { safe: true, reason: `RugCheck error (dilewati): ${err.message}`, clusterWarning: false };
    }
  });
}

// ==================== BIRDEYE: jumlah holder (opsional) ====================
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

// ==================== SOLANA TRACKER: persentase bundle buys ====================
async function getBundlePercentage(address) {
  if (!SOLANATRACKER_API_KEY) return null;
  try {
    const url = `https://data.solanatracker.io/tokens/${address}`;
    const res = await fetch(url, { headers: { 'x-api-key': SOLANATRACKER_API_KEY } });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.risk?.bundlers?.totalPercentage ?? null;
  } catch {
    return null;
  }
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
async function fetchGeckoPage(page) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=${page}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 429) return { retry: true };
  if (!res.ok) return { retry: false, addrs: null, status: res.status };
  const json = await res.json();
  const addrs = (json?.data || []).map((p) => p.attributes?.address).filter(Boolean);
  return { retry: false, addrs };
}

async function getGeckoTerminalTrendingPools() {
  const allAddresses = [];
  for (let page = 1; page <= GECKO_PAGES; page++) {
    let result = await fetchGeckoPage(page);
    if (result.retry) {
      // Kena rate limit (kemungkinan IP Railway dipakai bersama pengguna lain) —
      // tunggu lebih lama lalu coba sekali lagi sebelum menyerah untuk siklus ini.
      console.error(`GeckoTerminal halaman ${page} kena rate limit (429), tunggu 8 detik lalu coba ulang sekali...`);
      await sleep(8000);
      result = await fetchGeckoPage(page);
    }
    if (result.retry || result.addrs == null) {
      console.error(`GeckoTerminal halaman ${page} gagal (${result.status || 429}), lanjut dengan yang sudah ada.`);
      break;
    }
    if (result.addrs.length === 0) break;
    allAddresses.push(...result.addrs);
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

// ==================== GABUNGKAN WATCHLIST DARI KEDUA SUMBER ====================
function rebuildWatchlist() {
  const addresses = Array.from(new Set([...state.birdeyeAddresses, ...state.geckoAddresses]));
  const newPrices = {};
  for (const addr of addresses) {
    newPrices[addr] = state.prices[addr] || { maxPrice: 0 };
  }
  state.watchlist = addresses;
  state.prices = newPrices;
  saveState(state);
  console.log(`Watchlist gabungan diperbarui: ${addresses.length} koin unik (Birdeye: ${state.birdeyeAddresses.length}, GeckoTerminal: ${state.geckoAddresses.length}).`);
}

async function refreshBirdeyeWatchlist() {
  console.log(`\n[${new Date().toISOString()}] Refresh watchlist dari Birdeye (volume 24 jam)...`);
  try {
    state.birdeyeAddresses = await getBirdeyeCandidates();
    console.log(`Birdeye: ${state.birdeyeAddresses.length} koin.`);
  } catch (err) {
    console.error('Gagal ambil daftar dari Birdeye:', err.message);
  }
  rebuildWatchlist();
}

async function refreshGeckoWatchlist() {
  console.log(`\n[${new Date().toISOString()}] Refresh watchlist dari GeckoTerminal (volume 1 jam)...`);
  try {
    const poolAddrs = await getGeckoTerminalTrendingPools();
    const geckoAddresses = [];
    for (const poolAddr of poolAddrs) {
      const tokenAddr = await resolvePoolToTokenAddress(poolAddr);
      if (tokenAddr) geckoAddresses.push(tokenAddr);
      await sleep(150);
    }
    state.geckoAddresses = geckoAddresses;
    console.log(`GeckoTerminal: ${geckoAddresses.length} koin.`);
  } catch (err) {
    console.error('Gagal ambil trending dari GeckoTerminal (dilewati):', err.message);
  }
  rebuildWatchlist();
}

// ==================== TAHAP 1: snapshot harga (gate STABIL saja) ====================
async function getTokenSnapshot(address) {
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

  return { address, symbol, name, price: priceNum, pair: p };
}

// ==================== TAHAP 2: filter kualitas (gate FLUKTUATIF — dicek cuma saat sinyal) ====================
async function checkQualityGates(snapshot) {
  const { address, symbol, name, pair: p } = snapshot;

  const liquidityUsd = p.liquidity?.usd ?? null;
  if (liquidityUsd == null || liquidityUsd < MIN_LIQUIDITY_FOR_SIGNAL_USD) {
    return { pass: false, reason: `likuiditas $${liquidityUsd ?? 0} (min $${MIN_LIQUIDITY_FOR_SIGNAL_USD})` };
  }

  const marketCap = p.marketCap ?? p.fdv ?? null;
  if (MIN_MARKET_CAP_USD > 0 && (marketCap == null || marketCap < MIN_MARKET_CAP_USD)) {
    return { pass: false, reason: `market cap ${marketCap ?? 'tidak ada'} (min $${MIN_MARKET_CAP_USD})` };
  }

  const volume1h = p.volume?.h1 || 0;
  if (volume1h < MIN_VOLUME_1H_USD) {
    return { pass: false, reason: `volume 1h $${volume1h} (min $${MIN_VOLUME_1H_USD})` };
  }

  const txnsH1 = p.txns?.h1;
  const txnCount = txnsH1 ? (txnsH1.buys || 0) + (txnsH1.sells || 0) : 0;
  if (txnCount === 0) return { pass: false, reason: 'volume ada tapi transaksi 0 (data tidak konsisten)' };
  const avgTradeSize = volume1h / txnCount;
  if (avgTradeSize < MIN_AVG_TRADE_SIZE_USD) {
    return { pass: false, reason: `rata-rata transaksi $${avgTradeSize.toFixed(2)} dari ${txnCount}x (min $${MIN_AVG_TRADE_SIZE_USD})` };
  }

  const cached = state.prices[address] || {};
  state.prices[address] = state.prices[address] || { maxPrice: 0 };

  if (cached.rugcheckSafe === undefined) {
    const rc = await checkRugCheckSafety(address);
    state.prices[address].rugcheckSafe = rc.safe;
    state.prices[address].clusterWarning = rc.clusterWarning || false;
    if (!rc.safe) return { pass: false, reason: `RugCheck: ${rc.reason}` };
  } else if (cached.rugcheckSafe === false) {
    return { pass: false, reason: 'RugCheck: sudah pernah ditandai tidak aman' };
  }

  if (ENABLE_HOLDER_CHECK) {
    if (cached.holderCount === undefined) {
      const holderCount = await getHolderCount(address);
      if (holderCount == null) return { pass: false, reason: 'holder tidak terbaca dari Birdeye' };
      state.prices[address].holderCount = holderCount;
      if (holderCount < MIN_HOLDER_COUNT) return { pass: false, reason: `${holderCount} holder (min ${MIN_HOLDER_COUNT})` };
    } else if (cached.holderCount != null && cached.holderCount < MIN_HOLDER_COUNT) {
      return { pass: false, reason: `${cached.holderCount} holder (min ${MIN_HOLDER_COUNT})` };
    }
  }

  // Bundle buys % — biasanya sudah dicek sejak token armed (lihat processOneTokenInner),
  // tapi jaga-jaga kalau belum (misal dump terjadi di siklus armed pertama), cek di sini juga.
  if (state.prices[address].bundlePercentage === undefined) {
    state.prices[address].bundlePercentage = await getBundlePercentage(address);
  }
  const bundlePercentage = state.prices[address].bundlePercentage;
  const bundleWarning = bundlePercentage != null && bundlePercentage > BUNDLE_WARNING_PCT;

  return {
    pass: true,
    alertData: {
      address, symbol, name, price: snapshot.price, volume1h, marketCap, liquidityUsd, pairUrl: p.url,
      clusterWarning: state.prices[address].clusterWarning || false,
      bundleWarning, bundlePercentage,
    },
  };
}

// ==================== SIKLUS CEK HARGA (paralel per batch) ====================
const inFlight = new Set(); // cegah token yang sama diproses 2 loop (umum & cepat) bersamaan
async function processOneToken(addr) {
  if (inFlight.has(addr)) return;
  inFlight.add(addr);
  try {
    await processOneTokenInner(addr);
  } finally {
    inFlight.delete(addr);
  }
}
async function processOneTokenInner(addr) {
  let snapshot;
  try {
    snapshot = await getTokenSnapshot(addr);
  } catch (err) {
    console.error(`Gagal ambil data ${addr}:`, err.message);
    return;
  }
  if (!snapshot) return;

  const entry = state.prices[addr] || { maxPrice: 0 };
  if (snapshot.price > entry.maxPrice) entry.maxPrice = snapshot.price;

  // Penanda PERMANEN (tidak pernah direset oleh sinyal manapun) — apakah token ini
  // PERNAH mencapai level kriteria 1 sepanjang riwayatnya. Sekali pernah, kriteria 2
  // dimatikan SELAMANYA untuk token ini — supaya pantulan lemah sisa tenaga habis
  // pasca-pump besar (misal setelah kriteria 1 sudah terkirim) tidak dianggap sinyal
  // kriteria 2 yang baru. Kriteria 2 murni cuma untuk token yang BELUM PERNAH sama
  // sekali menyentuh level kriteria 1.
  entry.allTimeMaxPrice = Math.max(entry.allTimeMaxPrice || 0, snapshot.price);
  const pernahCapaiTier1 = entry.allTimeMaxPrice >= PRICE_HIGH;

  // Tandai kalau harga pernah "singgah" di zona kriteria 2 (antara PRICE_HIGH_2 dan
  // PRICE_HIGH) sebelum menembus PRICE_HIGH. Kalau harga melompat LANGSUNG dari bawah
  // PRICE_HIGH_2 ke atas PRICE_HIGH tanpa pernah tersampel di zona ini, itu indikasi
  // pump instan/bundled (bukan kenaikan bertahap) — kriteria 1 tidak akan diaktifkan.
  if (PRICE_HIGH_2 != null && snapshot.price >= PRICE_HIGH_2 && snapshot.price < PRICE_HIGH) {
    entry.touchedTier2Zone = true;
  }

  entry.recentPrices = entry.recentPrices || [];
  entry.recentPrices.push({ price: snapshot.price, t: Date.now() });
  if (entry.recentPrices.length > MOMENTUM_WINDOW) {
    entry.recentPrices = entry.recentPrices.slice(-MOMENTUM_WINDOW);
  }

  // Kalau PRICE_HIGH_2 tidak diset, syarat "singgah dulu" tidak berlaku (perilaku lama).
  const passedThroughTier2Zone = PRICE_HIGH_2 == null || entry.touchedTier2Zone === true;

  // Kriteria 1 diprioritaskan kalau tersentuh SECARA BERTAHAP; kriteria 2 HANYA berlaku
  // kalau token ini belum pernah sama sekali menyentuh level kriteria 1 sepanjang riwayatnya.
  const sudahMelambungTier1 = entry.maxPrice >= PRICE_HIGH && passedThroughTier2Zone;
  const sudahMelambungTier2 = PRICE_HIGH_2 != null && entry.maxPrice >= PRICE_HIGH_2 && !pernahCapaiTier1;

  // Begitu armed (kriteria mana pun), langsung cek bundle % kalau belum pernah — supaya
  // token berisiko tinggi bisa segera masuk jalur super cepat, bukan nunggu momen dump.
  if ((sudahMelambungTier1 || sudahMelambungTier2) && entry.bundlePercentage === undefined) {
    entry.bundlePercentage = await getBundlePercentage(addr);
  }

  let dumpThreshold = null;
  let tierLabel = null;
  if (sudahMelambungTier1) {
    dumpThreshold = PRICE_LOW;
    tierLabel = '1';
  } else if (sudahMelambungTier2) {
    dumpThreshold = PRICE_LOW_2;
    tierLabel = '2';
  }

  const sudahTurun = dumpThreshold != null && snapshot.price <= dumpThreshold;

  if (dumpThreshold != null && sudahTurun) {
    const quality = await checkQualityGates(snapshot);
    if (quality.pass) {
      const momentum = computeMomentum(entry.recentPrices);
      console.log(`🚨 Sinyal (kriteria ${tierLabel}): ${snapshot.symbol} (${addr}) — puncak $${entry.maxPrice} → sekarang $${snapshot.price} — momentum: ${momentum.label}`);
      await sendTelegramAlert({ ...quality.alertData, momentum, tierLabel });
      entry.maxPrice = snapshot.price;
      entry.recentPrices = [];
      entry.touchedTier2Zone = false;
    } else {
      console.log(`Sinyal tertunda (kriteria ${tierLabel}): ${snapshot.symbol} (${addr}) — ${quality.reason}`);
    }
  }

  state.prices[addr] = entry;
}

// Cari token yang sudah "armed" (tinggal tunggu dump) — cek murni dari data di memori,
// tanpa panggilan API, jadi ringan dipanggil tiap beberapa detik.
function getArmedAddresses() {
  return state.watchlist.filter((addr) => {
    const entry = state.prices[addr];
    if (!entry) return false;
    const pernahCapaiTier1 = (entry.allTimeMaxPrice || 0) >= PRICE_HIGH;
    const armedTier1 = entry.maxPrice >= PRICE_HIGH;
    const armedTier2 = PRICE_HIGH_2 != null && entry.maxPrice >= PRICE_HIGH_2 && !pernahCapaiTier1;
    return armedTier1 || armedTier2;
  });
}

function getHighRiskArmedAddresses(armedAddresses) {
  return armedAddresses.filter((addr) => {
    const pct = state.prices[addr]?.bundlePercentage;
    return pct != null && pct > BUNDLE_WARNING_PCT;
  });
}

let isFastChecking = false;
async function fastCheckArmedTokens() {
  if (isFastChecking) return;
  const armed = getArmedAddresses();
  if (armed.length === 0) return;
  isFastChecking = true;
  try {
    await Promise.all(armed.map((addr) => processOneToken(addr)));
    saveState(state);
  } finally {
    isFastChecking = false;
  }
}

let isHighRiskChecking = false;
async function highRiskCheckArmedTokens() {
  if (isHighRiskChecking) return;
  const highRisk = getHighRiskArmedAddresses(getArmedAddresses());
  if (highRisk.length === 0) return;
  isHighRiskChecking = true;
  try {
    await Promise.all(highRisk.map((addr) => processOneToken(addr)));
    saveState(state);
  } finally {
    isHighRiskChecking = false;
  }
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
  await refreshBirdeyeWatchlist();
  await refreshGeckoWatchlist();
  await checkPricesOnce();
  setInterval(refreshBirdeyeWatchlist, BIRDEYE_DISCOVER_INTERVAL_MS);
  setInterval(refreshGeckoWatchlist, GECKO_DISCOVER_INTERVAL_MS);
  setInterval(checkPricesOnce, CHECK_INTERVAL_MS);
  setInterval(fastCheckArmedTokens, FAST_CHECK_INTERVAL_MS);
  setInterval(highRiskCheckArmedTokens, HIGH_RISK_FAST_CHECK_INTERVAL_MS);
})();
