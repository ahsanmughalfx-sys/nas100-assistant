const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const app = express();
const PORT = process.env.PORT || 3000;

// ================================
// MARKET DATA (Mock - Live data later)
// ================================

let marketState = {
  instrument: 'NAS100',
  currentPrice: 19845.60,
  weeklyBias: 'NEUTRAL',
  dailyBias: 'NEUTRAL',
  h4Structure: 'RANGING',
  premiumZone: { top: 19920, bottom: 19880 },
  discountZone: { top: 19760, bottom: 19720 },
  lastUpdate: Date.now()
};

// ================================
// HTF ANALYSIS ENGINE (NEW!)
// ================================

class HTFEngine {
  constructor() {
    this.timeframes = ['Weekly', 'Daily', 'H4', 'H1', 'M30'];
    this.arrays = {
      weekly: [],
      daily: [],
      h4: [],
      h1: [],
      m30: []
    };
  }

  // Step 1: Fetch candles for each timeframe
  async fetchCandles(timeframe) {
    // Mock data (later: real API)
    return this.generateMockCandles(timeframe);
  }

  generateMockCandles(timeframe) {
    const count = timeframe === 'Weekly' ? 52 : 
                  timeframe === 'Daily' ? 30 :
                  timeframe === 'H4' ? 168 :
                  timeframe === 'H1' ? 168 : 96;
    
    const candles = [];
    let price = 19800;
    for (let i = 0; i < count; i++) {
      const change = (Math.random() - 0.5) * 100;
      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * 30;
      const low = Math.min(open, close) - Math.random() * 30;
      candles.push({ open, high, low, close });
      price = close;
    }
    return candles;
  }

  // Step 2: Mark PD Arrays
  markPDArrays(candles, timeframe) {
    const arrays = [];
    
    // Order Block Detection
    for (let i = 2; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i-1];
      
      // Bullish OB: last bearish candle before bullish move
      if (prev.close < prev.open && curr.close > curr.open) {
        arrays.push({
          type: 'OB',
          direction: 'BUY',
          level: prev.high,
          strength: 'Strong',
          timeframe: timeframe
        });
      }
      
      // Bearish OB: last bullish candle before bearish move
      if (prev.close > prev.open && curr.close < curr.open) {
        arrays.push({
          type: 'OB',
          direction: 'SELL',
          level: prev.low,
          strength: 'Strong',
          timeframe: timeframe
        });
      }
      
      // FVG Detection
      const prevPrev = candles[i-2];
      if (prev.high < prevPrev.low) {
        arrays.push({
          type: 'FVG',
          direction: 'BUY',
          level: prev.high,
          strength: 'Medium',
          timeframe: timeframe
        });
      }
      if (prev.low > prevPrev.high) {
        arrays.push({
          type: 'FVG',
          direction: 'SELL',
          level: prev.low,
          strength: 'Medium',
          timeframe: timeframe
        });
      }
    }
    
    return arrays;
  }

  // Step 3: Determine Bias
  determineBias(candles) {
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    
    if (!last || !prev) return 'NEUTRAL';
    
    if (last.close > prev.close && last.high > prev.high) {
      return 'BULLISH';
    } else if (last.close < prev.close && last.low < prev.low) {
      return 'BEARISH';
    }
    return 'NEUTRAL';
  }

  // Step 4: Analyze H4 Structure
  analyzeStructure(candles) {
    const recent = candles.slice(-20);
    let highs = [];
    let lows = [];
    
    for (let i = 2; i < recent.length; i++) {
      const prev = recent[i-1];
      const curr = recent[i];
      const next = recent[i+1] || curr;
      
      if (curr.high > prev.high && curr.high > next.high) {
        highs.push(curr.high);
      }
      if (curr.low < prev.low && curr.low < next.low) {
        lows.push(curr.low);
      }
    }
    
    if (highs.length < 2 || lows.length < 2) return 'RANGING';
    
    const lastHigh = highs[highs.length - 1];
    const prevHigh = highs[highs.length - 2];
    const lastLow = lows[lows.length - 1];
    const prevLow = lows[lows.length - 2];
    
    if (lastHigh > prevHigh && lastLow > prevLow) return 'HIGHER_HIGH';
    if (lastHigh > prevHigh && lastLow < prevLow) return 'HIGHER_LOW';
    if (lastHigh < prevHigh && lastLow < prevLow) return 'LOWER_LOW';
    if (lastHigh < prevHigh && lastLow > prevLow) return 'LOWER_HIGH';
    
    return 'RANGING';
  }

  // Step 5: Run Full HTF Analysis
  async analyze() {
    console.log('📊 Running HTF Analysis...');
    
    const results = {};
    
    for (const tf of this.timeframes) {
      const candles = await this.fetchCandles(tf);
      const arrays = this.markPDArrays(candles, tf);
      const bias = this.determineBias(candles);
      
      results[tf] = {
        arrays,
        bias,
        candleCount: candles.length
      };
    }
    
    // H4 Structure
    const h4Candles = await this.fetchCandles('H4');
    const structure = this.analyzeStructure(h4Candles);
    
    // Update market state
    marketState.weeklyBias = results.Weekly.bias;
    marketState.dailyBias = results.Daily.bias;
    marketState.h4Structure = structure;
    marketState.lastUpdate = Date.now();
    
    // Store arrays
    this.arrays.weekly = results.Weekly.arrays;
    this.arrays.daily = results.Daily.arrays;
    this.arrays.h4 = results.H4.arrays;
    this.arrays.h1 = results.H1.arrays;
    this.arrays.m30 = results.M30.arrays;
    
    console.log('✅ HTF Analysis Complete!');
    console.log(`Weekly Bias: ${marketState.weeklyBias}`);
    console.log(`Daily Bias: ${marketState.dailyBias}`);
    console.log(`H4 Structure: ${marketState.h4Structure}`);
    console.log(`PD Arrays Found: ${this.getTotalArrays()}`);
    
    return results;
  }

  getTotalArrays() {
    return Object.values(this.arrays).reduce((sum, arr) => sum + arr.length, 0);
  }
}

