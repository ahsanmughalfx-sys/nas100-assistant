const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const app = express();
const PORT = process.env.PORT || 3000;

// ================================
// MARKET STATE
// ================================

let marketState = {
  instrument: 'NAS100',
  currentPrice: 29329.21,
  weeklyBias: 'NEUTRAL',
  dailyBias: 'NEUTRAL',
  h4Structure: 'RANGING',
  premiumZone: { top: 29500, bottom: 29350 },
  discountZone: { top: 29100, bottom: 28950 },
  lastUpdate: Date.now()
};

let latestSetup = null;
let activeZones = [];
let rejectionCount = {};

// ================================
// FETCH REAL PRICE
// ================================

async function fetchNAS100Price() {
  try {
    const response = await axios.get(
      'https://api.twelvedata.com/price?symbol=NDX&apikey=demo',
      { timeout: 5000 }
    );
    if (response.data && response.data.price) {
      return parseFloat(response.data.price);
    }
    throw new Error('No price');
  } catch (e) {
    try {
      const backup = await axios.get(
        'https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?interval=1m&range=1d',
        { timeout: 5000 }
      );
      if (backup.data?.chart?.result?.[0]?.meta) {
        return backup.data.chart.result[0].meta.regularMarketPrice || 29329.21;
      }
    } catch (e2) {}
    return marketState.currentPrice || 29329.21;
  }
}

// ================================
// HTF ENGINE
// ================================

class HTFEngine {
  constructor() {
    this.timeframes = ['Weekly', 'Daily', 'H4', 'H1', 'M30'];
    this.arrays = { weekly: [], daily: [], h4: [], h1: [], m30: [] };
  }

  generateMockCandles(timeframe) {
    const count = timeframe === 'Weekly' ? 52 : 
                  timeframe === 'Daily' ? 30 :
                  timeframe === 'H4' ? 168 :
                  timeframe === 'H1' ? 168 : 96;
    const candles = [];
    let price = marketState.currentPrice || 29329;
    for (let i = 0; i < count; i++) {
      const change = (Math.random() - 0.5) * 80;
      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * 25;
      const low = Math.min(open, close) - Math.random() * 25;
      candles.push({ open, high, low, close });
      price = close;
    }
    return candles;
  }

  markPDArrays(candles, timeframe) {
    const arrays = [];
    for (let i = 2; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i-1];
      if (prev.close < prev.open && curr.close > curr.open) {
        arrays.push({ type: 'OB', direction: 'BUY', level: prev.high, strength: 'Strong', timeframe });
      }
      if (prev.close > prev.open && curr.close < curr.open) {
        arrays.push({ type: 'OB', direction: 'SELL', level: prev.low, strength: 'Strong', timeframe });
      }
      const prevPrev = candles[i-2];
      if (prevPrev && prev.high < prevPrev.low) {
        arrays.push({ type: 'FVG', direction: 'BUY', level: prev.high, strength: 'Medium', timeframe });
      }
      if (prevPrev && prev.low > prevPrev.high) {
        arrays.push({ type: 'FVG', direction: 'SELL', level: prev.low, strength: 'Medium', timeframe });
      }
    }
    return arrays;
  }

  determineBias(candles) {
    const recent = candles.slice(-20);
    let b = 0, s = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].close > recent[i-1].close) b++;
      else s++;
    }
    if (b > s + 5) return 'BULLISH';
    if (s > b + 5) return 'BEARISH';
    return 'NEUTRAL';
  }

  analyzeStructure(candles) {
    const recent = candles.slice(-20);
    let highs = [], lows = [];
    for (let i = 2; i < recent.length; i++) {
      const prev = recent[i-1], curr = recent[i], next = recent[i+1] || curr;
      if (curr.high > prev.high && curr.high > next.high) highs.push(curr.high);
      if (curr.low < prev.low && curr.low < next.low) lows.push(curr.low);
    }
    if (highs.length < 2 || lows.length < 2) return 'RANGING';
    const lh = highs[highs.length-1], ph = highs[highs.length-2];
    const ll = lows[lows.length-1], pl = lows[lows.length-2];
    if (lh > ph && ll > pl) return 'HIGHER_HIGH';
    if (lh > ph && ll < pl) return 'HIGHER_LOW';
    if (lh < ph && ll < pl) return 'LOWER_LOW';
    if (lh < ph && ll > pl) return 'LOWER_HIGH';
    return 'RANGING';
  }

  async analyze() {
    console.log('📊 HTF Analysis...');
    try { const p = await fetchNAS100Price(); if (p) marketState.currentPrice = p; } catch(e) {}
    const results = {};
    for (const tf of this.timeframes) {
      const candles = this.generateMockCandles(tf);
      const arrays = this.markPDArrays(candles, tf);
      const bias = this.determineBias(candles);
      results[tf] = { arrays, bias };
    }
    const h4Candles = this.generateMockCandles('H4');
    marketState.weeklyBias = results.Weekly.bias;
    marketState.dailyBias = results.Daily.bias;
    marketState.h4Structure = this.analyzeStructure(h4Candles);
    marketState.lastUpdate = Date.now();
    this.arrays.weekly = results.Weekly.arrays;
    this.arrays.daily = results.Daily.arrays;
    this.arrays.h4 = results.H4.arrays;
    this.arrays.h1 = results.H1.arrays;
    this.arrays.m30 = results.M30.arrays;
    console.log(`✅ Price: ${marketState.currentPrice}, Bias: ${marketState.weeklyBias}, Arrays: ${this.getTotalArrays()}`);
    return results;
  }

  getTotalArrays() {
    return Object.values(this.arrays).reduce((s, a) => s + a.length, 0);
  }
}

