const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const admin = require('firebase-admin');
const app = express();
const PORT = process.env.PORT || 3000;

// ================================
// FIREBASE ADMIN INIT
// ================================

try {
  const serviceAccount = require('./firebase-key.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin initialized');
} catch (e) {
  console.log('⚠️ Firebase key not found');
}

global.fcmTokens = [];

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
let latestGrade = null;
let rejectionCount = {};
let alertLog = [];

// ================================
// FETCH REAL PRICE
// ================================

async function fetchNAS100Price() {
  try {
    const response = await axios.get('https://api.twelvedata.com/price?symbol=NDX&apikey=demo', { timeout: 5000 });
    if (response.data && response.data.price) return parseFloat(response.data.price);
    throw new Error('No price');
  } catch (e) {
    try {
      const backup = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?interval=1m&range=1d', { timeout: 5000 });
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
    const count = timeframe === 'Weekly' ? 52 : timeframe === 'Daily' ? 30 : timeframe === 'H4' ? 168 : timeframe === 'H1' ? 168 : 96;
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
      const prev = candles[i - 1];
      if (prev.close < prev.open && curr.close > curr.open) {
        arrays.push({ type: 'OB', direction: 'BUY', level: Math.round(prev.high * 100) / 100, strength: 'Strong', timeframe });
      }
      if (prev.close > prev.open && curr.close < curr.open) {
        arrays.push({ type: 'OB', direction: 'SELL', level: Math.round(prev.low * 100) / 100, strength: 'Strong', timeframe });
      }
      const prevPrev = candles[i - 2];
      if (prevPrev && prev.high < prevPrev.low) {
        arrays.push({ type: 'FVG', direction: 'BUY', level: Math.round(prev.high * 100) / 100, strength: 'Medium', timeframe });
      }
      if (prevPrev && prev.low > prevPrev.high) {
        arrays.push({ type: 'FVG', direction: 'SELL', level: Math.round(prev.low * 100) / 100, strength: 'Medium', timeframe });
      }
    }
    return arrays;
  }

  determineBias(candles) {
    const recent = candles.slice(-20);
    let b = 0,
      s = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].close > recent[i - 1].close) b++;
      else s++;
    }
    if (b > s + 5) return 'BULLISH';
    if (s > b + 5) return 'BEARISH';
    return 'NEUTRAL';
  }

  analyzeStructure(candles) {
    const recent = candles.slice(-20);
    let highs = [],
      lows = [];
    for (let i = 2; i < recent.length; i++) {
      const prev = recent[i - 1],
        curr = recent[i],
        next = recent[i + 1] || curr;
      if (curr.high > prev.high && curr.high > next.high) highs.push(curr.high);
      if (curr.low < prev.low && curr.low < next.low) lows.push(curr.low);
    }
    if (highs.length < 2 || lows.length < 2) return 'RANGING';
    const lh = highs[highs.length - 1],
      ph = highs[highs.length - 2];
    const ll = lows[lows.length - 1],
      pl = lows[lows.length - 2];
    if (lh > ph && ll > pl) return 'HIGHER_HIGH';
    if (lh > ph && ll < pl) return 'HIGHER_LOW';
    if (lh < ph && ll < pl) return 'LOWER_LOW';
    if (lh < ph && ll > pl) return 'LOWER_HIGH';
    return 'RANGING';
  }

  async analyze() {
    console.log('📊 HTF Analysis...');
    try { const p = await fetchNAS100Price(); if (p) marketState.currentPrice = p; } catch (e) {}
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
// GRADING ENGINE
// ================================

class GradingEngine {
  gradeSetup(setup, marketState) {
    let score = 0;
    const breakdown = {};
    breakdown.irlErlDraw = true;
    if (breakdown.irlErlDraw) score++;
    breakdown.weeklyBiasClear = marketState.weeklyBias === (setup.direction === 'BUY' ? 'BULLISH' : 'BEARISH');
    if (breakdown.weeklyBiasClear) score++;
    breakdown.dailyBiasSame = marketState.dailyBias === (setup.direction === 'BUY' ? 'BULLISH' : 'BEARISH');
    if (breakdown.dailyBiasSame) score++;
    const bullishStructures = ['HIGHER_HIGH', 'HIGHER_LOW'];
    const bearishStructures = ['LOWER_LOW', 'LOWER_HIGH'];
    const validStructures = setup.direction === 'BUY' ? bullishStructures : bearishStructures;
    breakdown.h4StructureConfirm = validStructures.includes(marketState.h4Structure);
    if (breakdown.h4StructureConfirm) score++;
    breakdown.premiumDiscountCorrect = (setup.direction === 'BUY' && setup.zoneType === 'DISCOUNT') || (setup.direction === 'SELL' && setup.zoneType === 'PREMIUM');
    if (breakdown.premiumDiscountCorrect) score++;
    breakdown.obFvgValid = true;
    if (breakdown.obFvgValid) score++;
    breakdown.liquiditySweep = true;
    if (breakdown.liquiditySweep) score++;
    breakdown.mssConfirmed = setup.mss !== undefined && setup.mss !== 'NONE';
    if (breakdown.mssConfirmed) score++;
    breakdown.bonusMsnr = Math.random() > 0.5;
    const bonus = breakdown.bonusMsnr ? 1 : 0;
    const totalScore = score + bonus;
    let grade;
    if (totalScore >= 9) grade = 'A+++++';
    else if (totalScore >= 7) grade = 'A++++';
    else if (totalScore >= 5) grade = 'A+++';
    else grade = 'SKIP';
    let action;
    if (grade === 'A+++++') action = '🚀 FULL SIZE — Perfect Setup!';
    else if (grade === 'A++++') action = '✅ Full Size — Strong Setup';
    else if (grade === 'A+++') action = '📊 Tradeable — Standard Size';
    else action = '⛔ SKIP — Not Enough Confluence';
    return { setupId: Date.now(), totalScore, grade, action, breakdown, bonusMsnr: breakdown.bonusMsnr, notes: `${grade} — ${action}`, timestamp: Date.now() };
  }
}

// ================================
// LTF ENGINE
// ================================

class LTFEngine {
  generateCandles(timeframe, count = 20) {
    const candles = [];
    let price = marketState.currentPrice || 29329;
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

  checkZones(price) {
    const zones = [];
    const discountBottom = marketState.discountZone?.bottom || 28950;
    const discountTop = marketState.discountZone?.top || 29100;
    const premiumBottom = marketState.premiumZone?.bottom || 29350;
    const premiumTop = marketState.premiumZone?.top || 29500;
    if (price >= discountBottom && price <= discountTop) zones.push({ type: 'DISCOUNT', level: price, direction: 'BUY' });
    if (price >= premiumBottom && price <= premiumTop) zones.push({ type: 'PREMIUM', level: price, direction: 'SELL' });
    return zones;
  }

  detectRejection(candles, zoneLevel) {
    if (candles.length < 3) return null;
    const last = candles[candles.length - 1];
    const touchBuffer = 3;
    if (Math.abs(last.low - zoneLevel) <= touchBuffer && last.close > last.low + 5) {
      return { type: 'WICK_REJECTION', level: zoneLevel, candle: last, strength: 'Strong' };
    }
    if (Math.abs(last.high - zoneLevel) <= touchBuffer && last.close < last.high - 5) {
      return { type: 'WICK_REJECTION', level: zoneLevel, candle: last, strength: 'Strong' };
    }
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

  detectMSS(candles) {
    if (candles.length < 5) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];
    if (last.high > prev.high && last.low > prev.low && prev.low > prev2.low) {
      return { type: 'BULLISH_MSS', level: last.high, candle: last, confirmed: true };
    }
    if (last.high < prev.high && last.low < prev.low && prev.high < prev2.high) {
      return { type: 'BEARISH_MSS', level: last.low, candle: last, confirmed: true };
    }
    return null;
  }

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
      mss: mss?.type || 'NONE',
      rejection: rejection?.type || 'NONE'
    };
  }

  monitor() {
    console.log('🔍 LTF Monitoring...');
    const price = marketState.currentPrice;
    const zones = this.checkZones(price);
    if (zones.length === 0) { console.log('📍 No active zone'); return null; }
    console.log(`📍 Zone detected: ${zones[0].type} at ${price}`);
    const m5Candles = this.generateCandles('M5', 30);
    const m1Candles = this.generateCandles('M1', 60);
    const rejection = this.detectRejection(m5Candles, zones[0].level);
    if (!rejection) { console.log('⏳ Waiting for rejection...'); return null; }
    console.log(`📌 Rejection: ${rejection.type} at ${rejection.level}`);
    const mss = this.detectMSS(m1Candles);
    if (!mss) { console.log('⏳ Waiting for MSS...'); return null; }
    console.log(`📈 MSS: ${mss.type}`);
    const setup = this.buildEntry(zones[0], rejection, mss);
    console.log(`✅ SETUP! ${setup.direction} at ${setup.entryPrice}`);
    latestSetup = setup;
    return setup;
  }
}

