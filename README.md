# StockDSS v7.0 — IDX Professional Signal Engine

Upgrade dari v6 dengan **6-Layer Signal System** yang matang dan profesional.

## 🆕 Fitur Baru v7

### Layer 1 — Multi-Timeframe Alignment
- Fetch Yahoo Finance Daily / Weekly / Monthly secara paralel
- Hitung RSI zone, MACD state, MA Trend untuk ketiga timeframe
- Score 0–6 → ≥4 = Bullish Aligned, ≤2 = Bearish Aligned
- Tampil sebagai matrix 3×4 di Signal Dashboard

### Layer 2 — Dynamic Support & Resistance
- Swing High/Low detection (min 3 candle konfirmasi)
- Volume Profile: cluster harga dengan volume tertinggi = S/R kuat
- Fibonacci auto-retracement dari major swing high → swing low
- SL = di bawah support terkuat, TP1/TP2/TP3 dengan R/R per target

### Layer 3 — Market Regime Detection
- Fetch `^JKSE` paralel dengan saham
- BULL: IHSG > MA200 + ADX > 25
- BEAR: IHSG < MA200 + ADX > 25  
- SIDEWAYS: ADX < 20
- Tampil sebagai regime badge + dampak strategi

### Layer 4 — Volume Confirmation Gate
- Volume Gate: sinyal valid hanya jika volume ≥ 1.2× avg 20H
- Climax Volume Detection (>3× avg = warning reversal)
- Money Flow Index (MFI)
- Institutional Footprint: body >70% + volume tinggi + close near high
- Composite Volume Score 0–100 (gabungan MFI + CMF + OBV + ratio)

### Layer 5 — Signal Probability Engine
- Fingerprint kondisi: {rsiZone, macdState, volumeRatio, bandarPhase, regime, mtfAlignment}
- Cari titik historis 2 tahun dengan fingerprint serupa (toleransi ±10%)
- Hitung win rate: berapa % berhasil +3% dalam 5 hari
- Output: "Kondisi ini terjadi 23× dalam 2 tahun, 74% berhasil mencapai TP1"

### Layer 6 — Composite Signal Engine
```
Signal = MTF(0-25) + SR_Quality(0-20) + Regime(0-20) + Volume(0-20) + Probability(0-15)

≥ 80  → STRONG BUY
65–79 → BUY
40–64 → WAIT
< 40  → AVOID
```

## 🖥 Signal Dashboard UI
- Gauge besar 0–100 dengan warna gradasi
- Matrix MTF: 3 timeframe × 4 indikator
- Regime badge IHSG dengan dampak strategi
- Composite Volume Score dengan breakdown komponen
- S/R levels dengan kekuatan (strong/moderate/weak)
- Trading Plan: Entry Zone, SL, TP1/TP2/TP3 dengan R/R
- Reason list + Warning flags
- Probability display: win rate historis

## 🚀 Cara Menjalankan

### Windows
```
run.bat
```

### Mac/Linux
```bash
chmod +x run.sh
./run.sh
```

### Manual
```bash
cd backend
npm install
node server.js
```

Akses di: **http://localhost:3000**

## 📡 API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| POST | `/api/analyze` | Analisis lengkap 6-layer |
| POST | `/api/compare` | Bandingkan beberapa saham |
| POST | `/api/scalping` | Scan rekomendasi scalping harian |

### Response `/api/analyze` — Field Baru v7
```json
{
  "signalV7": {
    "signal": 78,
    "action": "buy",
    "actionLabel": "BUY",
    "reasons": [...],
    "warnings": [...],
    "entryZone": { "low": 9150, "high": 9250 },
    "sl": 8900, "tp1": 9600, "tp2": 10200, "tp3": 11000,
    "holdingDays": 8,
    "components": { "mtf": {...}, "sr": {...}, ... }
  },
  "multiTimeframe": { "daily": {...}, "weekly": {...}, "monthly": {...}, "totalScore": 4.5 },
  "supportResistance": { "levels": [...], "sl": 8900, "tp1": 9600, ... },
  "marketRegime": { "regime": "BULL", "ihsgVsMA200": 3.2, "adx": 28.4 },
  "volumeAnalysis": { "compositeScore": 72, "volumeGate": true, "mfi": 64.3 },
  "signalProbability": { "winRate": 74, "sampleCount": 23, "avgReturn5d": 3.8 }
}
```

## ⚠ Disclaimer
Bukan saran investasi resmi. Selalu lakukan riset mandiri sebelum berinvestasi.