// ================================
// LTF ENGINE — LIVE MONITORING
// ================================

class LTFEngine {
  constructor() {
    this.lastCandles = { m15: [], m5: [], m1: [] };
    this.detectedSetups = [];
  }

  // Simulate LTF candles (real-time price based)
  generateCandles(timeframe, count = 20) {
    const candles = [];
    let price = marketState.currentPrice || 29329;
    const step = timeframe === 'M1' ? 1 : timeframe === 'M5' ? 5 : 15;
    for (let i = 0; i < count; i++) {
      const change = (Math.random() - 0.5) * (timeframe === 'M1' ? 5 : timeframe === 'M5' ? 15 : 30);
      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * (timeframe === 'M1' ? 3 : timeframe === 'M5' ? 8 : 15);
      const low = Math.min(open, close) - Math.random() * (timeframe === 'M1' ? 3 : timeframe === 'M5' ? 8 : 15);
      candles.push({ open, high, low, close });
      price = close;
    }
    return candles;
  }

  // Check if price is near any zone
  checkZones(price) {
    const zones = [];
    const discountBottom = marketState.discountZone?.bottom || 28950;
    const discountTop = marketState.discountZone?.top || 29100;
    const premiumBottom = marketState.premiumZone?.bottom || 29350;
    const premiumTop = marketState.premiumZone?.top || 29500;

    // Discount zone (BUY)
    if (price >= discountBottom && price <= discountTop) {
      zones.push({ type: 'DISCOUNT', level: price, direction: 'BUY' });
    }
    // Premium zone (SELL)
    if (price >= premiumBottom && price <= premiumTop) {
      zones.push({ type: 'PREMIUM', level: price, direction: 'SELL' });
    }
    return zones;
  }

  // Detect rejection at zone
  detectRejection(candles, zoneLevel) {
    if (candles.length < 3) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    
    // Wick rejection (price touched zone but closed away)
    const touchBuffer = 3;
    if (Math.abs(last.low - zoneLevel) <= touchBuffer && last.close > last.low + 5) {
      return { type: 'WICK_REJECTION', level: zoneLevel, candle: last, strength: 'Strong' };
    }
    if (Math.abs(last.high - zoneLevel) <= touchBuffer && last.close < last.high - 5) {
      return { type: 'WICK_REJECTION', level: zoneLevel, candle: last, strength: 'Strong' };
    }
    
    // Multi-rejection (2+ times)
    const key = zoneLevel.toFixed(2);
    if (!rejectionCount[key]) rejectionCount[key] = 0;
    if (Math.abs(last.low - zoneLevel) <= touchBuffer || Math.abs(last.high - zoneLevel) <= touchBuffer) {
      rejectionCount[key]++;
      if (rejectionCount[key] >= 2) {
        return { type: 'MULTI_REJECTION', level: zoneLevel, candle: last, strength: 'Strong' };
      }
    }
    return null;
  }

