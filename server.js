import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: '*',
  methods: ['GET'],
}));

app.use(express.json());

const SYMBOLS = ['XAU/USD', 'WTI/USD', 'EUR/USD'];

const TD_MAP = {
  'XAU/USD': 'XAU/USD',
  'WTI/USD': 'WTI/USD',
  'EUR/USD': 'EUR/USD',
};

const FH_MAP = {
  'XAU/USD': 'GC=F',
  'WTI/USD': 'CL=F',
  'EUR/USD': 'OANDA:EUR_USD',
};

const BASE_PRICES = {
  'XAU/USD': 4320.00,
  'WTI/USD': 68.50,
  'EUR/USD': 1.1610,
};

const cache = {};
let lastFetchTime = null;

async function fetchTwelveData(apiKey, symbol) {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(TD_MAP[symbol])}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    if (d.status === 'error' || !d.close) return null;
    const price = parseFloat(d.close);
    const prev = parseFloat(d.previous_close || d.open || price);
    const changeVal = price - prev;
    return {
      price,
      change: (changeVal / prev) * 100,
      changeValue: changeVal,
      high: parseFloat(d.high || price * 1.001),
      low: parseFloat(d.low || price * 0.999),
      open: parseFloat(d.open || prev),
      previousClose: prev,
      source: 'api',
      sourceName: 'Twelve Data',
    };
  } catch { return null; }
}

async function fetchFinnhub(apiKey, symbol) {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(FH_MAP[symbol])}&token=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.c) return null;
    return {
      price: d.c,
      change: d.dp || 0,
      changeValue: d.d || 0,
      high: d.h,
      low: d.l,
      open: d.o,
      previousClose: d.pc,
      source: 'api',
      sourceName: 'Finnhub',
    };
  } catch { return null; }
}

const sCur = {};
const sOpen = {};

function simTick() {
  for (const sym of SYMBOLS) {
    if (sCur[sym] === undefined) {
      sCur[sym] = BASE_PRICES[sym];
      sOpen[sym] = BASE_PRICES[sym];
    }
  }
  const out = {};
  for (const sym of SYMBOLS) {
    const base = BASE_PRICES[sym];
    const vol = base * 0.0002;
    const drift = (base - sCur[sym]) * 0.005;
    const noise = (Math.random() - 0.5) * vol;
    sCur[sym] += drift + noise;
    const prev = sOpen[sym];
    const changeVal = sCur[sym] - prev;
    out[sym] = {
      symbol: sym,
      price: sCur[sym],
      change: (changeVal / prev) * 100,
      changeValue: changeVal,
      high: Math.max(sCur[sym], prev * 1.002),
      low: Math.min(sCur[sym], prev * 0.998),
      open: prev,
      previousClose: prev,
      timestamp: Date.now(),
      source: 'sim',
      sourceName: 'Simulation',
    };
  }
  return out;
}

async function fetchAll() {
  const tdKey = process.env.TWELVE_DATA_API_KEY;
  const fhKey = process.env.FINNHUB_API_KEY;
  const prices = simTick();
  
  if (tdKey) {
    for (const sym of SYMBOLS) {
      const data = await fetchTwelveData(tdKey, sym);
      if (data) {
        prices[sym] = { ...prices[sym], ...data, symbol: sym, timestamp: Date.now() };
      }
    }
  }
  
  if (fhKey) {
    for (const sym of SYMBOLS) {
      if (prices[sym].source === 'sim') {
        const data = await fetchFinnhub(fhKey, sym);
        if (data) {
          prices[sym] = { ...prices[sym], ...data, symbol: sym, timestamp: Date.now() };
        }
      }
    }
  }
  
  return prices;
}

function startFetcher() {
  const INTERVAL = parseInt(process.env.FETCH_INTERVAL || '30000', 10);
  
  async function doFetch() {
    try {
      const prices = await fetchAll();
      for (const sym of SYMBOLS) {
        cache[sym] = prices[sym];
      }
      lastFetchTime = new Date();
      const realCount = Object.values(prices).filter(p => p.source === 'api').length;
      console.log(`[${new Date().toLocaleTimeString()}] ${realCount}/${SYMBOLS.length} symboles en temps reel`);
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Erreur:`, err.message);
    }
  }
  
  doFetch();
  setInterval(doFetch, INTERVAL);
  console.log(`Fetch toutes les ${INTERVAL/1000}s demarre`);
}

app.get('/api/prices', (_req, res) => {
  const prices = { ...cache };
  const sourceDetails = {};
  for (const sym of SYMBOLS) {
    sourceDetails[sym] = prices[sym]?.sourceName || 'Simulation';
  }
  
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    prices,
    sources: sourceDetails,
    mode: Object.values(sourceDetails).every(s => s !== 'Simulation') ? 'api' : 
          Object.values(sourceDetails).some(s => s !== 'Simulation') ? 'mixed' : 'simulation',
  });
});

app.get('/api/test', (_req, res) => {
  const prices = Object.values(cache);
  const realCount = prices.filter(p => p.source === 'api').length;
  
  res.json({
    success: realCount > 0,
    twelveData: process.env.TWELVE_DATA_API_KEY ? 'configuree' : 'non configuree',
    finnhub: process.env.FINNHUB_API_KEY ? 'configuree' : 'non configuree',
    realSymbols: realCount,
    lastFetch: lastFetchTime?.toISOString(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/', (_req, res) => {
  res.json({
    message: 'GoldOilFX Backend',
    endpoints: ['/api/prices', '/api/test', '/api/health'],
    twelveData: process.env.TWELVE_DATA_API_KEY ? 'OK' : 'NON CONFIGURE',
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('  GOLDOILFX BACKEND');
  console.log(`  Port: ${PORT}`);
  console.log(`  Twelve Data: ${process.env.TWELVE_DATA_API_KEY ? 'OK' : 'NON CONFIGURE'}`);
  console.log(`  Finnhub: ${process.env.FINNHUB_API_KEY ? 'OK' : 'NON CONFIGURE'}`);
  console.log('');
  console.log('  Endpoints:');
  console.log('    GET /api/prices  - Prix temps reel');
  console.log('    GET /api/test    - Test connexion');
  console.log('    GET /api/health  - Health check');
  console.log('');
  
  startFetcher();
});
