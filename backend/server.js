import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import ti from 'technicalindicators';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    } else if (filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Type', 'application/manifest+json');
    } else if (filePath.endsWith('.png')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

const PORT = process.env.PORT || 3000;

const cache = new Map();
const TTL   = 5 * 60 * 1000;
function getCached(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > TTL) { cache.delete(k); return null; }
  return e.data;
}
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchYahooChart(ticker, interval = '1d') {
  const now  = Math.floor(Date.now() / 1000);
  const past = now - (2 * 365 * 24 * 3600);
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${past}&period2=${now}&interval=${interval}&events=div%2Csplit`;
  try {
    const data = await httpGet(url);
    if (data?.chart?.result?.[0]) return data.chart.result[0];
  } catch(_) {}
  const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${past}&period2=${now}&interval=${interval}`;
  const data2 = await httpGet(url2);
  if (!data2?.chart?.result?.[0]) throw new Error(`Data tidak ditemukan untuk ${ticker}`);
  return data2.chart.result[0];
}

function extractOHLCV(chart) {
  const meta  = chart.meta;
  const quote = chart.indicators?.quote?.[0] || {};
  const ts    = chart.timestamp || [];
  const rawC  = quote.close  || [];
  const rawO  = quote.open   || [];
  const rawH  = quote.high   || [];
  const rawL  = quote.low    || [];
  const rawV  = quote.volume || [];
  const idx   = rawC.map((_,i)=>i).filter(i => rawC[i] != null && !isNaN(rawC[i]));
  return {
    meta,
    closes:  idx.map(i => rawC[i]),
    opens:   idx.map(i => rawO[i] ?? rawC[i]),
    highs:   idx.map(i => rawH[i] ?? rawC[i]),
    lows:    idx.map(i => rawL[i] ?? rawC[i]),
    volumes: idx.map(i => rawV[i] ?? 0),
    dates:   idx.map(i => new Date((ts[i]||0)*1000).toISOString().split('T')[0]),
  };
}

async function fetchFundamental(ticker) {
  const modules = 'financialData,defaultKeyStatistics,summaryDetail,assetProfile';
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;
  try {
    const data = await httpGet(url);
    const r    = data?.quoteSummary?.result?.[0];
    if (!r) return null;
    const fd = r.financialData || {};
    const ks = r.defaultKeyStatistics || {};
    const sd = r.summaryDetail || {};
    const ap = r.assetProfile || {};
    const raw = (v) => (typeof v === 'object' && v !== null) ? (v.raw ?? null) : (v ?? null);
    return {
      roe:          raw(fd.returnOnEquity)    != null ? raw(fd.returnOnEquity)  * 100 : null,
      roa:          raw(fd.returnOnAssets)    != null ? raw(fd.returnOnAssets)  * 100 : null,
      per:          raw(sd.trailingPE)        ?? raw(ks.forwardPE)              ?? null,
      pbv:          raw(ks.priceToBook)                                         ?? null,
      der:          raw(ks.debtToEquity)      != null ? raw(ks.debtToEquity)/100: null,
      netIncome:    raw(fd.netIncomeToCommon) != null ? raw(fd.netIncomeToCommon)/1e9 : null,
      revenue:      raw(fd.totalRevenue)      != null ? raw(fd.totalRevenue)/1e9 : null,
      revGrowth:    raw(fd.revenueGrowth)     != null ? raw(fd.revenueGrowth)*100 : null,
      grossMargin:  raw(fd.grossMargins)      != null ? raw(fd.grossMargins)*100  : null,
      profitMargin: raw(fd.profitMargins)     != null ? raw(fd.profitMargins)*100 : null,
      freeCashFlow: raw(fd.freeCashflow)      != null ? raw(fd.freeCashflow)/1e9  : null,
      eps:          raw(ks.trailingEps)                                         ?? null,
      dividendYield:raw(sd.dividendYield)     != null ? raw(sd.dividendYield)*100: null,
      marketCap:    raw(sd.marketCap)         != null ? raw(sd.marketCap)/1e12   : null,
      beta:         raw(sd.beta)                                                ?? null,
      sector:       ap.sector                                                   ?? null,
      industry:     ap.industry                                                 ?? null,
      _estimated:   false,
    };
  } catch(e) {
    console.warn('[WARN] fundamental gagal:', e.message);
    return null;
  }
}

function estimateFundamental(sym, price) {
  const tbl = {
    BBCA:{ roe:20, per:22, pbv:3.5, der:4.2, sector:'Financial Services', div:2.5 },
    BBRI:{ roe:17, per:13, pbv:2.2, der:5.1, sector:'Financial Services', div:4.2 },
    BMRI:{ roe:19, per:12, pbv:2.0, der:4.8, sector:'Financial Services', div:3.8 },
    TLKM:{ roe:15, per:16, pbv:2.3, der:1.1, sector:'Communication Services', div:5.1 },
    ASII:{ roe:14, per:11, pbv:1.7, der:0.9, sector:'Consumer Cyclical', div:4.5 },
    UNVR:{ roe:68, per:40, pbv:28,  der:0.3, sector:'Consumer Defensive', div:6.2 },
    GOTO:{ roe:-8, per:null,pbv:2.1,der:0.5, sector:'Technology', div:0 },
    BRIS:{ roe:16, per:18, pbv:2.5, der:2.1, sector:'Financial Services', div:1.8 },
    ITMG:{ roe:25, per:8,  pbv:2.0, der:0.4, sector:'Energy', div:12.5 },
    KLBF:{ roe:18, per:24, pbv:4.5, der:0.2, sector:'Healthcare', div:2.8 },
  };
  const d = tbl[sym] ?? { roe:14, per:15, pbv:2, der:1, sector:'Diversified', div:3 };
  return {
    roe:d.roe, roa:d.roe/3, per:d.per, pbv:d.pbv, der:d.der,
    netIncome: price ? +(price * 1e8 / 1e9).toFixed(2) : null,
    revenue:   price ? +(price * 5e8 / 1e9).toFixed(2) : null,
    revGrowth: +(6 + Math.random()*8).toFixed(1),
    grossMargin: +(30 + Math.random()*20).toFixed(1),
    profitMargin: +(d.roe/3).toFixed(1),
    freeCashFlow: null,
    eps: d.per && price ? Math.round(price/d.per) : null,
    dividendYield: d.div,
    marketCap: price ? +(price * 1e10 / 1e12).toFixed(2) : null,
    beta: +(0.8 + Math.random()*0.6).toFixed(2),
    sector: d.sector, industry: null, _estimated: true,
  };
}

// ═══════════════════════════════════════════
// LAYER 1: MULTI-TIMEFRAME ALIGNMENT
// ═══════════════════════════════════════════
function calcMTFSlice(closes, highs, lows) {
  if (!closes || closes.length < 20) return { rsi:null, macdState:'neutral', maTrend:'neutral', rsiZone:'unknown', score:0 };
  const safe = fn => { try { return fn(); } catch(_){ return null; } };
  const rsiArr = safe(() => ti.RSI.calculate({ period:14, values:closes }));
  const rsi    = rsiArr?.length ? rsiArr[rsiArr.length-1] : null;
  const ma20 = safe(() => { const r=ti.SMA.calculate({period:20,values:closes}); return r.length?r[r.length-1]:null; });
  const ma50 = safe(() => { const r=ti.SMA.calculate({period:50,values:closes}); return r.length?r[r.length-1]:null; });
  const price = closes[closes.length-1];
  let macdState = 'neutral';
  if (closes.length >= 35) {
    const mr = safe(() => ti.MACD.calculate({fastPeriod:12,slowPeriod:26,signalPeriod:9,SimpleMAOscillator:false,SimpleMASignal:false,values:closes}));
    if (mr?.length) { const last=mr[mr.length-1]; macdState = last.MACD > last.signal ? 'bullish' : 'bearish'; }
  }
  const maTrend = ma20 && ma50 ? (ma20>ma50?'bullish':'bearish') : (ma20 ? (price>ma20?'bullish':'bearish') : 'neutral');
  const rsiZone = rsi===null?'unknown':rsi>70?'overbought':rsi<30?'oversold':rsi>50?'bullish':'bearish';
  let score = 0;
  if (rsi!==null) { if (rsi>50&&rsi<70) score+=1; else if (rsi>=40&&rsi<=50) score+=0.5; }
  if (macdState==='bullish') score+=0.5;
  if (maTrend==='bullish') score+=0.5;
  if (ma20&&price>ma20) score=Math.min(score+0.5, 2);
  score = Math.min(2, Math.round(score*2)/2);
  return { rsi:rsi?+rsi.toFixed(1):null, rsiZone, macdState, maTrend, price, ma20, ma50, score };
}