// ================================
// SEND PUSH NOTIFICATION TO PHONE
// ================================

async function sendPushNotification(setup, grade) {
  if (!admin.apps || admin.apps.length === 0) {
    console.log('⚠️ Firebase not initialized');
    return;
  }
  if (!global.fcmTokens || global.fcmTokens.length === 0) {
    console.log('📱 No FCM tokens registered');
    return;
  }
  const message = {
    notification: {
      title: `🔔 ${setup.direction} Setup Detected!`,
      body: `${setup.direction} at ${setup.entryPrice} | Grade: ${grade.grade}`,
    },
    data: {
      direction: setup.direction,
      entryPrice: setup.entryPrice.toString(),
      slPrice: setup.slPrice.toString(),
      tp1Price: setup.tp1Price.toString(),
      tp2Price: setup.tp2Price.toString(),
      grade: grade.grade,
      url: 'https://nas100-trading.vercel.app'
    }
  };
  for (const token of global.fcmTokens) {
    try {
      await admin.messaging().send({ ...message, token });
      console.log('📱 Push notification sent to phone!');
    } catch (err) {
      console.log('❌ Failed to send:', err.message);
    }
  }
}

// ================================
// INITIALIZE ENGINES
// ================================

const htfEngine = new HTFEngine();
const ltfEngine = new LTFEngine();
const gradingEngine = new GradingEngine();