// ================================
// INITIALIZE ENGINE
// ================================

const htfEngine = new HTFEngine();

// Run first analysis immediately
htfEngine.analyze();

// Schedule every 4 hours (when new HTF candles close)
cron.schedule('0 */4 * * *', () => {
  console.log('⏰ Scheduled HTF Analysis...');
  htfEngine.analyze();
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
        .status { background: #141b24; padding: 20px; border-radius: 10px; border: 1px solid #1e2a36; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; }
        .badge.live { background: #00ff88; color: #0a0e17; }
        .bias-bullish { color: #00ff88; }
        .bias-bearish { color: #ff4466; }
        .bias-neutral { color: #ffdd88; }
      </style>
    </head>
    <body>
      <h1>🤖 NAS100 Trading Assistant</h1>
      <div class="status">
        <p><span class="badge live">● LIVE</span> Server is running!</p>
        <p>Instrument: <strong>${marketState.instrument}</strong></p>
        <p>Price: <strong>${marketState.currentPrice}</strong></p>
        <p>Weekly Bias: <strong class="bias-${marketState.weeklyBias.toLowerCase()}">${marketState.weeklyBias}</strong></p>
        <p>Daily Bias: <strong class="bias-${marketState.dailyBias.toLowerCase()}">${marketState.dailyBias}</strong></p>
        <p>H4 Structure: <strong>${marketState.h4Structure}</strong></p>
        <p>PD Arrays Found: <strong>${htfEngine.getTotalArrays()}</strong></p>
        <p>Last Update: <strong>${new Date(marketState.lastUpdate).toLocaleString('en-PK', {timeZone: 'Asia/Karachi'})}</strong></p>
        <hr>
        <p style="font-size:12px;color:#8899aa;">
          🔄 HTF Analysis runs every 4 hours
        </p>
      </div>
    </body>
    </html>
  `);
});

app.get('/api/v1/market/current', (req, res) => {
  res.json({
    success: true,
    data: {
      instrument: marketState.instrument,
      price: marketState.currentPrice,
      weeklyBias: marketState.weeklyBias,
      dailyBias: marketState.dailyBias,
      h4Structure: marketState.h4Structure,
      pdArrays: htfEngine.getTotalArrays(),
      timestamp: Date.now()
    }
  });
});

app.get('/api/v1/pd-arrays/:timeframe', (req, res) => {
  const tf = req.params.timeframe.toLowerCase();
  const map = {
    weekly: htfEngine.arrays.weekly,
    daily: htfEngine.arrays.daily,
    h4: htfEngine.arrays.h4,
    h1: htfEngine.arrays.h1,
    m30: htfEngine.arrays.m30
  };
  
  res.json({
    success: true,
    data: {
      timeframe: tf,
      arrays: map[tf] || [],
      count: (map[tf] || []).length
    }
  });
});

app.listen(PORT, () => {
  console.log('✅ NAS100 Trading Assistant running on port', PORT);
  console.log(`📊 HTF Engine initialized with ${htfEngine.getTotalArrays()} PD arrays`);
});