async function calcMultiTimeframe(ticker) {
  const cacheKey = `mtf_${ticker}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  try {
    const [cd,cw,cm] = await Promise.allSettled([
      fetchYahooChart(ticker,'1d'),
      fetchYahooChart(ticker,'1wk'),
      fetchYahooChart(ticker,'1mo'),
    ]);
    const daily   = cd.status==='fulfilled' ? extractOHLCV(cd.value) : null;
    const weekly  = cw.status==='fulfilled' ? extractOHLCV(cw.value) : null;
    const monthly = cm.status==='fulfilled' ? extractOHLCV(cm.value) : null;
    const dI = daily   ? calcMTFSlice(daily.closes,daily.highs,daily.lows)   : {rsi:null,macdState:'neutral',maTrend:'neutral',rsiZone:'unknown',score:0};
    const wI = weekly  ? calcMTFSlice(weekly.closes,weekly.highs,weekly.lows) : {rsi:null,macdState:'neutral',maTrend:'neutral',rsiZone:'unknown',score:0};
    const mI = monthly ? calcMTFSlice(monthly.closes,monthly.highs,monthly.lows) : {rsi:null,macdState:'neutral',maTrend:'neutral',rsiZone:'unknown',score:0};
    const totalScore = dI.score + wI.score + mI.score;
    let alignment, alignmentColor;
    if (totalScore>=4)      { alignment='BULLISH ALIGNED'; alignmentColor='green'; }
    else if (totalScore<=2) { alignment='BEARISH ALIGNED'; alignmentColor='red'; }
    else                    { alignment='MIXED'; alignmentColor='yellow'; }
    const result = { daily:dI, weekly:wI, monthly:mI, totalScore:+totalScore.toFixed(1), alignment, alignmentColor, mtfScore:Math.round((totalScore/6)*25) };
    setCache(cacheKey, result);
    return result;
  } catch(e) {
    console.warn('[MTF]', e.message);
    const empty = {rsi:null,macdState:'neutral',maTrend:'neutral',rsiZone:'unknown',score:0};
    return { daily:empty, weekly:empty, monthly:empty, totalScore:0, alignment:'UNKNOWN', alignmentColor:'gray', mtfScore:0 };
  }
}

// ═══════════════════════════════════════════
// LAYER 2: DYNAMIC SUPPORT & RESISTANCE
// ═══════════════════════════════════════════
function detectSwings(highs, lows, minConf=3) {
  const sH=[], sL=[], len=Math.min(highs.length,lows.length);
  for (let i=minConf; i<len-minConf; i++) {
    let isH=true, isL=true;
    for (let j=1;j<=minConf;j++){
      if(highs[i]<=highs[i-j]||highs[i]<=highs[i+j]) isH=false;
      if(lows[i]>=lows[i-j]||lows[i]>=lows[i+j]) isL=false;
    }
    if(isH) sH.push({idx:i,price:highs[i]});
    if(isL) sL.push({idx:i,price:lows[i]});
  }
  return {swingHighs:sH, swingLows:sL};
}

function calcVolumeProfile(closes, volumes, bins=25) {
  if (!closes.length) return [];
  const minP=Math.min(...closes), maxP=Math.max(...closes);
  const bSize=(maxP-minP)/bins;
  if (bSize===0) return [];
  const b=Array.from({length:bins},(_,i)=>({low:minP+i*bSize,high:minP+(i+1)*bSize,mid:minP+(i+0.5)*bSize,vol:0}));
  for (let i=0;i<closes.length;i++) { const bi=Math.min(Math.floor((closes[i]-minP)/bSize),bins-1); b[bi].vol+=volumes[i]; }
  const mx=Math.max(...b.map(x=>x.vol));
  return b.map(x=>({...x,strength:mx>0?x.vol/mx:0})).sort((a,b)=>b.vol-a.vol);
}

function calcSupportResistance(closes, highs, lows, volumes) {
  if (!closes||closes.length<30) return {levels:[],fibonacci:null,srQuality:50,sl:0,tp1:0,tp2:0,tp3:0,slPct:5,tp1Pct:8,tp2Pct:15,tp3Pct:25,rrTp1:1.5,rrTp2:2.5,rrTp3:4};
  const {swingHighs,swingLows} = detectSwings(highs,lows);
  const price = closes[closes.length-1];
  const vp = calcVolumeProfile(closes,volumes,30);
  const vpLevels = vp.slice(0,5).map(b=>({price:+b.mid.toFixed(0),type:b.mid<price?'support':'resistance',strength:b.strength>0.7?'strong':b.strength>0.4?'moderate':'weak',source:'volume_profile'}));
  const recent60H = swingHighs.filter(s=>s.idx>=closes.length-60);
  const recent60L = swingLows.filter(s=>s.idx>=closes.length-60);
  const swingLevels=[
    ...recent60H.map(s=>({price:+s.price.toFixed(0),type:s.price<price?'support':'resistance',strength:'moderate',source:'swing_high'})),
    ...recent60L.map(s=>({price:+s.price.toFixed(0),type:s.price<price?'support':'resistance',strength:'moderate',source:'swing_low'})),
  ];
  const all=[...vpLevels,...swingLevels];
  const merged=[];
  for (const lvl of all) {
    const dup=merged.find(m=>Math.abs(m.price-lvl.price)/Math.max(lvl.price,1)<0.005);
    if (dup) { if(dup.strength==='moderate') dup.strength='strong'; dup.source=dup.source+'+'+lvl.source; }
    else merged.push({...lvl});
  }
  const supports=merged.filter(l=>l.type==='support').sort((a,b)=>b.price-a.price);
  const resistances=merged.filter(l=>l.type==='resistance').sort((a,b)=>a.price-b.price);
  let fibonacci=null;
  if (swingHighs.length&&swingLows.length) {
    const mH=Math.max(...swingHighs.slice(-5).map(s=>s.price));
    const mL=Math.min(...swingLows.slice(-5).map(s=>s.price));
    if (mH>mL) { const diff=mH-mL; fibonacci={high:mH,low:mL,fib236:mH-diff*0.236,fib382:mH-diff*0.382,fib500:mH-diff*0.5,fib618:mH-diff*0.618,fib1618:mL-diff*0.618}; }
  }
  const sl  = supports[0]    ? supports[0].price * 0.99  : price * 0.95;
  const tp1 = resistances[0] ? resistances[0].price       : price * 1.08;
  const tp2 = resistances[1] ? resistances[1].price       : price * 1.15;
  const tp3 = fibonacci      ? +fibonacci.fib1618.toFixed(0) : price * 1.25;
  let srQuality=50;
  if(supports.length>=2) srQuality+=15;
  if(resistances.length>=2) srQuality+=15;
  if(supports[0]?.strength==='strong') srQuality+=20;
  if(fibonacci) srQuality+=10;
  srQuality=Math.min(100,srQuality);
  return {
    levels:merged.sort((a,b)=>a.price-b.price), supports, resistances, fibonacci,
    sl:+sl.toFixed(0), tp1:+tp1.toFixed(0), tp2:+tp2.toFixed(0), tp3:+tp3.toFixed(0),
    slPct:+((price-sl)/price*100).toFixed(2),
    tp1Pct:+((tp1-price)/price*100).toFixed(2),
    tp2Pct:+((tp2-price)/price*100).toFixed(2),
    tp3Pct:+((tp3-price)/price*100).toFixed(2),
    rrTp1:tp1>sl?+((tp1-price)/(price-sl)).toFixed(2):0,
    rrTp2:tp2>sl?+((tp2-price)/(price-sl)).toFixed(2):0,
    rrTp3:tp3>sl?+((tp3-price)/(price-sl)).toFixed(2):0,
    srQuality,
  };
}

// ═══════════════════════════════════════════
// LAYER 3: MARKET REGIME DETECTION
// ═══════════════════════════════════════════
async function detectMarketRegime(ihsgOHLCV) {
  try {
    const {closes,highs,lows} = ihsgOHLCV;
    if (!closes||closes.length<50) return {regime:'UNKNOWN',color:'gray',regimeScore:10,impact:'Data IHSG tidak tersedia.',ihsgVsMA200:0};
    const ma200Arr=ti.SMA.calculate({period:Math.min(200,closes.length),values:closes});
    const ma200=ma200Arr.length?ma200Arr[ma200Arr.length-1]:null;
    const price=closes[closes.length-1];
    let adx=null;
    try { const ar=ti.ADX.calculate({high:highs,low:lows,close:closes,period:14}); if(ar?.length) adx=ar[ar.length-1]?.adx??null; } catch(_){}
    const aboveMA200=ma200?price>ma200:null;
    const ihsgVsMA200=ma200?+((price-ma200)/ma200*100).toFixed(2):0;
    let regime,color,regimeScore,impact;
    if (adx!==null&&adx<20) {
      regime='SIDEWAYS';color='yellow';regimeScore=10;
      impact='Pasar konsolidasi. Gunakan SL lebih ketat, hindari breakout palsu.';
    } else if (aboveMA200&&adx!==null&&adx>25) {
      regime='BULL';color='green';regimeScore=20;
      impact='Pasar bullish kuat. Sinyal beli lebih valid, target lebih ambisius.';
    } else if (!aboveMA200&&adx!==null&&adx>25) {
      regime='BEAR';color='red';regimeScore=0;
      impact='Pasar bearish. Threshold beli dinaikkan — prioritaskan capital preservation.';
    } else if (aboveMA200) {
      regime='BULL';color='green';regimeScore=15;
      impact='IHSG di atas MA200, tren positif namun momentum belum kuat.';
    } else {
      regime='BEAR';color='red';regimeScore=5;
      impact='IHSG di bawah MA200, hati-hati dengan posisi beli baru.';
    }
    return {regime,color,regimeScore,impact,ihsgVsMA200,ma200:ma200?+ma200.toFixed(0):null,adx:adx?+adx.toFixed(1):null,price:+price.toFixed(0)};
  } catch(e) {
    return {regime:'UNKNOWN',color:'gray',regimeScore:10,impact:'Gagal memuat data IHSG.',ihsgVsMA200:0};
  }
}

// ═══════════════════════════════════════════
// LAYER 4: VOLUME CONFIRMATION GATE
// ═══════════════════════════════════════════
function calcCompositeVolume(closes, highs, lows, volumes) {
  if (!closes||closes.length<20) return {compositeScore:50,volumeGate:false,volumeScore:10};
  const n=closes.length;
  const avgVol20=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const lastVol=volumes[n-1];
  const volRatio=avgVol20>0?lastVol/avgVol20:1;
  const volumeGate=volRatio>=1.2;
  const climaxVolume=volRatio>3;
  const price=closes[n-1];
  const prevClose=closes[n-2]||price;
  const priceChange=(price-prevClose)/prevClose*100;
  // MFI
  let mfi=50;
  try {
    const period=14;
    if (n>=period+1) {
      let posF=0,negF=0;
      for(let i=n-period;i<n;i++){const tp=(highs[i]+lows[i]+closes[i])/3;const prevTp=(highs[i-1]+lows[i-1]+closes[i-1])/3;const mf=tp*volumes[i];if(tp>prevTp)posF+=mf;else negF+=mf;}
      const mfr=negF>0?posF/negF:100;
      mfi=+(100-100/(1+mfr)).toFixed(1);
    }
  } catch(_){}
  // OBV
  const obv=[0];
  for(let i=1;i<n;i++){if(closes[i]>closes[i-1])obv.push(obv[i-1]+volumes[i]);else if(closes[i]<closes[i-1])obv.push(obv[i-1]-volumes[i]);else obv.push(obv[i-1]);}
  const obvLast=obv[n-1];
  const obvMA20=obv.slice(-20).reduce((a,b)=>a+b,0)/20;
  const obvTrend=obvLast>obvMA20?'up':'down';
  // CMF
  const period=Math.min(20,n);
  let mfvSum=0,volSum=0;
  for(let i=n-period;i<n;i++){const hl=highs[i]-lows[i];if(hl===0)continue;const clv=((closes[i]-lows[i])-(highs[i]-closes[i]))/hl;mfvSum+=clv*volumes[i];volSum+=volumes[i];}
  const cmf=volSum>0?mfvSum/volSum:0;
  // Institutional footprint
  const body=Math.abs(closes[n-1]-(closes[n-2]||closes[n-1]));
  const range=highs[n-1]-lows[n-1];
  const bodyRatio=range>0?body/range:0;
  const closeNearHigh=(highs[n-1]-closes[n-1])/Math.max(range,1)<0.3;
  const institutionalFootprint=bodyRatio>0.7&&volRatio>=1.5&&closeNearHigh;
  // Composite score
  let score=50;
  score+=cmf*80;
  score+=obvTrend==='up'?10:-10;
  if(mfi>60) score+=10; else if(mfi<40) score-=10;
  if(volRatio>=2) score+=15; else if(volRatio>=1.2) score+=8; else if(volRatio<0.7) score-=10;
  if(institutionalFootprint) score+=10;
  if(climaxVolume&&priceChange>0) score-=15;
  score=Math.max(0,Math.min(100,Math.round(score)));
  return {
    compositeScore:score,volumeGate,volRatio:+volRatio.toFixed(2),
    climaxVolume,climaxDirection:priceChange>0?'up':'down',
    mfi:+mfi.toFixed(1),mfiSignal:mfi>80?'OVERBOUGHT':mfi<20?'OVERSOLD':mfi>60?'BULLISH':mfi<40?'BEARISH':'NEUTRAL',
    obvTrend,obvLast:Math.round(obvLast),
    cmf:+cmf.toFixed(4),cmfSignal:cmf>0.1?'POSITIF KUAT':cmf>0?'POSITIF':cmf>-0.1?'NEGATIF':'NEGATIF KUAT',
    institutionalFootprint,avgVol20:Math.round(avgVol20),lastVol,
    volumeScore:Math.round(score/100*20),
  };
}

// ═══════════════════════════════════════════
// LAYER 5: SIGNAL PROBABILITY ENGINE
// ═══════════════════════════════════════════
function buildFingerprint(tech, vol, bandar, mtf, regime) {
  return {
    rsiZone:      tech.rsiSig==='OVERSOLD'?'oversold':tech.rsiSig==='OVERBOUGHT'?'overbought':(tech.rsi&&tech.rsi>50)?'bullish':'bearish',
    macdState:    tech.macdSig==='BULLISH'?'bullish':'bearish',
    volumeRatio:  vol?.volRatio??1,
    bandarPhase:  bandar?(bandar.smScore>=60?'accumulation':bandar.smScore<=40?'distribution':'neutral'):'neutral',
    regime:       regime?.regime??'UNKNOWN',
    mtfAlignment: mtf?.alignment??'UNKNOWN',
    maTrend:      tech.uptrend?'bullish':'bearish',
  };
}

function matchFP(fp1, fp2) {
  let m=0;
  if(fp1.rsiZone===fp2.rsiZone) m++;
  if(fp1.macdState===fp2.macdState) m++;
  if(fp1.maTrend===fp2.maTrend) m++;
  if(fp1.bandarPhase===fp2.bandarPhase) m++;
  if(fp1.regime===fp2.regime) m++;
  if(Math.abs(fp1.volumeRatio-fp2.volumeRatio)/Math.max(fp1.volumeRatio,1)<=0.10) m++;
  return m;
}

function calcSignalProbability(closes, highs, lows, volumes, currentFp) {
  if (closes.length<60) return {winRate:null,sampleCount:0,message:'Data historis tidak cukup',avgReturn5d:null,probScore:7};
  const lookback=closes.length-30;
  const results=[];
  const safe=fn=>{try{return fn();}catch(_){return null;}};
  for (let i=30;i<lookback;i++) {
    const sl=closes.slice(0,i),hl=highs.slice(0,i),ll=lows.slice(0,i),vl=volumes.slice(0,i);
    if(sl.length<25) continue;
    const rsiArr=safe(()=>ti.RSI.calculate({period:14,values:sl}));
    const rsi=rsiArr?.length?rsiArr[rsiArr.length-1]:null;
    let macdState='bearish';
    if(sl.length>=35){const mr=safe(()=>ti.MACD.calculate({fastPeriod:12,slowPeriod:26,signalPeriod:9,SimpleMAOscillator:false,SimpleMASignal:false,values:sl}));if(mr?.length){const last=mr[mr.length-1];macdState=last.MACD>last.signal?'bullish':'bearish';}}
    const ma20r=safe(()=>ti.SMA.calculate({period:20,values:sl}));
    const ma20=ma20r?.length?ma20r[ma20r.length-1]:null;
    const ma50r=safe(()=>ti.SMA.calculate({period:50,values:sl}));
    const ma50=ma50r?.length?ma50r[ma50r.length-1]:null;
    const avgV=vl.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
    const vr=avgV>0?vl[vl.length-1]/avgV:1;
    const ov=[0];for(let j=1;j<vl.length;j++){if(sl[j]>sl[j-1])ov.push(ov[j-1]+vl[j]);else if(sl[j]<sl[j-1])ov.push(ov[j-1]-vl[j]);else ov.push(ov[j-1]);}
    const ovMA=ov.slice(-20).reduce((a,b)=>a+b,0)/20;
    const hFp={
      rsiZone:rsi===null?'unknown':rsi>70?'overbought':rsi<30?'oversold':rsi>50?'bullish':'bearish',
      macdState,
      maTrend:(ma20&&ma50)?(ma20>ma50?'bullish':'bearish'):(ma20?(sl[sl.length-1]>ma20?'bullish':'bearish'):'bearish'),
      volumeRatio:vr,
      bandarPhase:ov[ov.length-1]>ovMA?'accumulation':'distribution',
      regime:currentFp.regime,
      mtfAlignment:currentFp.mtfAlignment,
    };
    if(matchFP(currentFp,hFp)>=4){
      const fc=closes.slice(i,i+5);
      if(fc.length<3) continue;
      const ep=sl[sl.length-1];
      const reached=fc.some(x=>x>=ep*1.03);
      const ret5d=(fc[fc.length-1]-ep)/ep*100;
      results.push({reached,return5d:ret5d});
    }
  }
  if(results.length<8) return {winRate:null,sampleCount:results.length,message:'Data historis tidak cukup (min 8 kejadian serupa)',avgReturn5d:null,probScore:7};
  const wins=results.filter(r=>r.reached).length;
  const winRate=Math.round(wins/results.length*100);
  const avg=+(results.reduce((a,r)=>a+r.return5d,0)/results.length).toFixed(2);
  return {winRate,sampleCount:results.length,message:`Kondisi ini terjadi ${results.length}× dalam 2 tahun, ${winRate}% berhasil mencapai TP1 (+3%)`,avgReturn5d:avg,probScore:Math.round(winRate/100*15)};
}

// ═══════════════════════════════════════════
// BANDAR ANALYSIS (v6 compat)
// ═══════════════════════════════════════════
function calcBandarAnalysis(closes, highs, lows, volumes) {
  if (!closes||closes.length<20) return null;
  const n=closes.length;
  const obv=[0];
  for(let i=1;i<n;i++){if(closes[i]>closes[i-1])obv.push(obv[i-1]+volumes[i]);else if(closes[i]<closes[i-1])obv.push(obv[i-1]-volumes[i]);else obv.push(obv[i-1]);}
  const obvLast=obv[n-1];const obvMA20=obv.slice(-20).reduce((a,b)=>a+b,0)/20;const obvTrend=obvLast>obvMA20?'NAIK':'TURUN';
  const period=Math.min(20,n);let mfvSum=0,volSum=0;
  for(let i=n-period;i<n;i++){const hl=highs[i]-lows[i];if(hl===0)continue;const clv=((closes[i]-lows[i])-(highs[i]-closes[i]))/hl;mfvSum+=clv*volumes[i];volSum+=volumes[i];}
  const cmf=volSum>0?mfvSum/volSum:0;
  const avgVol20=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;const lastVol=volumes[n-1];const volRatio=avgVol20>0?lastVol/avgVol20:1;
  const lastClose=closes[n-1];const prevClose=closes[n-2]||lastClose;const priceChange=(lastClose-prevClose)/prevClose*100;
  let volSpikeType='NORMAL';
  if(volRatio>=2){volSpikeType=priceChange>0.5?'AKUMULASI_KUAT':priceChange<-0.5?'DISTRIBUSI_KUAT':'NEUTRAL_SPIKE';}
  else if(volRatio>=1.5){volSpikeType=priceChange>0.3?'AKUMULASI':priceChange<-0.3?'DISTRIBUSI':'NEUTRAL';}
  const rC=closes.slice(-6),rV=volumes.slice(-6);
  const priceDir=rC[5]>rC[0]?'NAIK':'TURUN';const volDir=rV[5]>rV[0]?'NAIK':'TURUN';
  let divergence='KONFIRMASI';
  if(priceDir==='NAIK'&&volDir==='NAIK') divergence='AKUMULASI_VALID';
  if(priceDir==='NAIK'&&volDir==='TURUN') divergence='WEAK_RALLY';
  if(priceDir==='TURUN'&&volDir==='NAIK') divergence='DISTRIBUSI_AKTIF';
  if(priceDir==='TURUN'&&volDir==='TURUN') divergence='LESU';
  let smScore=50;
  if(cmf>0.15)smScore+=20;else if(cmf>0.05)smScore+=10;else if(cmf<-0.15)smScore-=20;else if(cmf<-0.05)smScore-=10;
  if(obvTrend==='NAIK')smScore+=15;else smScore-=10;
  if(divergence==='AKUMULASI_VALID')smScore+=15;else if(divergence==='DISTRIBUSI_AKTIF')smScore-=15;else if(divergence==='WEAK_RALLY')smScore-=5;
  if(volSpikeType==='AKUMULASI_KUAT')smScore+=15;else if(volSpikeType==='AKUMULASI')smScore+=8;else if(volSpikeType==='DISTRIBUSI_KUAT')smScore-=15;else if(volSpikeType==='DISTRIBUSI')smScore-=8;
  smScore=Math.max(0,Math.min(100,Math.round(smScore)));
  let bandarPhase,bandarDesc,bandarColor;
  if(smScore>=75){bandarPhase='AKUMULASI KUAT';bandarDesc='Sinyal kuat bandar/smart money sedang membeli. Volume naik konsisten dengan harga, CMF positif kuat. Potensi breakout meningkat.';bandarColor='green';}
  else if(smScore>=60){bandarPhase='AKUMULASI';bandarDesc='Indikasi bandar mulai mengumpulkan saham. CMF positif, OBV naik. Perhatikan konfirmasi volume breakout.';bandarColor='green';}
  else if(smScore>=45){bandarPhase='SIDEWAYS / MARKUP';bandarDesc='Bandar dalam fase konsolidasi. Belum ada sinyal kuat akumulasi maupun distribusi.';bandarColor='yellow';}
  else if(smScore>=30){bandarPhase='DISTRIBUSI';bandarDesc='Indikasi smart money mulai menjual (distribusi). Volume naik saat harga turun. Waspadai penurunan lanjutan.';bandarColor='red';}
  else{bandarPhase='DISTRIBUSI KUAT';bandarDesc='Sinyal kuat bandar sedang melepas saham. CMF negatif, divergence volume-harga konfirmasi distribusi. Hindari posisi beli baru.';bandarColor='red';}
  return {cmf:+cmf.toFixed(4),cmfSignal:cmf>0.1?'POSITIF KUAT':cmf>0?'POSITIF':cmf>-0.1?'NEGATIF':'NEGATIF KUAT',obv:Math.round(obvLast),obvTrend,volRatio:+volRatio.toFixed(2),volSpikeType,divergence,smScore,bandarPhase,bandarDesc,bandarColor,obvHistory:obv.slice(-30),avgVol20:Math.round(avgVol20),lastVol};
}

// ═══════════════════════════════════════════
// PRO LAYER A: RSI DIVERGENCE DETECTOR
// ═══════════════════════════════════════════
function detectRSIDivergence(closes, highs, lows) {
  if (!closes || closes.length < 30) return { bullish: false, bearish: false, type: 'NONE', strength: 0, desc: 'Data tidak cukup' };
  const safe = fn => { try { return fn(); } catch(_) { return null; } };
  const rsiArr = safe(() => ti.RSI.calculate({ period: 14, values: closes }));
  if (!rsiArr || rsiArr.length < 20) return { bullish: false, bearish: false, type: 'NONE', strength: 0, desc: 'RSI data tidak cukup' };

  // Align RSI with closes (RSI starts at index 14)
  const rsiOffset = closes.length - rsiArr.length;
  const lookback = Math.min(30, rsiArr.length - 2);

  // Find recent swing lows in price (for bullish divergence)
  let swingLows = [];
  for (let i = 2; i < lookback; i++) {
    const pi = closes.length - 1 - i;
    if (pi >= 2 && closes[pi] < closes[pi-1] && closes[pi] < closes[pi+1] &&
        closes[pi] < closes[pi-2] && closes[pi] < closes[pi+2]) {
      const ri = rsiArr.length - 1 - i;
      if (ri >= 0) swingLows.push({ priceIdx: pi, rsiIdx: ri, price: closes[pi], rsi: rsiArr[ri] });
    }
  }

  // Find recent swing highs in price (for bearish divergence)
  let swingHighs = [];
  for (let i = 2; i < lookback; i++) {
    const pi = closes.length - 1 - i;
    if (pi >= 2 && closes[pi] > closes[pi-1] && closes[pi] > closes[pi+1] &&
        closes[pi] > closes[pi-2] && closes[pi] > closes[pi+2]) {
      const ri = rsiArr.length - 1 - i;
      if (ri >= 0) swingHighs.push({ priceIdx: pi, rsiIdx: ri, price: closes[pi], rsi: rsiArr[ri] });
    }
  }

  const currentRsi = rsiArr[rsiArr.length - 1];
  const currentPrice = closes[closes.length - 1];

  let bullish = false, bearish = false, type = 'NONE', strength = 0, desc = 'Tidak ada divergensi terdeteksi';

  // Bullish divergence: price makes lower low, RSI makes higher low
  if (swingLows.length >= 1) {
    const prev = swingLows[0];
    const prevRsiAtLow = prev.rsi;
    // Check: current price near recent low, RSI higher
    const recentLow = Math.min(...closes.slice(-8));
    const rsiAtRecentLow = rsiArr[rsiArr.length - 1];
    if (prev.price > recentLow && prevRsiAtLow < rsiAtRecentLow && currentPrice <= prev.price * 1.03) {
      bullish = true;
      type = 'BULLISH_DIVERGENCE';
      const rsiDiff = rsiAtRecentLow - prevRsiAtLow;
      strength = Math.min(100, Math.round(50 + rsiDiff * 3));
      desc = `Bullish divergence: Harga buat lower low (${Math.round(recentLow)} < ${Math.round(prev.price)}) tapi RSI justru naik (${prevRsiAtLow.toFixed(1)} → ${rsiAtRecentLow.toFixed(1)}) — sinyal pembalikan naik kuat.`;
    }
  }

  // Bearish divergence: price makes higher high, RSI makes lower high
  if (!bullish && swingHighs.length >= 1) {
    const prev = swingHighs[0];
    const recentHigh = Math.max(...closes.slice(-8));
    const rsiAtRecentHigh = rsiArr[rsiArr.length - 1];
    if (prev.price < recentHigh && prev.rsi > rsiAtRecentHigh && currentPrice >= prev.price * 0.97) {
      bearish = true;
      type = 'BEARISH_DIVERGENCE';
      const rsiDiff = prev.rsi - rsiAtRecentHigh;
      strength = Math.min(100, Math.round(50 + rsiDiff * 3));
      desc = `Bearish divergence: Harga buat higher high (${Math.round(recentHigh)} > ${Math.round(prev.price)}) tapi RSI turun (${prev.rsi.toFixed(1)} → ${rsiAtRecentHigh.toFixed(1)}) — sinyal pembalikan turun.`;
    }
  }

  // Hidden bullish: price higher low, RSI lower low (continuation)
  if (!bullish && !bearish && swingLows.length >= 1) {
    const prev = swingLows[0];
    const recentLow = Math.min(...closes.slice(-8));
    const rsiAtLow = rsiArr[rsiArr.length - 1];
    if (prev.price < recentLow && prev.rsi > rsiAtLow && currentRsi < 50) {
      type = 'HIDDEN_BULLISH';
      strength = 45;
      desc = `Hidden bullish divergence: Harga membuat higher low, RSI membuat lower low — sinyal kelanjutan uptrend (continuation pattern).`;
    }
  }

  return {
    bullish, bearish, type, strength, desc,
    currentRsi: +currentRsi.toFixed(1),
    divergenceScore: bullish ? Math.round(strength / 100 * 20) : bearish ? 0 : type === 'HIDDEN_BULLISH' ? 10 : 5,
  };
}

// ═══════════════════════════════════════════
// PRO LAYER B: BREAKOUT + RETEST DETECTOR
// ═══════════════════════════════════════════
function detectBreakoutRetest(closes, highs, lows, volumes, sr) {
  if (!closes || closes.length < 20 || !sr) return { breakout: false, retest: false, type: 'NONE', score: 0, desc: 'Data tidak cukup' };

  const n = closes.length;
  const price = closes[n - 1];
  const prevPrice = closes[n - 2] || price;
  const avgVol20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[n - 1];
  const volRatio = avgVol20 > 0 ? lastVol / avgVol20 : 1;

  // Gather key resistance & support levels
  const resistances = (sr.resistances || []).slice(0, 5);
  const supports = (sr.supports || []).slice(0, 5);

  let breakout = false, retest = false, type = 'NONE', score = 0, desc = '';
  let breakoutLevel = null, retestLevel = null;

  // --- Check breakout above resistance ---
  for (const res of resistances) {
    const lvl = res.price;
    const tolerance = lvl * 0.012; // 1.2% tolerance
    // Current candle broke above
    if (price > lvl + tolerance && prevPrice <= lvl + tolerance) {
      breakout = true;
      type = 'BREAKOUT_UP';
      breakoutLevel = lvl;
      score += 30;
      if (volRatio >= 1.5) { score += 25; desc = `🚀 Breakout resistance Rp ${lvl.toLocaleString('id-ID')} TERKONFIRMASI volume (${volRatio.toFixed(1)}x avg). Ini sinyal sangat kuat — resistance menjadi support baru.`; }
      else { score += 10; desc = `⚡ Breakout resistance Rp ${lvl.toLocaleString('id-ID')} TANPA volume kuat (${volRatio.toFixed(1)}x). Waspadai false breakout — tunggu volume konfirmasi.`; }
      if (res.strength === 'strong') score += 15;
      break;
    }
  }

  // --- Check retest of broken resistance (now support) ---
  if (!breakout) {
    // Look for breakout in last 5-15 candles, now price pulling back to retest
    const recentHigh = Math.max(...closes.slice(-15, -1));
    for (const res of resistances) {
      const lvl = res.price;
      // If recent high was above this level and now price is near it from above
      if (recentHigh > lvl * 1.01 && price >= lvl * 0.985 && price <= lvl * 1.025) {
        retest = true;
        type = 'RETEST_SUPPORT';
        retestLevel = lvl;
        score += 40;
        const instFP = volRatio >= 1.0 && (highs[n-1] - lows[n-1]) > 0 && (closes[n-1] - lows[n-1]) / (highs[n-1] - lows[n-1]) > 0.6;
        if (instFP) score += 20;
        desc = `🎯 Retest support di Rp ${lvl.toLocaleString('id-ID')} (bekas resistance). ${instFP ? 'Candle menutup kuat di atas level ini — setup entry IDEAL.' : 'Tunggu konfirmasi candle close di atas level ini sebelum entry.'}`;
        break;
      }
    }
  }

  // --- Check breakdown below support ---
  if (!breakout && !retest) {
    for (const sup of supports) {
      const lvl = sup.price;
      const tolerance = lvl * 0.012;
      if (price < lvl - tolerance && prevPrice >= lvl - tolerance) {
        type = 'BREAKDOWN_DOWN';
        breakoutLevel = lvl;
        score = 0;
        desc = `⚠ Breakdown support Rp ${lvl.toLocaleString('id-ID')} — ${volRatio >= 1.5 ? 'TERKONFIRMASI volume, hindari posisi beli baru' : 'volume belum konfirmasi, waspadai false breakdown'}.`;
        break;
      }
    }
  }

  if (!breakout && !retest && type === 'NONE') {
    desc = 'Belum ada breakout atau retest signifikan terdeteksi di level S/R kunci.';
    score = 5;
  }

  // Institutional footprint bonus
  const body = Math.abs(closes[n-1] - (closes[n-2] || closes[n-1]));
  const range = highs[n-1] - lows[n-1];
  const instFP = range > 0 && body/range > 0.65 && volRatio >= 1.4 && closes[n-1] > (highs[n-1] + lows[n-1]) / 2;
  if (instFP && (breakout || retest)) score += 10;

  return {
    breakout, retest, type, score: Math.min(100, score), desc,
    breakoutLevel, retestLevel, volRatio: +volRatio.toFixed(2),
    institutionalFootprint: instFP,
    breakoutScore: Math.round(Math.min(100, score) / 100 * 20),
  };
}

// ═══════════════════════════════════════════
// PRO LAYER C: TRIPLE CONFIRMATION ENGINE
// (MACD cross + MTF align + Volume gate)
// ═══════════════════════════════════════════
function calcTripleConfirmation(tech, mtf, vol, bandar, divergence, breakoutRetest) {
  const confirmations = [];
  const failures = [];
  let tripleScore = 0;

  // --- PILLAR 1: MACD Cross ---
  const macdBull = tech.macd && tech.macd.MACD > tech.macd.signal;
  const macdStrong = tech.macd && Math.abs(tech.macd.MACD - tech.macd.signal) > Math.abs(tech.macd.MACD) * 0.05;
  if (macdBull) {
    tripleScore += 25;
    confirmations.push({ icon: '📈', label: 'MACD Bullish Cross', value: `Hist: ${tech.macd.histogram?.toFixed(2) ?? '–'}`, status: 'pass' });
  } else {
    failures.push({ icon: '📉', label: 'MACD Bearish', value: tech.macd ? `${tech.macd.MACD?.toFixed(2)}` : '–', status: 'fail' });
  }

  // --- PILLAR 2: MTF Alignment ---
  const mtfBull = mtf && mtf.totalScore >= 3.5;
  const mtfStrong = mtf && mtf.totalScore >= 4.5;
  if (mtfStrong) {
    tripleScore += 30;
    confirmations.push({ icon: '🎯', label: 'MTF Strong Aligned', value: `${mtf.totalScore}/6 TF Bullish`, status: 'pass' });
  } else if (mtfBull) {
    tripleScore += 18;
    confirmations.push({ icon: '📊', label: 'MTF Partially Aligned', value: `${mtf.totalScore}/6 TF`, status: 'partial' });
  } else {
    failures.push({ icon: '⚠', label: 'MTF Tidak Aligned', value: `${mtf?.totalScore ?? 0}/6 TF`, status: 'fail' });
  }

  // --- PILLAR 3: Volume Gate ---
  const volPass = vol && vol.volumeGate;
  const volStrong = vol && vol.volRatio >= 2.0;
  if (volStrong) {
    tripleScore += 25;
    confirmations.push({ icon: '💧', label: 'Volume Spike Kuat', value: `${vol.volRatio}× avg`, status: 'pass' });
  } else if (volPass) {
    tripleScore += 15;
    confirmations.push({ icon: '💧', label: 'Volume Gate Pass', value: `${vol.volRatio}× avg`, status: 'partial' });
  } else {
    failures.push({ icon: '🔇', label: 'Volume Insufficient', value: `${vol?.volRatio ?? '–'}× avg`, status: 'fail' });
  }

  // --- BONUS: RSI Divergence ---
  if (divergence?.bullish) {
    tripleScore += 15;
    confirmations.push({ icon: '🔀', label: 'RSI Bullish Divergence', value: `Strength ${divergence.strength}`, status: 'bonus' });
  } else if (divergence?.type === 'HIDDEN_BULLISH') {
    tripleScore += 8;
    confirmations.push({ icon: '🔀', label: 'Hidden Bullish Div.', value: 'Continuation', status: 'partial' });
  } else if (divergence?.bearish) {
    tripleScore = Math.max(0, tripleScore - 15);
    failures.push({ icon: '🔀', label: 'RSI Bearish Divergence', value: `⚠ Reversal risk`, status: 'fail' });
  }

  // --- BONUS: Breakout/Retest ---
  if (breakoutRetest?.breakout && breakoutRetest.type === 'BREAKOUT_UP') {
    tripleScore += 15;
    confirmations.push({ icon: '🚀', label: 'Breakout Resistance', value: `Vol ${breakoutRetest.volRatio}×`, status: 'bonus' });
  } else if (breakoutRetest?.retest) {
    tripleScore += 20;
    confirmations.push({ icon: '🎯', label: 'Retest Support Bekas Res.', value: 'Entry ideal zone', status: 'bonus' });
  } else if (breakoutRetest?.type === 'BREAKDOWN_DOWN') {
    tripleScore = Math.max(0, tripleScore - 20);
    failures.push({ icon: '📉', label: 'Breakdown Support', value: '⚠ Avoid entry', status: 'fail' });
  }

  // --- BONUS: Smart Money ---
  if (bandar?.smScore >= 70) {
    tripleScore += 10;
    confirmations.push({ icon: '🐋', label: 'Smart Money Akumulasi', value: `Score ${bandar.smScore}/100`, status: 'bonus' });
  } else if (bandar?.smScore <= 35) {
    tripleScore = Math.max(0, tripleScore - 10);
    failures.push({ icon: '🐋', label: 'Smart Money Distribusi', value: `Score ${bandar.smScore}/100`, status: 'fail' });
  }

  tripleScore = Math.max(0, Math.min(100, Math.round(tripleScore)));

  const pillarsPass = [macdBull, mtfBull, volPass].filter(Boolean).length;
  let verdict, verdictColor, verdictClass;
  if (pillarsPass === 3 && tripleScore >= 65) {
    verdict = 'TRIPLE KONFIRMASI ✅ — Ketiga pilar bullish. Sinyal masuk berkualitas tinggi.';
    verdictColor = 'green'; verdictClass = 'triple-full';
  } else if (pillarsPass >= 2 && tripleScore >= 45) {
    verdict = 'DOUBLE KONFIRMASI ⚡ — 2 dari 3 pilar terkonfirmasi. Setup cukup kuat, pertimbangkan entry dengan SL ketat.';
    verdictColor = 'yellow'; verdictClass = 'triple-double';
  } else if (pillarsPass === 1) {
    verdict = 'SINYAL LEMAH ⚠ — Hanya 1 pilar terkonfirmasi. Tunggu konfirmasi tambahan sebelum entry.';
    verdictColor = 'orange'; verdictClass = 'triple-weak';
  } else {
    verdict = 'TIDAK ADA KONFIRMASI ✗ — Belum ada kondisi bullish terpenuhi. HINDARI posisi beli.';
    verdictColor = 'red'; verdictClass = 'triple-none';
  }

  return {
    tripleScore, pillarsPass, confirmations, failures,
    verdict, verdictColor, verdictClass,
    tripleBonus: Math.round(tripleScore / 100 * 10),
    detail: {
      macd: { pass: macdBull, strong: macdStrong },
      mtf: { pass: mtfBull, strong: mtfStrong, score: mtf?.totalScore ?? 0 },
      volume: { pass: volPass, strong: volStrong, ratio: vol?.volRatio ?? 0 },
    }
  };
}

// ═══════════════════════════════════════════
// INDIKATOR TEKNIKAL
// ═══════════════════════════════════════════
function calcTechnicals(closes, highs, lows) {
  if (!closes||closes.length<20) return {price:closes?.slice(-1)[0]??0,uptrend:false,T:40};
  const safe=fn=>{try{return fn();}catch(_){return null;}};
  const smaL=p=>safe(()=>{const r=ti.SMA.calculate({period:p,values:closes});return r.length?r[r.length-1]:null;});
  const emaL=p=>safe(()=>{const r=ti.EMA.calculate({period:p,values:closes});return r.length?r[r.length-1]:null;});
  const ma20=smaL(20),ma50=smaL(50),ma200=closes.length>=200?smaL(200):null,ema12=emaL(12),ema26=emaL(26);
  const rsiArr=safe(()=>ti.RSI.calculate({period:14,values:closes}));
  const rsi=rsiArr?.length?rsiArr[rsiArr.length-1]:null;
  const macdObj=closes.length>=35?safe(()=>{const r=ti.MACD.calculate({fastPeriod:12,slowPeriod:26,signalPeriod:9,SimpleMAOscillator:false,SimpleMASignal:false,values:closes});return r?.length?r[r.length-1]:null;}):null;
  const bbObj=safe(()=>{const r=ti.BollingerBands.calculate({period:20,stdDev:2,values:closes});return r?.length?r[r.length-1]:null;});
  const atr=(highs?.length>=15&&lows?.length>=15)?safe(()=>{const r=ti.ATR.calculate({period:14,high:highs,low:lows,close:closes});return r?.length?r[r.length-1]:null;}):null;
  const stoch=(highs?.length>=17)?safe(()=>{const r=ti.Stochastic.calculate({high:highs,low:lows,close:closes,period:14,signalPeriod:3});return r?.length?r[r.length-1]:null;}):null;
  const price=closes[closes.length-1];
  const uptrend=ma20&&ma50?ma20>ma50:price>(ma20??price*0.98);
  const golden=ma50&&ma200?ma50>ma200:false;
  const rsiSig=rsi==null?'–':rsi>70?'OVERBOUGHT':rsi<30?'OVERSOLD':'NEUTRAL';
  const macdSig=macdObj?(macdObj.MACD>macdObj.signal?'BULLISH':'BEARISH'):'–';
  const bbSig=bbObj?(price>bbObj.upper?'OVERBOUGHT':price<bbObj.lower?'OVERSOLD':'INSIDE BAND'):'–';
  let T=0;
  if(price>(ma20??0))T+=20;if(price>(ma50??0))T+=15;
  if(ma20&&ma50&&ma20>ma50)T+=15;if(ma50&&ma200&&ma50>ma200)T+=15;
  if(rsi&&rsi>30&&rsi<70)T+=15;if(macdObj&&macdObj.MACD>macdObj.signal)T+=10;
  if(bbObj&&price>bbObj.middle)T+=10;
  return {price,ma20,ma50,ma200,ema12,ema26,rsi,rsiSig,macd:macdObj,macdSig,bb:bbObj,bbSig,atr,stoch,uptrend,golden,priceVsMA20Pct:ma20?(price-ma20)/ma20*100:null,priceVsMA50Pct:ma50?(price-ma50)/ma50*100:null,T};
}

function norm(v,min,max,rev=false){
  if(v==null||isNaN(v))return 50;
  let n=((v-min)/(max-min))*100;n=Math.max(0,Math.min(100,n));return rev?100-n:n;
}
function calcDSS(price, tech, fund) {
  const{roe,roa,per,pbv,der,revGrowth,grossMargin,profitMargin,dividendYield,freeCashFlow,beta}=fund;
  const F=Math.round(norm(roe,0,35)*0.30+norm(roa,0,20)*0.20+norm(grossMargin,0,60)*0.15+norm(profitMargin,-20,40)*0.20+(freeCashFlow>0?70:freeCashFlow==null?50:20)*0.10+norm(dividendYield??0,0,15)*0.05);
  const V=Math.round(norm(per,0,60,true)*0.45+norm(pbv,0,15,true)*0.35+norm(der==null?1:1/Math.max(der,0.01),0,5)*0.20);
  const G=Math.round(norm(revGrowth??0,-20,40)*0.70+norm(profitMargin??0,-20,40)*0.30);
  const T=Math.min(100,Math.round(tech.T??50));
  const S=Math.round(norm(beta==null?1:Math.abs(beta),0,3,true)*0.30+norm(tech.priceVsMA50Pct??0,-30,30)*0.50+50*0.20);
  const total=Math.min(100,Math.round(F*0.30+V*0.20+G*0.20+T*0.20+S*0.10));
  const atrPct=tech.atr?(tech.atr/price*100):2.5;
  const slPct=parseFloat(Math.max(atrPct*1.5,5).toFixed(1));
  const tpPct=parseFloat(Math.max(atrPct*3.0+total/10,10).toFixed(1));
  return{F,V,G,T,S,total,slPct,tpPct,rr:(tpPct/slPct).toFixed(1)};
}

function calcScalpingScore(closes, highs, lows, volumes, tech, bandar) {
  if(!closes||closes.length<10) return null;
  const n=closes.length,price=closes[n-1],prev=closes[n-2]||price;
  let score=0;const factors=[];
  const mom1d=(price-prev)/prev*100;
  if(mom1d>1){score+=20;factors.push({f:'Momentum 1H',v:`+${mom1d.toFixed(1)}%`,pos:true});}
  else if(mom1d>0){score+=10;factors.push({f:'Momentum 1H',v:`+${mom1d.toFixed(1)}%`,pos:true});}
  else{factors.push({f:'Momentum 1H',v:`${mom1d.toFixed(1)}%`,pos:false});}
  if(bandar&&bandar.volRatio>=2){score+=20;factors.push({f:'Volume Spike',v:`${bandar.volRatio.toFixed(1)}x avg`,pos:true});}
  else if(bandar&&bandar.volRatio>=1.3){score+=10;factors.push({f:'Volume',v:`${bandar.volRatio.toFixed(1)}x avg`,pos:true});}
  else if(bandar){factors.push({f:'Volume',v:`${bandar.volRatio.toFixed(1)}x avg`,pos:false});}
  if(tech.rsi){if(tech.rsi>=40&&tech.rsi<=65){score+=20;factors.push({f:'RSI Sweet Spot',v:tech.rsi.toFixed(1),pos:true});}else if(tech.rsi<40&&tech.rsi>=30){score+=12;factors.push({f:'RSI Oversold',v:tech.rsi.toFixed(1),pos:true});}else{factors.push({f:'RSI',v:tech.rsi.toFixed(1),pos:false});}}
  if(tech.macd&&tech.macd.MACD>tech.macd.signal){score+=15;factors.push({f:'MACD Bullish',v:'Crossover',pos:true});}else if(tech.macd){factors.push({f:'MACD',v:'Bearish',pos:false});}
  if(tech.bb){const bbR=tech.bb.upper-tech.bb.lower,posInBB=bbR>0?(price-tech.bb.lower)/bbR:0.5;if(posInBB<=0.3){score+=15;factors.push({f:'Near Support BB',v:`${(posInBB*100).toFixed(0)}%`,pos:true});}else if(posInBB<=0.5){score+=8;factors.push({f:'Mid BB Zone',v:`${(posInBB*100).toFixed(0)}%`,pos:true});}else{factors.push({f:'BB Position',v:`${(posInBB*100).toFixed(0)}%`,pos:false});}}
  if(bandar&&bandar.smScore>=65){score+=10;factors.push({f:'Bandar Akumulasi',v:`Score ${bandar.smScore}`,pos:true});}else if(bandar&&bandar.smScore>=50){score+=5;factors.push({f:'Bandar Neutral',v:`Score ${bandar.smScore}`,pos:null});}else if(bandar){factors.push({f:'Bandar Distribusi',v:`Score ${bandar.smScore}`,pos:false});}
  const atrPct=tech.atr?(tech.atr/price*100):2;
  return{score:Math.min(100,score),factors,targetPct:+Math.max(5,atrPct*2.5).toFixed(1),slPct:+(atrPct*1.2).toFixed(1),isScalpCandidate:score>=55};
}

// ═══════════════════════════════════════════
// LAYER 6: COMPOSITE SIGNAL ENGINE
// ═══════════════════════════════════════════
function calcCompositeSignal(mtf, sr, regime, vol, prob, tech, bandar) {
  const mtfScore    = mtf?.mtfScore    ?? 0;
  const srScore     = Math.round((sr?.srQuality??50)/100*20);
  const regimeScore = regime?.regimeScore ?? 10;
  const volScore    = vol?.volumeScore   ?? 10;
  const probScore   = prob?.probScore    ?? 7;

  let signal = mtfScore + srScore + regimeScore + volScore + probScore;
  if (regime?.regime==='BEAR') signal = Math.round(signal*0.85);
  if (vol && !vol.volumeGate) signal = Math.max(0, signal-10);
  signal = Math.max(0, Math.min(100, Math.round(signal)));

  let action, actionLabel;
  if (signal>=80)       { action='strong_buy'; actionLabel='STRONG BUY'; }
  else if (signal>=65)  { action='buy';        actionLabel='BUY'; }
  else if (signal>=40)  { action='wait';       actionLabel='WAIT'; }
  else                  { action='avoid';      actionLabel='AVOID'; }

  const reasons=[], warnings=[];
  if(mtf?.totalScore>=4)       reasons.push({icon:'✓',text:`Multi-timeframe aligned BULLISH (score ${mtf.totalScore}/6)`});
  else if(mtf?.totalScore<=2)  warnings.push(`Multi-timeframe bearish aligned (score ${mtf?.totalScore??0}/6) — momentum lemah lintas timeframe`);
  else                         reasons.push({icon:'~',text:`Multi-timeframe MIXED (score ${mtf?.totalScore??0}/6)`});

  if(sr?.srQuality>=70)        reasons.push({icon:'✓',text:`Level S/R kuat teridentifikasi — setup risk/reward valid`});
  else if(sr?.srQuality<50)    warnings.push('Level support/resistance lemah — SL mungkin tidak optimal');

  if(regime?.regime==='BULL')        reasons.push({icon:'✓',text:`IHSG dalam regime BULL (+${regime.ihsgVsMA200}% vs MA200) — kondisi mendukung posisi long`});
  else if(regime?.regime==='BEAR')   warnings.push(`IHSG dalam regime BEAR — threshold beli lebih ketat, prioritaskan capital preservation`);
  else if(regime?.regime==='SIDEWAYS') warnings.push('Pasar SIDEWAYS — waspadai false breakout, gunakan SL lebih ketat');

  if(vol?.volumeGate)          reasons.push({icon:'✓',text:`Volume konfirmasi: ${vol.volRatio}× avg 20H — likuiditas mencukupi untuk entry`});
  else                         warnings.push(`Volume di bawah threshold (${vol?.volRatio??'?'}× avg < 1.2×) — sinyal belum terkonfirmasi volume`);
  if(vol?.climaxVolume)        warnings.push(`Climax volume terdeteksi (${vol?.volRatio}× avg) — potensi exhaustion/reversal`);
  if(vol?.institutionalFootprint) reasons.push({icon:'✓',text:'Institutional footprint: candle besar + volume tinggi + close near high'});

  if(bandar?.smScore>=65)      reasons.push({icon:'✓',text:`Smart Money Score ${bandar.smScore}/100 — fase akumulasi aktif`});
  else if(bandar?.smScore<40)  warnings.push(`Smart Money Score rendah (${bandar?.smScore??'?'}/100) — distribusi aktif`);

  if(tech?.rsi&&tech.rsi>30&&tech.rsi<70) reasons.push({icon:'✓',text:`RSI ${tech.rsi.toFixed(1)} zona netral — ruang gerak terbuka`});
  if(tech?.macdSig==='BULLISH')  reasons.push({icon:'✓',text:'MACD bullish crossover — momentum positif'});
  if(tech?.golden)               reasons.push({icon:'✓',text:'Golden Cross MA50/MA200 — tren jangka panjang bullish'});
  if(tech?.rsi>70)               warnings.push(`RSI overbought (${tech.rsi.toFixed(1)}) — risiko koreksi jangka pendek`);

  if(prob?.winRate>=65)        reasons.push({icon:'✓',text:prob.message});
  else if(prob?.winRate!=null) warnings.push(`Win rate historis: ${prob.winRate}% dari ${prob.sampleCount} kejadian serupa`);

  const price=tech.price;
  const atrPct=tech.atr?tech.atr/price*100:2;
  const entryLow=Math.round(price*(1-atrPct*0.005));
  const entryHigh=Math.round(price*(1+atrPct*0.005));
  const tp1Pct=sr?.tp1Pct??8;
  const holdingDays=tp1Pct>0?Math.max(3,Math.round(tp1Pct/atrPct)):10;

  return {
    signal, action, actionLabel,
    reasons:reasons.slice(0,6), warnings,
    entryZone:{low:entryLow,high:entryHigh},
    sl:sr?.sl??Math.round(price*0.95),
    tp1:sr?.tp1??Math.round(price*1.08),
    tp2:sr?.tp2??Math.round(price*1.15),
    tp3:sr?.tp3??Math.round(price*1.25),
    slPct:-(sr?.slPct??5),
    tp1Pct:sr?.tp1Pct??8,
    tp2Pct:sr?.tp2Pct??15,
    tp3Pct:sr?.tp3Pct??25,
    rrTp1:sr?.rrTp1??1.5,
    rrTp2:sr?.rrTp2??2.5,
    rrTp3:sr?.rrTp3??4.0,
    holdingDays,
    components:{
      mtf:{label:'MTF Alignment',score:mtfScore,max:25},
      sr:{label:'S/R Quality',score:srScore,max:20},
      regime:{label:'Market Regime',score:regimeScore,max:20},
      volume:{label:'Volume Confirm',score:volScore,max:20},
      prob:{label:'Probability',score:probScore,max:15},
    },
    probabilityData:prob??{},
  };
}

// ═══════════════════════════════════════════
// MAIN FETCH
// ═══════════════════════════════════════════
async function fetchStockData(symbol) {
  const ticker=`${symbol}.JK`;
  const cacheKey=`stock_${ticker}`;
  const cached=getCached(cacheKey);
  if(cached){console.log(`[CACHE] ${ticker}`);return cached;}
  console.log(`[FETCH] ${ticker}`);
  const chart=await fetchYahooChart(ticker);
  const{meta,closes,opens,highs,lows,volumes,dates}=extractOHLCV(chart);
  const price=meta.regularMarketPrice||meta.chartPreviousClose;
  const prevClose=meta.chartPreviousClose||price;
  if(!price) throw new Error(`Harga tidak tersedia untuk ${symbol}`);
  let fundamental=await fetchFundamental(ticker);
  if(!fundamental) fundamental=estimateFundamental(symbol,price);
  const currentPrice=price||closes[closes.length-1];
  const change=currentPrice-prevClose;
  const changePct=prevClose?(change/prevClose*100):0;
  const result={symbol,ticker,companyName:meta.longName||meta.shortName||symbol+' Tbk',price:currentPrice,prevClose,change:+change.toFixed(2),changePct:+changePct.toFixed(4),open:meta.regularMarketOpen||closes[closes.length-1],high52w:meta.fiftyTwoWeekHigh||Math.max(...closes),low52w:meta.fiftyTwoWeekLow||Math.min(...closes),volume:meta.regularMarketVolume||volumes[volumes.length-1]||0,avgVolume:meta.regularMarketVolume||0,marketState:meta.marketState||'CLOSED',currency:meta.currency||'IDR',exchange:meta.exchangeName||'IDX',closes,opens,highs,lows,volumes,dates,fundamental};
  setCache(cacheKey,result);
  return result;
}

// ─── API: /api/analyze ────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const raw=(req.body.symbol??'').toString().toUpperCase().replace(/\.JK$/i,'').trim();
    if(!raw) return res.status(400).json({error:'Symbol tidak boleh kosong.'});
    const ticker=`${raw}.JK`;

    // Fetch paralel: data saham + IHSG + MTF
    const [d, ihsgResult, mtf] = await Promise.all([
      fetchStockData(raw),
      fetchYahooChart('^JKSE').then(extractOHLCV).catch(()=>null),
      calcMultiTimeframe(ticker),
    ]);

    const tech   = calcTechnicals(d.closes, d.highs, d.lows);
    const bandar = calcBandarAnalysis(d.closes, d.highs, d.lows, d.volumes);
    const dss    = calcDSS(d.price, tech, d.fundamental);
    const scalp  = calcScalpingScore(d.closes, d.highs, d.lows, d.volumes, tech, bandar);
    const sr     = calcSupportResistance(d.closes, d.highs, d.lows, d.volumes);
    const regime = await detectMarketRegime(ihsgResult || {closes:[],highs:[],lows:[]});
    const vol    = calcCompositeVolume(d.closes, d.highs, d.lows, d.volumes);
    const fp     = buildFingerprint(tech, vol, bandar, mtf, regime);
    const prob   = calcSignalProbability(d.closes, d.highs, d.lows, d.volumes, fp);
    const composite = calcCompositeSignal(mtf, sr, regime, vol, prob, tech, bandar);
    // PRO layers
    const divergence     = detectRSIDivergence(d.closes, d.highs, d.lows);
    const breakoutRetest = detectBreakoutRetest(d.closes, d.highs, d.lows, d.volumes, sr);
    const tripleConfirm  = calcTripleConfirmation(tech, mtf, vol, bandar, divergence, breakoutRetest);

    const actionMap = {strong_buy:'strong_buy',buy:'buy',wait:'hold',avoid:'sell'};
    const recMap    = {strong_buy:'STRONG BUY',buy:'BUY',hold:'WAIT',sell:'AVOID'};
    const action    = actionMap[composite.action] || 'hold';

    res.json({
      symbol:raw, displaySymbol:raw, companyName:d.companyName,
      price:d.price, change:d.change, changePct:d.changePct,
      open:d.open, high52w:d.high52w, low52w:d.low52w,
      volume:d.volume, avgVolume:d.avgVolume,
      marketState:d.marketState, exchange:d.exchange,
      action, recommendation:recMap[action]||'WAIT',
      scores:{F:dss.F,V:dss.V,G:dss.G,T:dss.T,S:dss.S,total:dss.total},
      tradingPlan:{entry:d.price,sl:Math.round(d.price*(1-dss.slPct/100)),tp:Math.round(d.price*(1+dss.tpPct/100)),slPct:-dss.slPct,tpPct:dss.tpPct,rr:dss.rr},
      technicals:{ma20:tech.ma20,ma50:tech.ma50,ma200:tech.ma200,ema12:tech.ema12,ema26:tech.ema26,rsi:tech.rsi,rsiSig:tech.rsiSig,macd:tech.macd,macdSig:tech.macdSig,bb:tech.bb,bbSig:tech.bbSig,atr:tech.atr,stoch:tech.stoch,uptrend:tech.uptrend,golden:tech.golden,priceVsMA20Pct:tech.priceVsMA20Pct,priceVsMA50Pct:tech.priceVsMA50Pct},
      fundamentals:d.fundamental,
      bandarAnalysis:bandar,
      scalpingAnalysis:scalp,
      // v7 fields
      signalV7:composite,
      // PRO fields
      rsiDivergence:divergence,
      breakoutRetest:breakoutRetest,
      tripleConfirmation:tripleConfirm,
      multiTimeframe:mtf,
      supportResistance:sr,
      marketRegime:regime,
      volumeAnalysis:vol,
      signalProbability:prob,
      chartData:{labels:d.dates.slice(-90),closes:d.closes.slice(-90),opens:d.opens?d.opens.slice(-90):d.closes.slice(-90).map((c,i,a)=>i===0?c:a[i-1]),highs:d.highs.slice(-90),lows:d.lows.slice(-90),volumes:d.volumes.slice(-90),obvHistory:bandar?.obvHistory||[],srLevels:sr?.levels?.slice(0,10)??[]},
      dataSource:d.fundamental._estimated?'Yahoo Finance (Harga Real) + Estimasi Fundamental':'Yahoo Finance (Real-time)',
      analyzedAt:new Date().toISOString(),
    });
  } catch(err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({error:err.message});
  }
});

// ─── API: /api/compare ────────────────────
app.post('/api/compare', async (req, res) => {
  const{symbols}=req.body;
  if(!Array.isArray(symbols)||symbols.length<2) return res.status(400).json({error:'Minimal 2 symbol.'});
  const results=await Promise.allSettled(symbols.map(async s=>{
    const sym=s.toUpperCase().replace(/\.JK$/i,'').trim();
    const d=await fetchStockData(sym);
    const tech=calcTechnicals(d.closes,d.highs,d.lows);
    const sc=calcDSS(d.price,tech,d.fundamental);
    const bandar=calcBandarAnalysis(d.closes,d.highs,d.lows,d.volumes);
    const vol=calcCompositeVolume(d.closes,d.highs,d.lows,d.volumes);
    const action=sc.total>80?'STRONG BUY':sc.total>=65?'BUY':sc.total>=50?'HOLD':'SELL';
    return{symbol:sym,companyName:d.companyName,price:d.price,changePct:d.changePct,scores:sc,recommendation:action,fundamental:d.fundamental,bandar,volumeScore:vol.compositeScore};
  }));
  res.json(results.filter(r=>r.status==='fulfilled').map(r=>r.value));
});

// ─── API: /api/scalping ───────────────────
const SCALPING_UNIVERSE=['BBCA','BBRI','BMRI','TLKM','ASII','UNVR','GOTO','BRIS','ITMG','KLBF','INDF','ANTM','PTBA','ADRO','ICBP','EXCL','INCO','CPIN','MYOR','HMSP','PGAS','SMGR','JSMR','WIKA','WSKT','BJBR','AGRO','SIDO','INKP','TKIM'];
app.post('/api/scalping', async (req, res) => {
  const universe=req.body.symbols||SCALPING_UNIVERSE;
  const limit=Math.min(req.body.limit||10,20);
  const results=await Promise.allSettled(universe.slice(0,20).map(async sym=>{
    try{
      const d=await fetchStockData(sym.toUpperCase());
      const tech=calcTechnicals(d.closes,d.highs,d.lows);
      const bandar=calcBandarAnalysis(d.closes,d.highs,d.lows,d.volumes);
      const scalp=calcScalpingScore(d.closes,d.highs,d.lows,d.volumes,tech,bandar);
      if(!scalp) return null;
      return{symbol:sym,companyName:d.companyName,price:d.price,changePct:d.changePct,scalpScore:scalp.score,targetPct:scalp.targetPct,slPct:scalp.slPct,isCandidate:scalp.isScalpCandidate,factors:scalp.factors,bandarPhase:bandar?.bandarPhase||'–',smScore:bandar?.smScore??50,rsi:tech.rsi,macdSig:tech.macdSig,volRatio:bandar?.volRatio??1};
    }catch(e){return null;}
  }));
  const candidates=results.filter(r=>r.status==='fulfilled'&&r.value?.isCandidate).map(r=>r.value).sort((a,b)=>b.scalpScore-a.scalpScore).slice(0,limit);
  res.json({candidates,total:candidates.length,generatedAt:new Date().toISOString()});
});

// ─── API: /api/sector-rotation ───────────────────
const SECTOR_UNIVERSE = {
  'Financial Services': ['BBCA','BBRI','BMRI','BRIS','BJBR','NISP','MEGA','ARTO'],
  'Energy':             ['ITMG','ADRO','PTBA','PGAS','ELSA','AKRA','MEDC'],
  'Consumer Defensive': ['UNVR','ICBP','INDF','MYOR','SIDO','ULTJ','CLEO'],
  'Consumer Cyclical':  ['ASII','AALI','GGRM','HMSP','AMRT','MAPI','ACES'],
  'Technology':         ['GOTO','BUKA','EMTK','MTDL','DMMX','MCAS'],
  'Healthcare':         ['KLBF','KAEF','SIDO','MIKA','HEAL','PRIM'],
  'Communication':      ['TLKM','EXCL','ISAT','LINK','FREN'],
  'Basic Materials':    ['INCO','ANTM','INKP','TKIM','SMGR','INTP','TBIG'],
  'Industrials':        ['WIKA','WSKT','JSMR','ADHI','PTPP','BIRD'],
};

app.get('/api/sector-rotation', async (req, res) => {
  try {
    const sectorResults = [];
    for (const [sector, syms] of Object.entries(SECTOR_UNIVERSE)) {
      const sample = syms.slice(0, 4); // Analyze top 4 per sector for speed
      const stockResults = await Promise.allSettled(sample.map(async sym => {
        try {
          const d = await fetchStockData(sym);
          const tech = calcTechnicals(d.closes, d.highs, d.lows);
          const bandar = calcBandarAnalysis(d.closes, d.highs, d.lows, d.volumes);
          const vol = calcCompositeVolume(d.closes, d.highs, d.lows, d.volumes);
          return {
            symbol: sym,
            companyName: d.companyName,
            price: d.price,
            changePct: d.changePct,
            smScore: bandar?.smScore ?? 50,
            bandarPhase: bandar?.bandarPhase ?? '–',
            cmf: bandar?.cmf ?? 0,
            obvTrend: bandar?.obvTrend ?? '–',
            volRatio: bandar?.volRatio ?? 1,
            rsi: tech?.rsi ?? 50,
            macdSig: tech?.macdSig ?? '–',
          };
        } catch { return null; }
      }));
      const stocks = stockResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
      if (stocks.length === 0) continue;

      const avgSmScore = Math.round(stocks.reduce((a, b) => a + b.smScore, 0) / stocks.length);
      const avgChangePct = +(stocks.reduce((a, b) => a + b.changePct, 0) / stocks.length).toFixed(2);
      const avgCmf = +(stocks.reduce((a, b) => a + b.cmf, 0) / stocks.length).toFixed(4);
      const accumulatingCount = stocks.filter(s => s.smScore >= 60).length;
      const distributingCount = stocks.filter(s => s.smScore <= 40).length;

      let sectorPhase, phaseColor;
      if (avgSmScore >= 65) { sectorPhase = 'AKUMULASI KUAT'; phaseColor = 'green'; }
      else if (avgSmScore >= 55) { sectorPhase = 'AKUMULASI'; phaseColor = 'green'; }
      else if (avgSmScore >= 45) { sectorPhase = 'NETRAL'; phaseColor = 'yellow'; }
      else if (avgSmScore >= 35) { sectorPhase = 'DISTRIBUSI'; phaseColor = 'red'; }
      else { sectorPhase = 'DISTRIBUSI KUAT'; phaseColor = 'red'; }

      sectorResults.push({
        sector,
        sectorPhase,
        phaseColor,
        avgSmScore,
        avgChangePct,
        avgCmf,
        accumulatingCount,
        distributingCount,
        totalAnalyzed: stocks.length,
        stocks: stocks.sort((a, b) => b.smScore - a.smScore),
      });
    }
    sectorResults.sort((a, b) => b.avgSmScore - a.avgSmScore);
    res.json({ sectors: sectorResults, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: /api/backtest (Strict 7-Gate Pro Filter) ──────────────
app.post('/api/backtest', async (req, res) => {
  try {
    const raw = (req.body.symbol ?? '').toString().toUpperCase().replace(/\.JK$/i,'').trim();
    if (!raw) return res.status(400).json({ error: 'Symbol tidak boleh kosong.' });

    const d = await fetchStockData(raw);
    const { closes, highs, lows, volumes, dates } = d;
    const n = closes.length;
    if (n < 80) return res.status(400).json({ error: 'Data historis tidak cukup (min 80 hari).' });

    const trades = [];
    const MIN_GAP_BARS = 5;
    let lastSignalBar = -MIN_GAP_BARS;

    for (let i = 60; i < n - 10; i++) {
      if (i - lastSignalBar < MIN_GAP_BARS) continue;

      const wC = closes.slice(0, i + 1);
      const wH = highs.slice(0, i + 1);
      const wL = lows.slice(0, i + 1);
      const wV = volumes.slice(0, i + 1);

      const tech   = calcTechnicals(wC, wH, wL);
      const bandar = calcBandarAnalysis(wC, wH, wL, wV);
      const vol    = calcCompositeVolume(wC, wH, wL, wV);
      const sr     = calcSupportResistance(wC, wH, wL, wV);
      const brk    = detectBreakoutRetest(wC, wH, wL, wV, sr);
      const div    = detectRSIDivergence(wC, wH, wL);

      // Gate 1: RSI ideal zone
      const rsi = tech.rsi;
      if (!rsi || rsi < 35 || rsi > 68) continue;

      // Gate 2: MACD must be bullish
      if (!tech.macd || tech.macd.MACD <= tech.macd.signal) continue;

      // Gate 3: Volume gate
      if (!vol || vol.volRatio < 1.3) continue;

      // Gate 4: Smart money not distributing
      const smScore = bandar?.smScore ?? 50;
      if (smScore < 50) continue;

      // Gate 5: Price in uptrend context
      const price = wC[wC.length - 1];
      const inUptrend = (tech.ma20 && price >= tech.ma20 * 0.97) ||
                        (tech.ma20 && tech.ma50 && tech.ma20 > tech.ma50);
      if (!inUptrend) continue;

      // Gate 6: No bearish divergence
      if (div?.bearish) continue;

      // Gate 7: No breakdown
      if (brk?.type === 'BREAKDOWN_DOWN') continue;

      // Lightweight MTF proxy via MA slopes
      const closes30 = wC.slice(-30);
      const ma5  = closes30.slice(-5).reduce((a,b)=>a+b,0)/5;
      const ma10 = closes30.slice(-10).reduce((a,b)=>a+b,0)/10;
      const ma20v = closes30.reduce((a,b)=>a+b,0)/closes30.length;
      let mtfScore = 0;
      if (price > ma5)  mtfScore++;
      if (price > ma10) mtfScore++;
      if (price > ma20v) mtfScore++;
      if (ma5 > ma10)   mtfScore++;
      if (ma10 > ma20v) mtfScore++;
      if (tech.macd?.histogram > 0) mtfScore++;
      const mtfBull = mtfScore >= 3;
      const volPass = vol.volumeGate;

      // Quality score
      let qScore = 25; // MACD pass
      if (mtfBull) qScore += mtfScore >= 5 ? 30 : 18;
      if (volPass) qScore += vol.volRatio >= 2.0 ? 25 : 15;
      if (div?.bullish)              qScore += 15;
      if (div?.type === 'HIDDEN_BULLISH') qScore += 8;
      if (brk?.type === 'BREAKOUT_UP')    qScore += 15;
      if (brk?.retest)                     qScore += 20;
      if (smScore >= 70) qScore += 10;
      else if (smScore >= 60) qScore += 5;
      qScore = Math.min(100, qScore);

      const pillarsPass = [true, mtfBull, volPass].filter(Boolean).length;
      if (pillarsPass < 2 || qScore < 48) continue;

      const isTriple = pillarsPass === 3 && qScore >= 65;
      const signal   = isTriple ? 'TRIPLE ✅' : 'DOUBLE ⚡';

      // Dynamic exit: SL -5% | TP +8% | 10 bars
      const entryPrice = closes[i];
      const slPrice    = entryPrice * 0.95;
      const tpPrice    = entryPrice * 1.08;
      let exitPrice    = closes[Math.min(i + 10, n - 1)];
      let exitBar      = Math.min(i + 10, n - 1);
      let exitReason   = '10H';

      for (let j = i + 1; j <= Math.min(i + 10, n - 1); j++) {
        if (lows[j] <= slPrice)  { exitPrice = slPrice; exitBar = j; exitReason = 'SL'; break; }
        if (highs[j] >= tpPrice) { exitPrice = tpPrice; exitBar = j; exitReason = 'TP'; break; }
      }

      const pnlPct = +((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);

      trades.push({
        date:       dates[i]      || `Bar ${i}`,
        exitDate:   dates[exitBar] || `Bar ${exitBar}`,
        entryPrice: Math.round(entryPrice),
        exitPrice:  Math.round(exitPrice),
        pnlPct,
        isWin: pnlPct > 0,
        pillars: pillarsPass,
        signal,
        exitReason,
        rsiVal:   +rsi.toFixed(1),
        macdSig:  'BULLISH',
        smScore,
        qScore,
        volRatio: +vol.volRatio.toFixed(1),
      });

      lastSignalBar = i;
    }

    const totalTrades = trades.length;
    const wins   = trades.filter(t => t.isWin).length;
    const losses = totalTrades - wins;
    const winRate   = totalTrades > 0 ? Math.round(wins / totalTrades * 100) : 0;
    const avgPnl    = totalTrades > 0 ? +(trades.reduce((a,b) => a + b.pnlPct, 0) / totalTrades).toFixed(2) : 0;
    const bestTrade  = trades.reduce((b,t) => t.pnlPct > (b?.pnlPct ?? -999) ? t : b, null);
    const worstTrade = trades.reduce((b,t) => t.pnlPct < (b?.pnlPct ?? 999) ? t : b, null);
    const tripleOnly = trades.filter(t => t.pillars === 3);
    const tripleWinRate = tripleOnly.length > 0
      ? Math.round(tripleOnly.filter(t => t.isWin).length / tripleOnly.length * 100) : 0;
    const tpHits   = trades.filter(t => t.exitReason === 'TP').length;
    const slHits   = trades.filter(t => t.exitReason === 'SL').length;
    const timeHits = trades.filter(t => t.exitReason === '10H').length;
    const avgQScore = totalTrades > 0
      ? Math.round(trades.reduce((a,t) => a + t.qScore, 0) / totalTrades) : 0;

    res.json({
      symbol: raw,
      companyName: d.companyName,
      totalBars: n,
      totalTrades,
      wins,
      losses,
      winRate,
      avgPnl,
      tripleWinRate,
      tripleCount: tripleOnly.length,
      bestTrade,
      worstTrade,
      trades: trades.slice(-30),
      exitBreakdown: { tpHits, slHits, timeHits },
      avgQScore,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_,res) => res.sendFile(path.join(__dirname,'../frontend/index.html')));

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║  StockDSS v8.0 — IDX Professional Signal     ║
  ║  http://localhost:${PORT}                        ║
  ║                                              ║
  ║  ✦ Layer 1: Multi-Timeframe Alignment        ║
  ║  ✦ Layer 2: Dynamic Support & Resistance     ║
  ║  ✦ Layer 3: Market Regime Detection          ║
  ║  ✦ Layer 4: Volume Confirmation Gate         ║
  ║  ✦ Layer 5: Signal Probability Engine        ║
  ║  ✦ Layer 6: Composite Signal Engine          ║
  ╚══════════════════════════════════════════════╝
  `);
});