  // Detect Market Structure Shift (MSS)
  detectMSS(candles) {
    if (candles.length < 5) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];

    // Bullish MSS: higher high + higher low
    if (last.high > prev.high && last.low > prev.low && prev.low > prev2.low) {
      return { type: 'BULLISH_MSS', level: last.high, candle: last, confirmed: true };
    }
    // Bearish MSS: lower high + lower low
    if (last.high < prev.high && last.low < prev.low && prev.high < prev2.high) {
      return { type: 'BEARISH_MSS', level: last.low, candle: last, confirmed: true };
    }
    return null;
  }

  // Build entry
  buildEntry(zone, rejection, mss) {
    const direction = zone.direction;
    const entryPrice = rejection ? rejection.level : zone.level;
    const slDistance = direction === 'BUY' ? 60 : 60;
    const slPrice = direction === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance;
    const tp1Distance = direction === 'BUY' ? 60 : 60;
    const tp1Price = direction === 'BUY' ? entryPrice + tp1Distance : entryPrice - tp1Distance;
    const tp2Distance = direction === 'BUY' ? 180 : 180;
    const tp2Price = direction === 'BUY' ? entryPrice + tp2Distance : entryPrice - tp2Distance;

    return {
      direction,
      entryPrice: Math.round(entryPrice * 100) / 100,
      slPrice: Math.round(slPrice * 100) / 100,
      tp1Price: Math.round(tp1Price * 100) / 100,
      tp2Price: Math.round(tp2Price * 100) / 100,
      slRange: slDistance,
      zoneType: zone.type,
      entryPriority: rejection?.type === 'MULTI_REJECTION' ? 'MULTI_REJECTION' : 'WICK_REJECTION',
      timestamp: Date.now(),
      mss: mss.type,
      rejection: rejection.type
    };
  }

  // Main monitor function
  monitor() {
    console.log('🔍 LTF Monitoring...');
    const price = marketState.currentPrice;

    // Check zones
    const zones = this.checkZones(price);
    if (zones.length === 0) {
      console.log('📍 No active zone');
      return null;
    }

    console.log(`📍 Zone detected: ${zones[0].type} at ${price}`);

    // Generate LTF candles
    const m15Candles = this.generateCandles('M15', 20);
    const m5Candles = this.generateCandles('M5', 30);
    const m1Candles = this.generateCandles('M1', 60);

    // Check rejection
    const rejection = this.detectRejection(m5Candles, zones[0].level);
    if (!rejection) {
      console.log('⏳ Waiting for rejection...');
      return null;
    }
    console.log(`📌 Rejection detected: ${rejection.type} at ${rejection.level}`);

    // Check MSS
    const mss = this.detectMSS(m1Candles);
    if (!mss) {
      console.log('⏳ Waiting for MSS...');
      return null;
    }
    console.log(`📈 MSS detected: ${mss.type}`);

    // Build entry
    const setup = this.buildEntry(zones[0], rejection, mss);
    console.log(`✅ SETUP DETECTED! ${setup.direction} at ${setup.entryPrice}`);
    console.log(`   SL: ${setup.slPrice} | TP1: ${setup.tp1Price} | TP2: ${setup.tp2Price}`);
    
    latestSetup = setup;
    return setup;
  }
}

// ================================
// INITIALIZE ENGINES
// ================================

const htfEngine = new HTFEngine();
const ltfEngine = new LTFEngine();

// Run initial analysis
htfEngine.analyze();

// HTF every 4 hours
cron.schedule('0 */4 * * *', () => htfEngine.analyze());

// Price update every minute
cron.schedule('* * * * *', async () => {
  try { const p = await fetchNAS100Price(); if (p) marketState.currentPrice = p; } catch(e) {}
  marketState.lastUpdate = Date.now();
});