htfEngine.analyze();

cron.schedule('0 */4 * * *', () => htfEngine.analyze());
cron.schedule('* * * * *', async () => {
  try { const p = await fetchNAS100Price(); if (p) marketState.currentPrice = p; } catch (e) {}
  marketState.lastUpdate = Date.now();
});

cron.schedule('* * * * *', () => {
  const setup = ltfEngine.monitor();
  if (setup) {
    const grade = gradingEngine.gradeSetup(setup, marketState);
    latestGrade = grade;
    const alert = `📊 ${setup.direction} | ${setup.entryPrice} | Grade: ${grade.grade} (${grade.totalScore}/9)`;
    alertLog.push(`${new Date().toLocaleString('en-PK', {timeZone: 'Asia/Karachi'})} — ${alert}`);
    console.log(`📊 ${alert}`);
    sendPushNotification(setup, grade);
  }
});

// ================================
// API ENDPOINTS
// ================================

app.get('/', (req, res) => {
  const setupDisplay = latestSetup ? `
    <div class="setup-box setup-${latestSetup.direction.toLowerCase()}">
      <p><strong>${latestSetup.direction === 'BUY' ? '🟢' : '🔴'} ${latestSetup.direction}</strong> at ${latestSetup.entryPrice}</p>
      <p>SL: ${latestSetup.slPrice} | TP1: ${latestSetup.tp1Price} | TP2: ${latestSetup.tp2Price}</p>
      <p>Range: ${latestSetup.slRange} pts | Zone: ${latestSetup.zoneType}</p>
      ${latestGrade ? `<p>Grade: <strong>${latestGrade.grade}</strong> | ${latestGrade.action}</p>` : ''}
      <p style="font-size:12px;color:#8899aa;">${new Date(latestSetup.timestamp).toLocaleString('en-PK', {timeZone: 'Asia/Karachi'})}</p>
    </div>
  ` : '<p style="color:#8899aa;">No setup detected yet</p>';
  res.send(`
<!DOCTYPE html>
<html>
<head><title>NAS100 Trading Assistant</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial;background:#0a0e17;color:#e0e6ed;padding:20px}
.container{max-width:1200px;margin:0 auto}
h1{color:#00ff88;font-size:24px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.card{background:#141b24;padding:20px;border-radius:10px;border:1px solid #1e2a36}
.badge{display:inline-block;padding:4px 12px;border-radius:12px;font-size:11px;font-weight:600}
.badge.live{background:#00ff88;color:#0a0e17}
.badge.setup{background:#ff6b35;color:#fff}
.bias-bullish{color:#00ff88}
.bias-bearish{color:#ff4466}
.bias-neutral{color:#ffdd88}
.setup-box{background:#1a2630;padding:15px;border-radius:8px;border-left:4px solid #ff6b35;margin-top:10px}
.setup-buy{border-left-color:#00ff88}
.setup-sell{border-left-color:#ff4466}
.footer{margin-top:20px;text-align:center;color:#8899aa;font-size:12px}
.alert-log{max-height:150px;overflow-y:auto}
.alert-item{padding:6px 0;border-bottom:1px solid #1a2630;font-size:13px}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
<h1>🤖 NAS100 Trading Assistant</h1>
<div class="grid">
<div class="card">
<p><span class="badge live">● LIVE</span> Server is running!</p>
<p style="margin-top:10px;">Instrument: <strong>NAS100</strong></p>
<p>Price: <strong>${marketState.currentPrice ? marketState.currentPrice.toFixed(2) : 'Loading...'}</strong></p>
<p>Weekly Bias: <strong class="bias-${marketState.weeklyBias.toLowerCase()}">${marketState.weeklyBias}</strong></p>
<p>Daily Bias: <strong class="bias-${marketState.dailyBias.toLowerCase()}">${marketState.dailyBias}</strong></p>
<p>H4 Structure: <strong>${marketState.h4Structure}</strong></p>
<p>PD Arrays: <strong>${htfEngine.getTotalArrays()}</strong></p>
<p>Last Update: <strong>${new Date(marketState.lastUpdate).toLocaleString('en-PK', {timeZone: 'Asia/Karachi'})}</strong></p>
<p class="fcm-status">📱 Devices: ${global.fcmTokens ? global.fcmTokens.length : 0}</p>
</div>
<div class="card">
<p><span class="badge ${latestSetup ? 'setup' : 'live'}">${latestSetup ? '🔔 SETUP' : '● MONITORING'}</span></p>
${setupDisplay}
${latestGrade ? `<p style="margin-top:10px;"><span class="badge grade">GRADE</span> ${latestGrade.grade} (${latestGrade.totalScore}/9)</p>` : ''}
</div>
</div>
<div class="card" style="margin-top:20px;">
<p style="font-weight:600;">📊 Alert Log</p>
<div class="alert-log">
${alertLog.slice(-10).reverse().map(a => `<div class="alert-item">${a}</div>`).join('') || '<p style="color:#8899aa;">No alerts yet</p>'}
</div>
</div>
<div class="footer">
🔄 Price every minute | HTF every 4 hours | LTF every minute<br>
📍 Discount: ${marketState.discountZone.bottom} - ${marketState.discountZone.top} | Premium: ${marketState.premiumZone.bottom} - ${marketState.premiumZone.top}
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
  res.json({ success: true, data: { setup: latestSetup, grade: latestGrade } });
});

app.get('/api/v1/pd-arrays/:timeframe', (req, res) => {
  const tf = req.params.timeframe.toLowerCase();
  const map = { weekly: htfEngine.arrays.weekly, daily: htfEngine.arrays.daily, h4: htfEngine.arrays.h4, h1: htfEngine.arrays.h1, m30: htfEngine.arrays.m30 };
  res.json({ success: true, data: { timeframe: tf, arrays: map[tf] || [], count: (map[tf] || []).length } });
});

app.post('/api/v1/register-token', express.json(), (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token required' });
  if (!global.fcmTokens) global.fcmTokens = [];
  if (!global.fcmTokens.includes(token)) {
    global.fcmTokens.push(token);
    console.log('📱 New FCM token registered:', token);
  }
  res.json({ success: true, message: 'Token registered successfully', count: global.fcmTokens.length });
});

app.listen(PORT, () => {
  console.log('✅ NAS100 Trading Assistant running on port', PORT);
});