// LTF monitoring every minute
cron.schedule('* * * * *', () => {
  ltfEngine.monitor();
});

// ================================
// API ENDPOINTS
// ================================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>NAS100 Trading Assistant</title>
      <style>
        body { font-family: Arial, sans-serif; background: #0a0e17; color: #e0e6ed; padding: 40px; }
        h1 { color: #00ff88; }
        .status { background: #141b24; padding: 20px; border-radius: 10px; border: 1px solid #1e2a36; margin-bottom: 20px; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; }
        .badge.live { background: #00ff88; color: #0a0e17; }
        .badge.setup { background: #ff6b35; color: white; }
        .bias-bullish { color: #00ff88; }
        .bias-bearish { color: #ff4466; }
        .bias-neutral { color: #ffdd88; }
        .setup-box { background: #1a2630; padding: 15px; border-radius: 8px; border-left: 4px solid #ff6b35; }
        .setup-buy { border-left-color: #00ff88; }
        .setup-sell { border-left-color: #ff4466; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
      </style>
    </head>
    <body>
      <h1>🤖 NAS100 Trading Assistant</h1>
      <div class="grid">
        <div class="status">
          <p><span class="badge live">● LIVE</span> Server is running!</p>
          <p>Instrument: <strong>NAS100</strong></p>
          <p>Price: <strong>${marketState.currentPrice ? marketState.currentPrice.toFixed(2) : 'Loading...'}</strong></p>
          <p>Weekly Bias: <strong class="bias-${marketState.weeklyBias.toLowerCase()}">${marketState.weeklyBias}</strong></p>
          <p>Daily Bias: <strong class="bias-${marketState.dailyBias.toLowerCase()}">${marketState.dailyBias}</strong></p>
          <p>H4 Structure: <strong>${marketState.h4Structure}</strong></p>
          <p>PD Arrays: <strong>${htfEngine.getTotalArrays()}</strong></p>
          <p>Last Update: <strong>${new Date(marketState.lastUpdate).toLocaleString('en-PK', {timeZone: 'Asia/Karachi'})}</strong></p>
        </div>
        <div class="status">
          <p><span class="badge ${latestSetup ? 'setup' : 'live'}">${latestSetup ? '🔔 SETUP' : '● MONITORING'}</span></p>
          ${latestSetup ? `
            <div class="setup-box setup-${latestSetup.direction.toLowerCase()}">
              <p><strong>${latestSetup.direction === 'BUY' ? '🟢' : '🔴'} ${latestSetup.direction}</strong> at ${latestSetup.entryPrice}</p>
              <p>SL: ${latestSetup.slPrice} | TP1: ${latestSetup.tp1Price} | TP2: ${latestSetup.tp2Price}</p>
              <p>Range: ${latestSetup.slRange} pts | Priority: ${latestSetup.entryPriority}</p>
              <p style="font-size:12px;color:#8899aa;">${new Date(latestSetup.timestamp).toLocaleString('en-PK', {timeZone: 'Asia/Karachi'})}</p>
            </div>
          ` : '<p style="color:#8899aa;">No setup detected yet</p>'}
          <p style="font-size:12px;color:#8899aa;margin-top:10px;">🔄 Monitoring every minute</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/api/v1/market/current', (req, res) => {
  res.json({ success: true, data: { ...marketState, pdArrays: htfEngine.getTotalArrays() } });
});

app.get('/api/v1/setup/latest', (req, res) => {
  res.json({ success: true, data: latestSetup || null });
});

app.get('/api/v1/pd-arrays/:timeframe', (req, res) => {
  const tf = req.params.timeframe.toLowerCase();
  const map = { weekly: htfEngine.arrays.weekly, daily: htfEngine.arrays.daily, h4: htfEngine.arrays.h4, h1: htfEngine.arrays.h1, m30: htfEngine.arrays.m30 };
  res.json({ success: true, data: { timeframe: tf, arrays: map[tf] || [], count: (map[tf] || []).length } });
});

app.listen(PORT, () => {
  console.log('✅ NAS100 Trading Assistant running on port', PORT);
});
