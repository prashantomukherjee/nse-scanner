"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

/* ── NSE F&O universe is fetched dynamically from /api/universe ── */
/* (which in turn fetches & parses Upstox's NSE instruments file)   */

const UPSTOX = "https://api.upstox.com";
const PROXY  = "/api/upstox?url=";  // server-side proxy in this same Next.js app
const proxied = (target) => PROXY + encodeURIComponent(target);

const C = {
  text:     "var(--color-text-primary)",
  muted:    "var(--color-text-secondary)",
  hint:     "var(--color-text-tertiary)",
  border:   "var(--color-border-tertiary)",
  surface:  "var(--color-background-secondary)",
  card:     "var(--color-background-primary)",
  gain:     "var(--color-text-success)",
  gainBg:   "var(--color-background-success)",
  loss:     "var(--color-text-danger)",
  lossBg:   "var(--color-background-danger)",
  infoBg:   "var(--color-background-info)",
  infoText: "var(--color-text-info)",
  warnBg:   "var(--color-background-warning)",
  warnText: "var(--color-text-warning)",
};

/* ── Helpers ── */
function fmtINR(v, dec = 2) {
  if (v == null || isNaN(v)) return "—";
  return v.toLocaleString("en-IN", { maximumFractionDigits: dec, minimumFractionDigits: dec });
}
function fmtK(v) {
  if (v == null || isNaN(v)) return "—";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(v);
}
function moneyness(strike, spot) {
  const pct = Math.abs((strike - spot) / spot) * 100;
  if (pct < 0.6) return "ATM";
  return strike < spot ? "ITM" : "OTM";
}

/* ── Open=low / Open=high signal detection ──
   Uses a 2% tolerance: an option "opened at its low" if open is within 2%
   of the low (scales correctly across cheap and expensive options).
   Dead strikes (high === low, i.e. no real trading) are excluded by the caller. */
const SIGNAL_TOLERANCE_PCT = 0.02; // 2%

// Is this a "live" strike (actually traded today)? high must differ from low.
function isLiveStrike(o) {
  return o && o.open != null && o.high != null && o.low != null
    && Math.abs(o.high - o.low) >= 0.01;
}
// open within 2% of the day's low
function isOpenAtLow(o) {
  if (o.low == null || o.open == null || o.low <= 0) return false;
  return Math.abs(o.open - o.low) <= o.low * SIGNAL_TOLERANCE_PCT;
}
// open within 2% of the day's high
function isOpenAtHigh(o) {
  if (o.high == null || o.open == null || o.high <= 0) return false;
  return Math.abs(o.open - o.high) <= o.high * SIGNAL_TOLERANCE_PCT;
}

/* ── Upstox API calls (all go through /api/upstox) ── */
async function callUpstox(path, token) {
  let res;
  try {
    res = await fetch(proxied(UPSTOX + path), {
      headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` },
    });
  } catch (e) {
    throw new Error(`Network error: ${e.message}`);
  }
  if (res.status === 401 && !res.headers.get("content-type")?.includes("upstox")) {
    // Could be either auth gate (session expired) or upstox token problem
    const text = await res.text();
    if (text.includes("unauthorized")) throw new Error("Session expired — please sign in again");
    throw new Error("Upstox token invalid or expired");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 250)}`);
  }
  const json = await res.json();
  if (json.status !== "success") {
    throw new Error(json.errors?.[0]?.message || "Upstox returned an error");
  }
  return json.data;
}

async function fetchOhlc(keys, token) {
  // /quotes returns net_change and previous-day ohlc.close — perfect for daily % change matching brokers
  const path = `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(","))}`;
  return await callUpstox(path, token);
}

async function fetchOptionOhlc(keys, token) {
  // /v3/ohlc with interval=1d returns live_ohlc (today's intraday) AND prev_ohlc — needed for option open=low/high highlights
  const path = `/v3/market-quote/ohlc?instrument_key=${encodeURIComponent(keys.join(","))}&interval=1d`;
  return await callUpstox(path, token);
}

/* ── Technical analysis helpers ── */

// Fetch 5-minute intraday candles for TODAY's session only
// Upstox returns array of [timestamp, open, high, low, close, volume, oi]
async function fetchIntradayCandles(instrumentKey, token, intervalMinutes = 5) {
  const path = `/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/${intervalMinutes}`;
  const data = await callUpstox(path, token);
  return data?.candles || [];
}

// Fetch HISTORICAL 5-minute candles for the past N trading days
// Used to seed rolling EMA so it's stable from market open onwards
async function fetchHistoricalCandles(instrumentKey, token, intervalMinutes = 5, daysBack = 3) {
  // Upstox historical-candle URL needs to/from dates in YYYY-MM-DD format
  const today = new Date();
  const toDate = new Date(today);
  toDate.setDate(toDate.getDate() - 1); // yesterday (no overlap with intraday)
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - daysBack);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const path = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/${intervalMinutes}/${fmt(toDate)}/${fmt(fromDate)}`;
  try {
    const data = await callUpstox(path, token);
    return data?.candles || [];
  } catch (e) {
    // If historical fetch fails (weekend, holiday, etc.), gracefully return empty
    return [];
  }
}

// Compute Exponential Moving Average from an array of closing prices
// Returns the last EMA value, or null if not enough data
function computeEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with simple average of first `period` values
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// Compute VWAP from candles
// VWAP = sum(typical_price × volume) / sum(volume)
// where typical_price = (high + low + close) / 3
function computeVWAP(candles) {
  if (!candles || candles.length === 0) return null;
  let sumPV = 0, sumV = 0;
  for (const c of candles) {
    // candle structure: [timestamp, open, high, low, close, volume, oi]
    const high = c[2], low = c[3], close = c[4], volume = c[5];
    if (high == null || low == null || close == null || !volume) continue;
    const typical = (high + low + close) / 3;
    sumPV += typical * volume;
    sumV += volume;
  }
  return sumV > 0 ? sumPV / sumV : null;
}

// Compute VWAP at a specific candle index (cumulative VWAP up to and including that candle)
function computeVWAPAtIndex(candles, idx) {
  if (idx < 0 || idx >= candles.length) return null;
  return computeVWAP(candles.slice(0, idx + 1));
}

// Detect VWAP cross between last two intraday candles
// Returns 'above' if previous was below VWAP and current is above (bullish cross)
//        'below' if previous was above VWAP and current is below (bearish cross)
//        null   otherwise
// Note: takes INTRADAY candles only (VWAP resets daily)
function detectVWAPCross(intradayCandles) {
  if (!intradayCandles || intradayCandles.length < 2) return null;
  const prev = intradayCandles[intradayCandles.length - 2];
  const curr = intradayCandles[intradayCandles.length - 1];
  const prevClose = prev[4], currClose = curr[4];
  if (prevClose == null || currClose == null) return null;

  const prevVWAP = computeVWAPAtIndex(intradayCandles, intradayCandles.length - 2);
  const currVWAP = computeVWAPAtIndex(intradayCandles, intradayCandles.length - 1);
  if (prevVWAP == null || currVWAP == null) return null;

  const prevAbove = prevClose > prevVWAP;
  const currAbove = currClose > currVWAP;

  if (!prevAbove && currAbove) return "above"; // bullish cross
  if (prevAbove && !currAbove) return "below"; // bearish cross
  return null;
}

// Run full technical analysis combining historical + today's candles
// - EMA: computed on historical + intraday combined (rolling, stable from market open)
// - VWAP: today's intraday candles only (resets daily)
// - Cross: detected on intraday candles only
function analyzeWithHistory(historicalCandles, intradayCandles) {
  if (!intradayCandles || intradayCandles.length === 0) return null;

  // Sort ascending (oldest first) — Upstox returns descending
  const sortAsc = (arr) => [...arr].sort((a, b) => new Date(a[0]) - new Date(b[0]));
  const sortedHist = sortAsc(historicalCandles || []);
  const sortedToday = sortAsc(intradayCandles);

  // Combine for EMA: historical first, then today's candles (chronological order)
  const allCandles = [...sortedHist, ...sortedToday];
  const allCloses = allCandles.map(c => c[4]).filter(v => v != null);
  if (allCloses.length < 2) return null;

  // Current price is the last close of today's candles
  const todayCloses = sortedToday.map(c => c[4]).filter(v => v != null);
  const currentClose = todayCloses[todayCloses.length - 1];

  return {
    close: currentClose,
    ema20:  computeEMA(allCloses, 20),  // rolling EMA across historical + today
    ema50:  computeEMA(allCloses, 50),  // rolling EMA across historical + today
    vwap:   computeVWAP(sortedToday),   // intraday VWAP only
    cross:  detectVWAPCross(sortedToday), // cross on intraday candles only
    candleCount: sortedToday.length,
    historicalCount: sortedHist.length,
  };
}

/* ── Expiry helpers ── */
/* NSE stock options expire on the LAST TUESDAY of each month */
function lastTuesdayOfMonth(year, month) {
  // month is 0-indexed
  const lastDay = new Date(year, month + 1, 0);
  const offset = (lastDay.getDay() - 2 + 7) % 7;
  return new Date(year, month, lastDay.getDate() - offset);
}

function fmtIso(d) {
  return d.toISOString().slice(0, 10);
}

/* Returns [{label: "Apr 2026", iso: "2026-04-29"}, {label: "May 2026", iso: "2026-05-27"}] */
function getMonthlyExpiries() {
  const now = new Date();
  const today = fmtIso(now);
  const list = [];
  for (let i = 0; i < 6; i++) {
    const d = lastTuesdayOfMonth(now.getFullYear(), now.getMonth() + i);
    const iso = fmtIso(d);
    if (iso < today) continue;          // skip if this month's expiry already passed
    list.push({
      iso,
      label: d.toLocaleDateString("en-IN", { month: "short", year: "numeric" }),
    });
    if (list.length === 2) break;       // current + next only
  }
  return list;
}

/* Picks an expiry from the contract list that matches the requested ISO month */
async function fetchExpiryForMonth(underlyingKey, requestedIso, token) {
  const path = `/v2/option/contract?instrument_key=${encodeURIComponent(underlyingKey)}`;
  const data = await callUpstox(path, token);
  const reqMonth = requestedIso.slice(0, 7); // YYYY-MM
  const matches = [...new Set(data.map(c => c.expiry))]
    .filter(e => e.startsWith(reqMonth))
    .sort();
  // Use the latest expiry within that month (handles weekly vs monthly contract listings)
  return matches[matches.length - 1] || null;
}

async function fetchChain(underlyingKey, expiryDate, token) {
  const path = `/v2/option/chain?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${expiryDate}`;
  return await callUpstox(path, token);
}

/* For ranking: count open=low and open=high signals around the anchor strike. */
async function countSignalsForStock(stock, expiryIso, token) {
  // 1. Find this stock's expiry on Upstox
  const expiry = await fetchExpiryForMonth(stock.key, expiryIso, token);
  if (!expiry) throw new Error(`No expiry found`);

  // 2. Get the full options chain
  const allChain = await fetchChain(stock.key, expiry, token);

  // 3. Anchor strike = nearest to today's open price
  const anchorPrice = stock.open ?? stock.high ?? stock.low ?? stock.ltp;
  const allStrikes = [...new Set(allChain.map(r => r.strike_price))].sort((a, b) => a - b);
  if (allStrikes.length === 0) return { ceOpenEqLow: 0, ceOpenEqHigh: 0, peOpenEqLow: 0, peOpenEqHigh: 0 };
  const anchor = allStrikes.reduce((best, s) =>
    Math.abs(s - anchorPrice) < Math.abs(best - anchorPrice) ? s : best, allStrikes[0]);
  const anchorIdx = allStrikes.indexOf(anchor);

  // 4. Pick 10 ITM + anchor + 10 OTM
  const wanted = new Set();
  for (let off = -10; off <= 10; off++) {
    const s = allStrikes[anchorIdx + off];
    if (s != null) wanted.add(s);
  }
  const selected = allChain.filter(r => wanted.has(r.strike_price));

  // 5. Collect all option instrument keys (CE + PE)
  const optKeys = [];
  selected.forEach(r => {
    if (r.call_options?.instrument_key) optKeys.push(r.call_options.instrument_key);
    if (r.put_options?.instrument_key)  optKeys.push(r.put_options.instrument_key);
  });
  if (optKeys.length === 0) return { ceOpenEqLow: 0, ceOpenEqHigh: 0, peOpenEqLow: 0, peOpenEqHigh: 0 };

  // 6. Fetch OHLC for all those options in one call
  const ohlcData = await fetchOptionOhlc(optKeys, token);
  const ohlcByKey = {};
  Object.values(ohlcData).forEach(item => { ohlcByKey[item.instrument_token] = item; });

  // 7. Count signals
  let ceOpenEqLow = 0, ceOpenEqHigh = 0, peOpenEqLow = 0, peOpenEqHigh = 0;

  const tally = (opt, type) => {
    if (!opt?.instrument_key) return;
    const live = ohlcByKey[opt.instrument_key]?.live_ohlc;
    if (!live || live.open == null || live.low == null || live.high == null) return;
    // Skip dead strikes — high === low means no real trading happened
    if (!isLiveStrike(live)) return;
    const openEqLow  = isOpenAtLow(live);
    const openEqHigh = isOpenAtHigh(live);
    if (type === "CE") {
      if (openEqLow)  ceOpenEqLow++;
      if (openEqHigh) ceOpenEqHigh++;
    } else {
      if (openEqLow)  peOpenEqLow++;
      if (openEqHigh) peOpenEqHigh++;
    }
  };

  for (const r of selected) {
    tally(r.call_options, "CE");
    tally(r.put_options,  "PE");
  }

  return { ceOpenEqLow, ceOpenEqHigh, peOpenEqLow, peOpenEqHigh };
}

/* ── Components ── */

function Skeleton({ rows = 5 }) {
  return (
    <div>
      <style>{`@keyframes skp{0%,100%{opacity:.2}50%{opacity:.5}}`}</style>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{
          height: "60px", background: C.surface, borderRadius: "var(--border-radius-lg)",
          marginBottom: "8px", animation: `skp 1.5s ${i*0.1}s ease-in-out infinite`,
        }}/>
      ))}
    </div>
  );
}

function TokenPanel({ token, setToken, onSave }) {
  const [val, setVal] = useState(token);
  return (
    <div style={{
      background: C.surface, border: `0.5px solid ${C.border}`,
      borderRadius: "var(--border-radius-lg)", padding: "16px", marginBottom: "1rem",
    }}>
      <div style={{ fontSize: "12px", fontWeight: 500, color: C.text, marginBottom: "6px" }}>
        Upstox access token
      </div>
      <div style={{ fontSize: "11px", color: C.muted, marginBottom: "10px", lineHeight: 1.5 }}>
        Paste your Upstox JWT from{" "}
        <span style={{ color: C.infoText }}>upstox.com → Developer → Apps</span>.
        The token stays in your browser memory and is sent server-side via this app's proxy — never to a third party.
      </div>
      <textarea
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder="eyJ0eXAiOiJKV1QiLCJh..."
        style={{
          width: "100%", minHeight: "60px", padding: "8px",
          fontFamily: "var(--font-mono)", fontSize: "11px",
          background: C.card, border: `0.5px solid ${C.border}`,
          borderRadius: "var(--border-radius-md)", color: C.text,
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px", gap: "6px" }}>
        {token && (
          <button onClick={() => { setToken(""); setVal(""); }} style={{
            fontSize: "12px", padding: "5px 12px", cursor: "pointer",
          }}>clear</button>
        )}
        <button onClick={() => { setToken(val.trim()); onSave(); }} disabled={!val.trim()} style={{
          fontSize: "12px", padding: "5px 12px",
          cursor: val.trim() ? "pointer" : "not-allowed", opacity: val.trim() ? 1 : 0.5,
        }}>save & continue</button>
      </div>
    </div>
  );
}

function StockCard({ stock, rank, isLoser, onClick }) {
  const accent   = isLoser ? C.loss : C.gain;
  const accentBg = isLoser ? C.lossBg : C.gainBg;
  const pct = stock.changePct ?? 0;
  return (
    <div onClick={onClick} style={{
      background: C.card, border: `0.5px solid ${C.border}`,
      borderRadius: "var(--border-radius-lg)", padding: "14px 16px",
      cursor: "pointer", display: "flex", alignItems: "center",
      justifyContent: "space-between", gap: "12px", transition: "border-color 0.15s",
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = "var(--color-border-primary)"}
    onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{
          width: "30px", height: "30px", borderRadius: "50%", background: accentBg,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "12px", fontWeight: 500, color: accent, flexShrink: 0,
        }}>{rank}</div>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 500, color: C.text }}>{stock.sym}</div>
          <div style={{ fontSize: "11px", color: C.muted, marginTop: "2px", fontFamily: "var(--font-mono)" }}>
            O: ₹{fmtINR(stock.open)}&nbsp;·&nbsp;H: ₹{fmtINR(stock.high)}&nbsp;·&nbsp;L: ₹{fmtINR(stock.low)}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
        <div style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
          <div style={{ fontSize: "14px", fontWeight: 500, color: C.text }}>₹{fmtINR(stock.ltp)}</div>
          <div style={{ fontSize: "11px", color: C.muted }}>
            {stock.change >= 0 ? "+" : ""}{fmtINR(stock.change)}
          </div>
        </div>
        <div style={{
          background: accentBg, color: accent, borderRadius: "var(--border-radius-md)",
          padding: "5px 11px", fontSize: "13px", fontWeight: 500, fontFamily: "var(--font-mono)",
        }}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</div>
        <span style={{ color: C.hint, fontSize: "18px", lineHeight: 1 }}>›</span>
      </div>
    </div>
  );
}

function OptionsChain({ rows }) {
  const strikes = [...new Set(rows.map(r => r.strike))].sort((a, b) => a - b);
  const cols = ["open", "high", "low", "ltp", "chg%", "oi", "vol"];

  function val(opt, f) {
    if (!opt) return "—";
    if (f === "chg%") return `${opt.changePct >= 0 ? "+" : ""}${opt.changePct?.toFixed(2)}%`;
    if (f === "oi")   return fmtK(opt.oi);
    if (f === "vol")  return fmtK(opt.volume);
    return fmtINR(opt[f]);
  }
  function highlight(opt) {
    if (!opt || opt.open == null) return null;
    // Skip dead strikes — if high and low are equal, the option didn't really trade
    if (!isLiveStrike(opt)) return null;
    if (isOpenAtLow(opt))  return "low";
    if (isOpenAtHigh(opt)) return "high";
    return null;
  }
  function bg(opt, f) {
    if (!opt || f !== "open") return "transparent";
    const hl = highlight(opt);
    return hl === "low" ? C.gainBg : hl === "high" ? C.lossBg : "transparent";
  }
  function color(opt, f) {
    if (!opt) return C.hint;
    if (f === "chg%") return opt.changePct >= 0 ? C.gain : C.loss;
    if (f === "ltp")  return C.text;
    if (f === "open") {
      const hl = highlight(opt);
      return hl === "low" ? C.gain : hl === "high" ? C.loss : C.muted;
    }
    return C.muted;
  }

  const thR = { textAlign:"right", padding:"5px 8px", fontSize:"10px", fontWeight:400, color:C.hint, borderBottom:`0.5px solid ${C.border}`, whiteSpace:"nowrap" };
  const thL = { ...thR, textAlign: "left" };

  return (
    <div style={{ overflowX: "auto", fontFamily: "var(--font-mono)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11.5px" }}>
        <thead>
          <tr>
            <th colSpan={7} style={{
              textAlign:"center", padding:"7px", background:C.gainBg, color:C.gain,
              fontSize:"10px", letterSpacing:"0.1em", fontWeight:500,
              borderBottom:`1px solid var(--color-border-secondary)`,
            }}>CALL (CE)</th>
            <th style={{
              textAlign:"center", padding:"7px 14px", color:C.hint,
              fontSize:"10px", letterSpacing:"0.08em", fontWeight:400,
              borderBottom:`0.5px solid ${C.border}`,
            }}>STRIKE</th>
            <th colSpan={7} style={{
              textAlign:"center", padding:"7px", background:C.lossBg, color:C.loss,
              fontSize:"10px", letterSpacing:"0.1em", fontWeight:500,
              borderBottom:`1px solid var(--color-border-secondary)`,
            }}>PUT (PE)</th>
          </tr>
          <tr>
            {cols.map(h => <th key={`ch-${h}`} style={thR}>{h}</th>)}
            <th style={{ borderBottom: `0.5px solid ${C.border}`, padding: "5px 14px" }} />
            {cols.map(h => <th key={`ph-${h}`} style={thL}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {strikes.map(strike => {
            const ce = rows.find(r => r.strike === strike && r.type === "CE");
            const pe = rows.find(r => r.strike === strike && r.type === "PE");
            const isATM = (ce?.moneyness || pe?.moneyness) === "ATM";
            const rowBase = isATM ? C.infoBg : "transparent";
            const td = (align, opt, f) => ({
              padding: "8px", textAlign: align, whiteSpace: "nowrap",
              background: bg(opt,f) !== "transparent" ? bg(opt,f) : rowBase,
              color: color(opt, f),
              fontWeight: (f === "ltp" || (f === "open" && highlight(opt))) ? 500 : 400,
              borderBottom: `0.5px solid ${C.border}`,
            });
            return (
              <tr key={strike}>
                {cols.map(f => <td key={`ce-${f}`} style={td("right", ce, f)}>{val(ce, f)}</td>)}
                <td style={{
                  padding:"8px 14px", textAlign:"center", whiteSpace:"nowrap",
                  fontWeight:500, background: rowBase,
                  color: isATM ? C.infoText : C.muted,
                  borderBottom: `0.5px solid ${C.border}`,
                }}>
                  {fmtINR(strike, 0)}
                  {isATM && <div style={{ fontSize: "9px", opacity: 0.75, letterSpacing: "0.08em" }}>ATM</div>}
                </td>
                {cols.map(f => <td key={`pe-${f}`} style={td("left", pe, f)}>{val(pe, f)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailPage({ stock, isLoser, token, selectedExpiry, onBack }) {
  const [chain,    setChain]    = useState(null);
  const [expiry,   setExpiry]   = useState(null);
  const [atmStrike,setAtmStrike]= useState(null);
  const [loading,  setLoading]  = useState(true);
  const [err,      setErr]      = useState(null);

  const accent = isLoser ? C.loss : C.gain;
  const pct = stock.changePct ?? 0;

  const loadChain = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const exp = await fetchExpiryForMonth(stock.key, selectedExpiry.iso, token);
      if (!exp) throw new Error(`No ${selectedExpiry.label} expiry found for this stock`);
      setExpiry(exp);

      const allChain = await fetchChain(stock.key, exp, token);

      // Anchor strike = strike nearest to today's open (not LTP)
      // Falls back to high, low, or LTP if open is unavailable
      const anchorPrice = stock.open ?? stock.high ?? stock.low ?? stock.ltp;
      const allStrikes = [...new Set(allChain.map(r => r.strike_price))].sort((a, b) => a - b);
      const anchor = allStrikes.reduce((best, s) =>
        Math.abs(s - anchorPrice) < Math.abs(best - anchorPrice) ? s : best, allStrikes[0] ?? anchorPrice);
      setAtmStrike(anchor);

      // From CE perspective: 3 ITM (below anchor) + anchor + 5 OTM (above anchor) = 9 strikes
      const anchorIdx = allStrikes.indexOf(anchor);
      // 10 ITM (below anchor) + anchor + 10 OTM (above anchor) = 21 strikes total
      const wanted = new Set();
      for (let off = -10; off <= 10; off++) {
        const s = allStrikes[anchorIdx + off];
        if (s != null) wanted.add(s);
      }

      const selected = allChain.filter(r => wanted.has(r.strike_price));

      // For ATM/ITM/OTM labeling (CE perspective): below anchor = ITM, anchor = ATM, above = OTM
      const spot = anchorPrice;

      const optKeys = [];
      selected.forEach(r => {
        if (r.call_options?.instrument_key) optKeys.push(r.call_options.instrument_key);
        if (r.put_options?.instrument_key)  optKeys.push(r.put_options.instrument_key);
      });

      const ohlcData = await fetchOptionOhlc(optKeys, token);
      const ohlcByKey = {};
      Object.values(ohlcData).forEach(item => { ohlcByKey[item.instrument_token] = item; });

      const built = [];
      for (const r of selected) {
        const buildRow = (opt, type) => {
          if (!opt) return;
          const ohlc = ohlcByKey[opt.instrument_key];
          const live = ohlc?.live_ohlc || {};
          const prev = ohlc?.prev_ohlc || {};
          const ltp  = ohlc?.last_price ?? opt.market_data?.ltp;
          const close = prev.close ?? opt.market_data?.close_price;
          const changePct = (close && ltp != null && close !== 0) ? ((ltp - close) / close) * 100 : 0;
          built.push({
            strike: r.strike_price, type,
            moneyness: moneyness(r.strike_price, spot),
            open: live.open ?? null, high: live.high ?? null, low: live.low ?? null,
            ltp, changePct,
            oi: opt.market_data?.oi,
            volume: live.volume ?? opt.market_data?.volume,
          });
        };
        buildRow(r.call_options, "CE");
        buildRow(r.put_options,  "PE");
      }
      setChain(built.sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type)));
    } catch (e) {
      setErr(e.message || "Failed to load chain");
    } finally {
      setLoading(false);
    }
  }, [stock, token, selectedExpiry]);

  useEffect(() => { loadChain(); }, [loadChain]);

  // Skip dead strikes — options where high === low never really traded
  const lowCnt  = chain?.filter(r => isLiveStrike(r) && isOpenAtLow(r)).length ?? 0;
  const highCnt = chain?.filter(r => isLiveStrike(r) && isOpenAtHigh(r)).length ?? 0;
  const strikesCnt = chain ? [...new Set(chain.map(r => r.strike))].length : 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "1.25rem" }}>
        <button onClick={onBack} style={{ fontSize: "12px", padding: "5px 12px", cursor: "pointer" }}>
          ← back
        </button>
        <div>
          <div style={{ fontSize: "17px", fontWeight: 500, color: C.text }}>{stock.sym}</div>
          <div style={{ fontSize: "11px", color: C.muted, fontFamily: "var(--font-mono)" }}>
            ₹{fmtINR(stock.ltp)}&nbsp;·&nbsp;
            <span style={{ color: accent }}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</span>
            &nbsp;·&nbsp;{expiry || "loading expiry..."}
          </div>
        </div>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
        gap: "8px", marginBottom: "1rem",
      }}>
        {[
          { label: "anchor strike",   val: atmStrike ? `₹${fmtINR(atmStrike, 0)}` : "—", color: C.infoText },
          { label: "stock day open",  val: `₹${fmtINR(stock.open)}`,  color: C.muted },
          { label: "stock day high",  val: `₹${fmtINR(stock.high)}`,  color: C.gain },
          { label: "stock day low",   val: `₹${fmtINR(stock.low)}`,   color: C.loss },
          { label: "open = day low",  val: loading ? "…" : `${lowCnt} options`,  color: C.gain },
          { label: "open = day high", val: loading ? "…" : `${highCnt} options`, color: C.loss },
        ].map(m => (
          <div key={m.label} style={{ background: C.surface, borderRadius: "var(--border-radius-md)", padding: "10px 12px" }}>
            <div style={{ fontSize: "10px", color: C.hint, marginBottom: "3px", fontFamily: "var(--font-mono)" }}>{m.label}</div>
            <div style={{ fontSize: "14px", fontWeight: 500, color: m.color, fontFamily: "var(--font-mono)" }}>{m.val}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "16px", marginBottom: "10px", flexWrap: "wrap", fontFamily: "var(--font-mono)" }}>
        {[
          { bg: C.gainBg, color: C.gain,     label: "open = day's low" },
          { bg: C.lossBg, color: C.loss,     label: "open = day's high" },
          { bg: C.infoBg, color: C.infoText, label: "ATM row" },
        ].map(l => (
          <div key={l.label} style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "11px" }}>
            <span style={{ width: "10px", height: "10px", borderRadius: "2px", background: l.bg, display: "inline-block", flexShrink: 0 }} />
            <span style={{ color: l.color }}>{l.label}</span>
          </div>
        ))}
      </div>

      {err && (
        <div style={{
          padding: "10px 14px", background: C.lossBg, color: C.loss,
          borderRadius: "var(--border-radius-md)", fontSize: "12px", marginBottom: "1rem", fontFamily: "var(--font-mono)",
        }}>
          Error: {err}
        </div>
      )}

      {loading && <Skeleton rows={5} />}

      {chain && !loading && (
        <div style={{ border: `0.5px solid ${C.border}`, borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
          <OptionsChain rows={chain} />
        </div>
      )}
    </div>
  );
}

/* Card showing a stock + its signal score in the ranked view */
function RankedCard({ entry, rank, isLoser, onClick }) {
  const accent   = isLoser ? C.loss : C.gain;
  const accentBg = isLoser ? C.lossBg : C.gainBg;
  const stock = entry.stock;
  const signals = entry.signals || {};
  const pct = stock.changePct ?? 0;

  // For gainers (bullish), highlight the bullish signals; for losers, highlight bearish
  const primaryLabel = isLoser ? "PE open=low" : "CE open=low";
  const primaryCount = isLoser ? signals.peOpenEqLow ?? 0 : signals.ceOpenEqLow ?? 0;
  const secondaryLabel = isLoser ? "CE open=high" : "PE open=high";
  const secondaryCount = isLoser ? signals.ceOpenEqHigh ?? 0 : signals.peOpenEqHigh ?? 0;

  return (
    <div onClick={onClick} style={{
      background: C.card, border: `0.5px solid ${C.border}`,
      borderRadius: "var(--border-radius-lg)", padding: "14px 16px",
      cursor: "pointer", display: "flex", alignItems: "center",
      justifyContent: "space-between", gap: "12px", transition: "border-color 0.15s",
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = "var(--color-border-primary)"}
    onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{
          width: "30px", height: "30px", borderRadius: "50%", background: C.infoBg,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "12px", fontWeight: 500, color: C.infoText, flexShrink: 0,
        }}>{rank}</div>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 500, color: C.text }}>{stock.sym}</div>
          <div style={{ fontSize: "11px", color: C.muted, marginTop: "2px", fontFamily: "var(--font-mono)" }}>
            ₹{fmtINR(stock.ltp)}&nbsp;·&nbsp;
            <span style={{ color: accent }}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</span>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", fontFamily: "var(--font-mono)" }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "10px", color: C.muted }}>{primaryLabel}</div>
          <div style={{ fontSize: "13px", fontWeight: 500, color: C.gain }}>{primaryCount}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "10px", color: C.muted }}>{secondaryLabel}</div>
          <div style={{ fontSize: "13px", fontWeight: 500, color: C.loss }}>{secondaryCount}</div>
        </div>
        <div style={{
          background: C.infoBg, color: C.infoText, borderRadius: "var(--border-radius-md)",
          padding: "5px 11px", fontSize: "13px", fontWeight: 500, minWidth: "36px", textAlign: "center",
        }}>{entry.score}</div>
        <span style={{ color: C.hint, fontSize: "18px", lineHeight: 1 }}>›</span>
      </div>
    </div>
  );
}

/* The ranked tab content — sub-tabs (gainers/losers) + progress + list */
function RankedView({ rankedGainers, rankedLosers, scanning, progress, err, onRetry, rankedTab, setRankedTab, onSelect }) {
  const list = rankedTab === "gainers" ? rankedGainers : rankedLosers;
  const isLoser = rankedTab === "losers";

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px", fontFamily: "var(--font-mono)" }}>
        {[
          { id: "gainers", label: "▲ ranked gainers", count: rankedGainers?.length },
          { id: "losers",  label: "▼ ranked losers",  count: rankedLosers?.length },
        ].map(t => (
          <button key={t.id} onClick={() => setRankedTab(t.id)} style={{
            background: rankedTab === t.id ? C.infoBg : "transparent",
            color: rankedTab === t.id ? C.infoText : C.muted,
            border: `0.5px solid ${rankedTab === t.id ? C.infoText : C.border}`,
            borderRadius: "var(--border-radius-md)",
            padding: "5px 12px", fontSize: "12px",
            fontWeight: rankedTab === t.id ? 500 : 400,
            cursor: "pointer", display: "flex", alignItems: "center", gap: "6px",
          }}>
            {t.label}
            {t.count != null && <span style={{ fontSize: "10px", opacity: 0.7 }}>({t.count})</span>}
          </button>
        ))}
      </div>

      {/* Description */}
      <div style={{
        fontSize: "11px", color: C.muted, fontFamily: "var(--font-mono)",
        padding: "8px 12px", background: C.surface, borderRadius: "var(--border-radius-md)",
        marginBottom: "10px", lineHeight: 1.5,
      }}>
        {isLoser
          ? "Ranking by bearish flow strength: count of strikes (10 ITM + anchor + 10 OTM) where PE open=low + CE open=high."
          : "Ranking by bullish flow strength: count of strikes (10 ITM + anchor + 10 OTM) where CE open=low + PE open=high."}
      </div>

      {/* Error */}
      {err && (
        <div style={{
          padding: "10px 14px", background: C.lossBg, color: C.loss,
          borderRadius: "var(--border-radius-md)", fontSize: "12px", marginBottom: "1rem",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontFamily: "var(--font-mono)",
        }}>
          <span>Error: {err}</span>
          <button onClick={onRetry} style={{ fontSize: "11px", padding: "4px 10px", cursor: "pointer" }}>retry</button>
        </div>
      )}

      {/* Progress */}
      {scanning && (
        <div style={{ fontFamily: "var(--font-mono)" }}>
          <div style={{
            fontSize: "11px", color: C.muted, marginBottom: "8px",
            display: "flex", justifyContent: "space-between",
          }}>
            <span>scanning option chains for signals...</span>
            <span>{progress.done} / {progress.total}</span>
          </div>
          <div style={{
            height: "4px", background: C.surface,
            borderRadius: "var(--border-radius-md)", overflow: "hidden", marginBottom: "12px",
          }}>
            <div style={{
              width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
              height: "100%", background: C.infoText, transition: "width 0.3s",
            }} />
          </div>
          <Skeleton rows={5} />
        </div>
      )}

      {/* List */}
      {list && !scanning && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {list.map((entry, i) => (
            <RankedCard key={entry.stock.key} entry={entry} rank={i + 1}
              isLoser={isLoser}
              onClick={() => onSelect(entry.stock, isLoser ? "losers" : "gainers")} />
          ))}
        </div>
      )}
    </div>
  );
}

/* Card showing a stock + its equity/future OHLC for the conviction view */
function ConvictionCard({ entry, rank, isLoser, onClick }) {
  const accent   = isLoser ? C.loss : C.gain;
  const accentBg = isLoser ? C.lossBg : C.gainBg;
  const stock = entry.stock;
  const fut = entry.futOhlc;
  const pct = stock.changePct ?? 0;

  return (
    <div onClick={onClick} style={{
      background: C.card, border: `0.5px solid ${C.border}`,
      borderRadius: "var(--border-radius-lg)", padding: "14px 16px",
      cursor: "pointer", transition: "border-color 0.15s",
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = "var(--color-border-primary)"}
    onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: "30px", height: "30px", borderRadius: "50%", background: C.warnBg,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "12px", fontWeight: 500, color: C.warnText, flexShrink: 0,
          }}>{rank}</div>
          <div style={{ fontSize: "14px", fontWeight: 500, color: C.text }}>{stock.sym}</div>
        </div>
        <div style={{
          background: accentBg, color: accent, borderRadius: "var(--border-radius-md)",
          padding: "5px 11px", fontSize: "13px", fontWeight: 500, fontFamily: "var(--font-mono)",
        }}>
          {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
        </div>
      </div>

      {/* Equity + Future OHLC side by side */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px",
        fontSize: "11px", fontFamily: "var(--font-mono)",
      }}>
        <div style={{
          background: C.surface, borderRadius: "var(--border-radius-md)", padding: "8px 10px",
        }}>
          <div style={{ fontSize: "10px", color: C.hint, marginBottom: "3px", letterSpacing: "0.06em" }}>EQUITY</div>
          <div style={{ color: C.muted }}>
            O: <span style={{ color: accent, fontWeight: 500 }}>₹{fmtINR(stock.open)}</span>
            &nbsp;·&nbsp;H: ₹{fmtINR(stock.high)}
            &nbsp;·&nbsp;L: ₹{fmtINR(stock.low)}
          </div>
        </div>
        <div style={{
          background: C.surface, borderRadius: "var(--border-radius-md)", padding: "8px 10px",
        }}>
          <div style={{ fontSize: "10px", color: C.hint, marginBottom: "3px", letterSpacing: "0.06em" }}>FUTURE</div>
          <div style={{ color: C.muted }}>
            O: <span style={{ color: accent, fontWeight: 500 }}>₹{fmtINR(fut.open)}</span>
            &nbsp;·&nbsp;H: ₹{fmtINR(fut.high)}
            &nbsp;·&nbsp;L: ₹{fmtINR(fut.low)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* The conviction tab content — equity AND future both open=low/high */
function ConvictionView({ convictionGainers, convictionLosers, scanning, progress, err, onRetry, convictionTab, setConvictionTab, onSelect }) {
  const list = convictionTab === "gainers" ? convictionGainers : convictionLosers;
  const isLoser = convictionTab === "losers";

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px", fontFamily: "var(--font-mono)" }}>
        {[
          { id: "gainers", label: "▲ bullish (open=low)",  count: convictionGainers?.length },
          { id: "losers",  label: "▼ bearish (open=high)", count: convictionLosers?.length },
        ].map(t => (
          <button key={t.id} onClick={() => setConvictionTab(t.id)} style={{
            background: convictionTab === t.id ? C.warnBg : "transparent",
            color: convictionTab === t.id ? C.warnText : C.muted,
            border: `0.5px solid ${convictionTab === t.id ? C.warnText : C.border}`,
            borderRadius: "var(--border-radius-md)",
            padding: "5px 12px", fontSize: "12px",
            fontWeight: convictionTab === t.id ? 500 : 400,
            cursor: "pointer", display: "flex", alignItems: "center", gap: "6px",
          }}>
            {t.label}
            {t.count != null && <span style={{ fontSize: "10px", opacity: 0.7 }}>({t.count})</span>}
          </button>
        ))}
      </div>

      {/* Description */}
      <div style={{
        fontSize: "11px", color: C.muted, fontFamily: "var(--font-mono)",
        padding: "8px 12px", background: C.surface, borderRadius: "var(--border-radius-md)",
        marginBottom: "10px", lineHeight: 1.5,
      }}>
        {isLoser
          ? `Top 20 losers where BOTH equity AND its front-month future have open = day's high (strong bearish conviction — sellers from the top in both segments).`
          : `Top 20 gainers where BOTH equity AND its front-month future have open = day's low (strong bullish conviction — buyers from the bottom in both segments).`}
      </div>

      {/* Error */}
      {err && (
        <div style={{
          padding: "10px 14px", background: C.lossBg, color: C.loss,
          borderRadius: "var(--border-radius-md)", fontSize: "12px", marginBottom: "1rem",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontFamily: "var(--font-mono)",
        }}>
          <span>Error: {err}</span>
          <button onClick={onRetry} style={{ fontSize: "11px", padding: "4px 10px", cursor: "pointer" }}>retry</button>
        </div>
      )}

      {/* Progress */}
      {scanning && (
        <div style={{ fontFamily: "var(--font-mono)" }}>
          <div style={{
            fontSize: "11px", color: C.muted, marginBottom: "8px",
            display: "flex", justifyContent: "space-between",
          }}>
            <span>fetching futures OHLC...</span>
            <span>{progress.done} / {progress.total}</span>
          </div>
          <div style={{
            height: "4px", background: C.surface,
            borderRadius: "var(--border-radius-md)", overflow: "hidden", marginBottom: "12px",
          }}>
            <div style={{
              width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
              height: "100%", background: C.warnText, transition: "width 0.3s",
            }} />
          </div>
        </div>
      )}

      {/* List */}
      {list && !scanning && list.length === 0 && (
        <div style={{
          padding: "2rem 0", textAlign: "center", color: C.hint,
          fontFamily: "var(--font-mono)", fontSize: "12px",
        }}>
          <div style={{ fontSize: "24px", marginBottom: "8px", opacity: 0.3 }}>—</div>
          No {isLoser ? "bearish" : "bullish"} conviction signals in the top 20.
          <div style={{ fontSize: "10px", marginTop: "4px" }}>
            (no stock has both equity AND future opening at the {isLoser ? "high" : "low"})
          </div>
        </div>
      )}

      {list && !scanning && list.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {list.map((entry, i) => (
            <ConvictionCard key={entry.stock.key} entry={entry} rank={i + 1}
              isLoser={isLoser}
              onClick={() => onSelect(entry.stock, isLoser ? "losers" : "gainers")} />
          ))}
        </div>
      )}
    </div>
  );
}

/* Card showing a stock with its technicals (EMA, VWAP, cross signal) */
function TechnicalsCard({ entry, rank, isLoser, onClick }) {
  const accent   = isLoser ? C.loss : C.gain;
  const accentBg = isLoser ? C.lossBg : C.gainBg;
  const stock = entry.stock;
  const tech = entry.tech;
  const pct = stock.changePct ?? 0;

  return (
    <div onClick={onClick} style={{
      background: C.card, border: `0.5px solid ${C.border}`,
      borderRadius: "var(--border-radius-lg)", padding: "14px 16px",
      cursor: "pointer", transition: "border-color 0.15s",
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = "var(--color-border-primary)"}
    onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: "30px", height: "30px", borderRadius: "50%", background: C.surface,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "12px", fontWeight: 500, color: C.text, flexShrink: 0,
          }}>{rank}</div>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 500, color: C.text }}>{stock.sym}</div>
            <div style={{ fontSize: "11px", color: C.muted, marginTop: "2px", fontFamily: "var(--font-mono)" }}>
              ₹{fmtINR(tech.close)}
            </div>
          </div>
        </div>
        <div style={{
          background: accentBg, color: accent, borderRadius: "var(--border-radius-md)",
          padding: "5px 11px", fontSize: "13px", fontWeight: 500, fontFamily: "var(--font-mono)",
        }}>
          {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
        </div>
      </div>

      {/* Technicals values */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "6px",
        fontSize: "11px", fontFamily: "var(--font-mono)",
      }}>
        {[
          { label: "20 EMA",  val: tech.ema20,  match: isLoser ? tech.close < tech.ema20 : tech.close > tech.ema20 },
          { label: "50 EMA", val: tech.ema50, match: tech.ema50 == null ? null : (isLoser ? tech.close < tech.ema50 : tech.close > tech.ema50) },
          { label: "VWAP",    val: tech.vwap,   match: isLoser ? tech.close < tech.vwap : tech.close > tech.vwap },
          { label: "cross",   val: tech.cross === "above" ? "↑ up" : tech.cross === "below" ? "↓ down" : "—", match: tech.cross === (isLoser ? "below" : "above") },
        ].map(item => (
          <div key={item.label} style={{
            background: item.match ? accentBg : C.surface,
            color: item.match ? accent : C.muted,
            borderRadius: "var(--border-radius-md)", padding: "6px 8px",
          }}>
            <div style={{ fontSize: "9px", opacity: 0.7, letterSpacing: "0.06em", marginBottom: "2px" }}>{item.label}</div>
            <div style={{ fontSize: "12px", fontWeight: 500 }}>
              {typeof item.val === "number" ? `₹${fmtINR(item.val)}` : (item.val ?? "—")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* The technicals tab content — sub-tabs (gainers/losers) + filtered list */
function TechnicalsView({ techGainers, techLosers, scanning, progress, err, onRetry, techTab, setTechTab, onSelect }) {
  const list = techTab === "gainers" ? techGainers : techLosers;
  const isLoser = techTab === "losers";

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px", fontFamily: "var(--font-mono)" }}>
        {[
          { id: "gainers", label: "▲ bullish technicals", count: techGainers?.length },
          { id: "losers",  label: "▼ bearish technicals", count: techLosers?.length },
        ].map(t => (
          <button key={t.id} onClick={() => setTechTab(t.id)} style={{
            background: techTab === t.id ? C.surface : "transparent",
            color: techTab === t.id ? C.text : C.muted,
            border: `0.5px solid ${techTab === t.id ? C.text : C.border}`,
            borderRadius: "var(--border-radius-md)",
            padding: "5px 12px", fontSize: "12px",
            fontWeight: techTab === t.id ? 500 : 400,
            cursor: "pointer", display: "flex", alignItems: "center", gap: "6px",
          }}>
            {t.label}
            {t.count != null && <span style={{ fontSize: "10px", opacity: 0.7 }}>({t.count})</span>}
          </button>
        ))}
      </div>

      {/* Description */}
      <div style={{
        fontSize: "11px", color: C.muted, fontFamily: "var(--font-mono)",
        padding: "8px 12px", background: C.surface, borderRadius: "var(--border-radius-md)",
        marginBottom: "10px", lineHeight: 1.5,
      }}>
        {isLoser
          ? "Top 20 losers where price is below 20 EMA, below 50 EMA, AND just crossed BELOW VWAP on the 5-min chart (strong bearish technical setup)."
          : "Top 20 gainers where price is above 20 EMA, above 50 EMA, AND just crossed ABOVE VWAP on the 5-min chart (strong bullish technical setup)."}
      </div>

      {/* Error */}
      {err && (
        <div style={{
          padding: "10px 14px", background: C.lossBg, color: C.loss,
          borderRadius: "var(--border-radius-md)", fontSize: "12px", marginBottom: "1rem",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontFamily: "var(--font-mono)",
        }}>
          <span>Error: {err}</span>
          <button onClick={onRetry} style={{ fontSize: "11px", padding: "4px 10px", cursor: "pointer" }}>retry</button>
        </div>
      )}

      {/* Progress */}
      {scanning && (
        <div style={{ fontFamily: "var(--font-mono)" }}>
          <div style={{
            fontSize: "11px", color: C.muted, marginBottom: "8px",
            display: "flex", justifyContent: "space-between",
          }}>
            <span>fetching historical + 5-min candles for rolling EMA + VWAP analysis...</span>
            <span>{progress.done} / {progress.total}</span>
          </div>
          <div style={{
            height: "4px", background: C.surface,
            borderRadius: "var(--border-radius-md)", overflow: "hidden", marginBottom: "12px",
          }}>
            <div style={{
              width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
              height: "100%", background: C.text, transition: "width 0.3s",
            }} />
          </div>
        </div>
      )}

      {/* Empty state */}
      {list && !scanning && list.length === 0 && (
        <div style={{
          padding: "2rem 0", textAlign: "center", color: C.hint,
          fontFamily: "var(--font-mono)", fontSize: "12px",
        }}>
          <div style={{ fontSize: "24px", marginBottom: "8px", opacity: 0.3 }}>—</div>
          No {isLoser ? "bearish" : "bullish"} technical signals in the top 20.
          <div style={{ fontSize: "10px", marginTop: "4px" }}>
            (no stock has all 3 conditions: 20 EMA + 50 EMA + fresh VWAP cross)
          </div>
        </div>
      )}

      {/* List */}
      {list && !scanning && list.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {list.map((entry, i) => (
            <TechnicalsCard key={entry.stock.key} entry={entry} rank={i + 1}
              isLoser={isLoser}
              onClick={() => onSelect(entry.stock, isLoser ? "losers" : "gainers")} />
          ))}
        </div>
      )}
    </div>
  );
}

/* HistoryView — shows last 10 scan snapshots with sticky leader detection */
function HistoryView({ scanHistory, historyTab, setHistoryTab, onSelect }) {
  const isLoser = historyTab === "losers";

  // Compute "sticky count" — how many snapshots each stock appears in
  const stickyCount = {};
  for (const snap of scanHistory) {
    const list = isLoser ? snap.losers : snap.gainers;
    for (const stock of list) {
      stickyCount[stock.sym] = (stickyCount[stock.sym] || 0) + 1;
    }
  }

  // Stocks appearing in 3+ scans are "sticky leaders"
  const STICKY_THRESHOLD = 3;

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px", fontFamily: "var(--font-mono)" }}>
        {[
          { id: "gainers", label: "▲ gainers history" },
          { id: "losers",  label: "▼ losers history" },
        ].map(t => (
          <button key={t.id} onClick={() => setHistoryTab(t.id)} style={{
            background: historyTab === t.id ? C.surface : "transparent",
            color: historyTab === t.id ? C.text : C.muted,
            border: `0.5px solid ${historyTab === t.id ? C.text : C.border}`,
            borderRadius: "var(--border-radius-md)",
            padding: "5px 12px", fontSize: "12px",
            fontWeight: historyTab === t.id ? 500 : 400,
            cursor: "pointer",
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Description */}
      <div style={{
        fontSize: "11px", color: C.muted, fontFamily: "var(--font-mono)",
        padding: "8px 12px", background: C.surface, borderRadius: "var(--border-radius-md)",
        marginBottom: "12px", lineHeight: 1.5,
      }}>
        Top 5 {isLoser ? "losers" : "gainers"} from each of your last {scanHistory.length} scan{scanHistory.length === 1 ? "" : "s"} (newest first).
        Stocks appearing in {STICKY_THRESHOLD}+ scans are marked as sticky leaders (consistent strength).
      </div>

      {/* Empty state */}
      {scanHistory.length === 0 && (
        <div style={{
          padding: "2rem 0", textAlign: "center", color: C.hint,
          fontFamily: "var(--font-mono)", fontSize: "12px",
        }}>
          <div style={{ fontSize: "24px", marginBottom: "8px", opacity: 0.3 }}>—</div>
          No scan history yet.
          <div style={{ fontSize: "10px", marginTop: "4px" }}>
            Click "scan now" to start building history.
          </div>
        </div>
      )}

      {/* Snapshots */}
      {scanHistory.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {scanHistory.map((snap, snapIdx) => {
            const list = isLoser ? snap.losers : snap.gainers;
            const accent   = isLoser ? C.loss : C.gain;
            const accentBg = isLoser ? C.lossBg : C.gainBg;

            return (
              <div key={`${snap.at}-${snapIdx}`} style={{
                background: C.card, border: `0.5px solid ${C.border}`,
                borderRadius: "var(--border-radius-lg)", padding: "12px 14px",
              }}>
                {/* Timestamp header */}
                <div style={{
                  fontSize: "11px", color: C.muted, marginBottom: "10px",
                  fontFamily: "var(--font-mono)",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span>{snapIdx === 0 ? "latest · " : ""}scan @ {snap.at}</span>
                  <span style={{ fontSize: "10px", opacity: 0.7 }}>#{scanHistory.length - snapIdx}</span>
                </div>

                {/* Top 5 list */}
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {list.map((stock, i) => {
                    const sticky = stickyCount[stock.sym] >= STICKY_THRESHOLD;
                    return (
                      <div key={stock.key} onClick={() => onSelect(stock, isLoser ? "losers" : "gainers")}
                        style={{
                          display: "flex", alignItems: "center", gap: "10px",
                          padding: "6px 8px", borderRadius: "var(--border-radius-md)",
                          background: sticky ? accentBg : "transparent",
                          cursor: "pointer", fontSize: "12px",
                          fontFamily: "var(--font-mono)",
                        }}
                        onMouseEnter={e => { if (!sticky) e.currentTarget.style.background = C.surface; }}
                        onMouseLeave={e => { if (!sticky) e.currentTarget.style.background = "transparent"; }}
                      >
                        <span style={{ color: C.muted, width: "16px" }}>{i + 1}.</span>
                        <span style={{ color: C.text, flex: 1, fontWeight: sticky ? 500 : 400 }}>
                          {stock.sym}
                          {sticky && (
                            <span style={{
                              marginLeft: "8px", fontSize: "9px", color: accent,
                              padding: "2px 6px", background: C.card,
                              borderRadius: "var(--border-radius-md)",
                              border: `0.5px solid ${accent}`,
                            }}>
                              sticky × {stickyCount[stock.sym]}
                            </span>
                          )}
                        </span>
                        <span style={{ color: C.muted }}>₹{fmtINR(stock.ltp)}</span>
                        <span style={{
                          color: accent, fontWeight: 500, minWidth: "60px", textAlign: "right",
                        }}>
                          {stock.changePct >= 0 ? "+" : ""}{stock.changePct.toFixed(2)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TabBar({ tab, setTab, gCount, lCount, rankedReady, convictionReady, techReady, historyCount }) {
  const tabs = [
    { id: "gainers",    label: "▲ gainers",       color: C.gain,     bg: C.gainBg, count: gCount },
    { id: "losers",     label: "▼ losers",        color: C.loss,     bg: C.lossBg, count: lCount },
    { id: "ranked",     label: "◆ ranked",        color: C.infoText, bg: C.infoBg, count: rankedReady },
    { id: "conviction", label: "◇ open=low/high", color: C.warnText, bg: C.warnBg, count: convictionReady },
    { id: "technicals", label: "◈ technicals",    color: C.text,     bg: C.surface, count: techReady },
    { id: "history",    label: "⟲ history",       color: C.muted,    bg: C.surface, count: historyCount },
  ];
  return (
    <div style={{ display: "flex", borderBottom: `0.5px solid ${C.border}`, marginBottom: "1rem", fontFamily: "var(--font-mono)" }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{
          background: "transparent", border: "none", borderRadius: 0,
          borderBottom: tab === t.id ? `2px solid ${t.color}` : "2px solid transparent",
          padding: "8px 20px", fontSize: "13px",
          fontWeight: tab === t.id ? 500 : 400, cursor: "pointer",
          color: tab === t.id ? t.color : C.muted, letterSpacing: "0.04em",
          display: "flex", alignItems: "center", gap: "6px",
        }}>
          {t.label}
          {t.count != null && (
            <span style={{
              fontSize: "10px", padding: "1px 5px", borderRadius: "var(--border-radius-md)",
              background: tab === t.id ? t.bg : C.surface,
              color: tab === t.id ? t.color : C.hint,
            }}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ── Main page ── */
export default function ScannerPage() {
  const router = useRouter();
  const [token,    setToken]    = useState("");
  const [showTokenPanel, setShowTokenPanel] = useState(true);
  const [universe, setUniverse] = useState(null);    // [{sym, key}, ...]
  const [futuresMap, setFuturesMap] = useState(null); // { "underlyingKey|YYYY-MM": {instrumentKey, expiry, ...} }
  const [universeLoading, setUniverseLoading] = useState(true);
  const [universeErr, setUniverseErr] = useState(null);
  const [gainers,  setGainers]  = useState(null);
  const [losers,   setLosers]   = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr,  setScanErr]  = useState(null);
  const [tab,      setTab]      = useState("gainers");
  const [selected, setSelected] = useState(null);
  const [scannedAt,setScannedAt]= useState(null);

  // Ranked tab state
  const [rankedGainers, setRankedGainers] = useState(null);
  const [rankedLosers,  setRankedLosers]  = useState(null);
  const [rankedScanning, setRankedScanning] = useState(false);
  const [rankedProgress, setRankedProgress] = useState({ done: 0, total: 0 });
  const [rankedErr, setRankedErr] = useState(null);
  const [rankedTab, setRankedTab] = useState("gainers"); // sub-tab inside ranked

  // Conviction tab state — equity AND future both open=low (bullish) or open=high (bearish)
  const [convictionGainers, setConvictionGainers] = useState(null);
  const [convictionLosers,  setConvictionLosers]  = useState(null);
  const [convictionScanning, setConvictionScanning] = useState(false);
  const [convictionProgress, setConvictionProgress] = useState({ done: 0, total: 0 });
  const [convictionErr, setConvictionErr] = useState(null);
  const [convictionTab, setConvictionTab] = useState("gainers");

  // Technicals tab state — EMA 20/200 + VWAP cross filtering
  const [techGainers, setTechGainers] = useState(null);
  const [techLosers,  setTechLosers]  = useState(null);
  const [techScanning, setTechScanning] = useState(false);
  const [techProgress, setTechProgress] = useState({ done: 0, total: 0 });
  const [techErr, setTechErr] = useState(null);
  const [techTab, setTechTab] = useState("gainers");

  // History tab state — array of past scan snapshots (max 10), each with timestamp + top 5 gainers + top 5 losers
  const [scanHistory, setScanHistory] = useState([]);  // [{ at, gainers: [...], losers: [...] }, ...]
  const [historyTab, setHistoryTab] = useState("gainers"); // sub-tab inside history

  // Expiry selector — current and next month only
  const expiryOptions = getMonthlyExpiries();
  const [selectedExpiry, setSelectedExpiry] = useState(expiryOptions[0]);

  // Fetch the F&O universe on mount
  const loadUniverse = useCallback(async () => {
    setUniverseLoading(true);
    setUniverseErr(null);
    try {
      const res = await fetch("/api/universe");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = await res.json();
      setUniverse(j.stocks);
      setFuturesMap(j.futures || {});
    } catch (e) {
      setUniverseErr(e.message);
    } finally {
      setUniverseLoading(false);
    }
  }, []);

  useEffect(() => { loadUniverse(); }, [loadUniverse]);

  const scan = useCallback(async () => {
    if (!token || !universe) return;
    setScanning(true); setScanErr(null);
    setGainers(null); setLosers(null); setSelected(null);
    // Reset ranked data — it's stale once a fresh scan starts
    setRankedGainers(null); setRankedLosers(null); setRankedErr(null);
    setRankedProgress({ done: 0, total: 0 });
    setConvictionGainers(null); setConvictionLosers(null); setConvictionErr(null);
    setConvictionProgress({ done: 0, total: 0 });
    setTechGainers(null); setTechLosers(null); setTechErr(null);
    setTechProgress({ done: 0, total: 0 });
    try {
      const keys = universe.map(s => s.key);
      const data = await fetchOhlc(keys, token);

      const tokenToSym = {};
      universe.forEach(s => { tokenToSym[s.key] = s.sym; });

      const enriched = [];
      Object.values(data).forEach(item => {
        const sym = tokenToSym[item.instrument_token];
        if (!sym) return;
        // /quotes endpoint: ohlc.close = previous day close, ohlc.open/high/low = today's session
        const ohlc = item.ohlc || {};

        const ltp = item.last_price;
        const prevClose = ohlc.close;
        if (!ltp || !prevClose) return;

        // /quotes returns net_change directly — exactly what brokers display
        const change = item.net_change ?? (ltp - prevClose);
        const changePct = (change / prevClose) * 100;

        enriched.push({
          sym, key: item.instrument_token,
          ltp,
          open: ohlc.open, high: ohlc.high, low: ohlc.low,
          close: prevClose, change, changePct,
        });
      });

      enriched.sort((a, b) => b.changePct - a.changePct);
      const newGainers = enriched.slice(0, 20);
      const newLosers  = enriched.slice(-20).reverse();
      setGainers(newGainers);
      setLosers(newLosers);
      const stamp = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
      setScannedAt(stamp);

      // Append top 5 gainers + losers to scan history (rolling window of 10)
      const snapshot = {
        at: stamp,
        gainers: newGainers.slice(0, 5).map(s => ({ sym: s.sym, key: s.key, changePct: s.changePct, ltp: s.ltp })),
        losers:  newLosers.slice(0, 5).map(s => ({ sym: s.sym, key: s.key, changePct: s.changePct, ltp: s.ltp })),
      };
      setScanHistory(prev => {
        const next = [snapshot, ...prev];   // newest first
        return next.slice(0, 10);            // keep max 10
      });

      setShowTokenPanel(false);
    } catch (e) {
      setScanErr(e.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  }, [token, universe]);

  // Ranked tab: count signals for each top-20 gainer & loser, rank by signal strength
  const runRankedScan = useCallback(async () => {
    if (!gainers || !losers || !token) return;
    if (rankedScanning) return;

    setRankedScanning(true);
    setRankedErr(null);
    const allStocks = [...gainers, ...losers];
    setRankedProgress({ done: 0, total: allStocks.length });

    const results = new Map();   // key -> { stock, signals, type }

    // Process sequentially to keep API load reasonable; could parallelize later
    for (let i = 0; i < allStocks.length; i++) {
      const stock = allStocks[i];
      const isGainer = i < gainers.length;
      try {
        const signals = await countSignalsForStock(stock, selectedExpiry.iso, token);
        // For gainers (bullish): CE open=low + PE open=high
        // For losers (bearish):  PE open=low + CE open=high
        const score = isGainer
          ? signals.ceOpenEqLow + signals.peOpenEqHigh
          : signals.peOpenEqLow + signals.ceOpenEqHigh;
        results.set(stock.key, { stock, signals, score, isGainer });
      } catch (e) {
        // If one stock fails, log it but keep going
        results.set(stock.key, { stock, signals: null, score: 0, isGainer, err: e.message });
      }
      setRankedProgress({ done: i + 1, total: allStocks.length });
    }

    const allResults = Array.from(results.values());
    const rGainers = allResults
      .filter(r => r.isGainer)
      .sort((a, b) => b.score - a.score);
    const rLosers = allResults
      .filter(r => !r.isGainer)
      .sort((a, b) => b.score - a.score);

    setRankedGainers(rGainers);
    setRankedLosers(rLosers);
    setRankedScanning(false);
  }, [gainers, losers, token, selectedExpiry, rankedScanning]);

  // Auto-trigger ranked scan when user switches to Ranked tab and we don't have data yet
  useEffect(() => {
    if (tab === "ranked" && gainers && losers && !rankedGainers && !rankedScanning && !rankedErr) {
      runRankedScan();
    }
  }, [tab, gainers, losers, rankedGainers, rankedScanning, rankedErr, runRankedScan]);

  // Conviction tab: find stocks where BOTH equity and its future have open=low (bullish) or open=high (bearish)
  const runConvictionScan = useCallback(async () => {
    if (!gainers || !losers || !token || !futuresMap) return;
    if (convictionScanning) return;

    setConvictionScanning(true);
    setConvictionErr(null);

    try {
      // Always use the FRONT-MONTH future (current month, or next month if current has expired)
      const today = new Date().toISOString().slice(0, 10);

      // Helper: for a given underlying key, find the nearest non-expired futures contract
      const findFrontMonthFuture = (underlyingKey) => {
        // futuresMap is keyed as `underlyingKey|YYYY-MM` → { instrumentKey, expiry }
        // Find all entries for this underlying that haven't expired
        const candidates = Object.entries(futuresMap)
          .filter(([k, v]) => k.startsWith(underlyingKey + "|") && v.expiry >= today)
          .map(([_, v]) => v)
          .sort((a, b) => a.expiry.localeCompare(b.expiry)); // earliest first
        return candidates[0]?.instrumentKey || null;
      };

      // Build a list of all top-20 stocks and find their FRONT-MONTH future keys
      const allStocks = [...gainers, ...losers].map((stock, i) => ({
        stock,
        isGainer: i < gainers.length,
        futureKey: findFrontMonthFuture(stock.key),
      }));

      // Stocks without a future contract — can't be evaluated
      const evaluable = allStocks.filter(s => s.futureKey);
      const futureKeys = evaluable.map(s => s.futureKey);

      setConvictionProgress({ done: 0, total: futureKeys.length });

      if (futureKeys.length === 0) {
        setConvictionGainers([]);
        setConvictionLosers([]);
        setConvictionScanning(false);
        return;
      }

      // Fetch OHLC for all futures in one batched call
      const futOhlc = await fetchOhlc(futureKeys, token);  // /v2/quotes returns ohlc.{open,high,low,close}

      // Build a quick lookup: futureKey -> { open, high, low, close }
      const futOhlcMap = {};
      Object.values(futOhlc).forEach(item => {
        const key = item.instrument_token;
        const ohlc = item.ohlc || {};
        futOhlcMap[key] = ohlc;
      });

      setConvictionProgress({ done: futureKeys.length, total: futureKeys.length });

      // For each evaluable stock, check if equity AND future signal align
      const gainerHits = [];
      const loserHits = [];

      for (const { stock, isGainer, futureKey } of evaluable) {
        const futOhlc = futOhlcMap[futureKey];
        if (!futOhlc || futOhlc.open == null) continue;

        // Equity check (using stock's open/high/low we already have from scan)
        if (stock.open == null) continue;

        if (isGainer) {
          // Bullish signal: BOTH equity and future have open ≈ day's low (within 2%)
          const equityOpenEqLow = isOpenAtLow(stock);
          const futureOpenEqLow = isOpenAtLow(futOhlc);
          if (equityOpenEqLow && futureOpenEqLow) {
            gainerHits.push({ stock, futOhlc });
          }
        } else {
          // Bearish signal: BOTH equity and future have open ≈ day's high (within 2%)
          const equityOpenEqHigh = isOpenAtHigh(stock);
          const futureOpenEqHigh = isOpenAtHigh(futOhlc);
          if (equityOpenEqHigh && futureOpenEqHigh) {
            loserHits.push({ stock, futOhlc });
          }
        }
      }

      // Sort by % change magnitude (most extreme first)
      gainerHits.sort((a, b) => b.stock.changePct - a.stock.changePct);
      loserHits.sort((a, b) => a.stock.changePct - b.stock.changePct);

      setConvictionGainers(gainerHits);
      setConvictionLosers(loserHits);
    } catch (e) {
      setConvictionErr(e.message || "Conviction scan failed");
    } finally {
      setConvictionScanning(false);
    }
  }, [gainers, losers, token, futuresMap, convictionScanning]);

  // Auto-trigger when user switches to conviction tab
  useEffect(() => {
    if (tab === "conviction" && gainers && losers && futuresMap && !convictionGainers && !convictionScanning && !convictionErr) {
      runConvictionScan();
    }
  }, [tab, gainers, losers, futuresMap, convictionGainers, convictionScanning, convictionErr, runConvictionScan]);

  // Technicals tab: scan top 20 gainers + 20 losers, fetch 5-min candles, filter by EMA + VWAP cross
  const runTechnicalsScan = useCallback(async () => {
    if (!gainers || !losers || !token) return;
    if (techScanning) return;

    setTechScanning(true);
    setTechErr(null);

    try {
      const allStocks = [...gainers, ...losers].map((stock, i) => ({
        stock,
        isGainer: i < gainers.length,
      }));

      setTechProgress({ done: 0, total: allStocks.length });

      const gainerHits = [];
      const loserHits = [];

      // Process sequentially with small concurrency batching to respect Upstox rate limits (~25/sec)
      // Process in batches. We now make 2 API calls per stock (historical + intraday), so use smaller batches
      const BATCH_SIZE = 3;
      for (let i = 0; i < allStocks.length; i += BATCH_SIZE) {
        const batch = allStocks.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
          batch.map(async ({ stock, isGainer }) => {
            try {
              // Fetch both historical (past 3 days) and intraday (today) candles in parallel
              const [historical, intraday] = await Promise.all([
                fetchHistoricalCandles(stock.key, token, 5, 3),
                fetchIntradayCandles(stock.key, token, 5),
              ]);
              const tech = analyzeWithHistory(historical, intraday);
              return { stock, isGainer, tech, err: null };
            } catch (e) {
              return { stock, isGainer, tech: null, err: e.message };
            }
          })
        );

        for (const r of results) {
          if (!r.tech) continue;
          const { close, ema20, ema50, vwap, cross } = r.tech;
          if (close == null || vwap == null) continue;

          if (r.isGainer) {
            // Bullish: above 20 EMA, above 50 EMA, just crossed ABOVE VWAP
            const above20 = ema20 != null && close > ema20;
            const above50 = ema50 != null && close > ema50;
            const justCrossedUp = cross === "above";
            if (above20 && above50 && justCrossedUp) {
              gainerHits.push({ stock: r.stock, tech: r.tech });
            }
          } else {
            // Bearish: below 20 EMA, below 50 EMA, just crossed BELOW VWAP
            const below20 = ema20 != null && close < ema20;
            const below50 = ema50 != null && close < ema50;
            const justCrossedDown = cross === "below";
            if (below20 && below50 && justCrossedDown) {
              loserHits.push({ stock: r.stock, tech: r.tech });
            }
          }
        }

        setTechProgress({ done: Math.min(i + BATCH_SIZE, allStocks.length), total: allStocks.length });
      }

      // Sort by % change magnitude (most extreme first)
      gainerHits.sort((a, b) => b.stock.changePct - a.stock.changePct);
      loserHits.sort((a, b) => a.stock.changePct - b.stock.changePct);

      setTechGainers(gainerHits);
      setTechLosers(loserHits);
    } catch (e) {
      setTechErr(e.message || "Technicals scan failed");
    } finally {
      setTechScanning(false);
    }
  }, [gainers, losers, token, techScanning]);

  // Auto-trigger when user switches to technicals tab
  useEffect(() => {
    if (tab === "technicals" && gainers && losers && !techGainers && !techScanning && !techErr) {
      runTechnicalsScan();
    }
  }, [tab, gainers, losers, techGainers, techScanning, techErr, runTechnicalsScan]);

  async function logout() {
    await fetch("/api/auth", { method: "DELETE" });
    router.push("/login");
    router.refresh();
  }

  const neverScanned = !gainers && !losers && !scanning;
  const activeList = tab === "gainers" ? gainers : losers;

  return (
    <div style={{ padding: "1rem 0" }}>
      <h2 className="sr-only">NSE Options Scanner — Live Upstox Data</h2>

      {!selected && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: "1.25rem", flexWrap: "wrap", gap: "10px",
        }}>
          <div>
            <div style={{ fontSize: "10px", letterSpacing: "0.12em", color: C.hint, textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
              National Stock Exchange · Upstox Live
            </div>
            <div style={{ fontSize: "17px", fontWeight: 500, color: C.text, marginTop: "2px" }}>
              Options scanner
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontFamily: "var(--font-mono)" }}>
            {universe && !universeLoading && (
              <span style={{
                fontSize: "11px", color: C.muted, padding: "3px 8px",
                background: C.surface, borderRadius: "var(--border-radius-md)",
              }} title="Click to refresh universe">
                <button onClick={loadUniverse} style={{
                  background: "transparent", border: "none", padding: 0,
                  color: C.muted, fontSize: "11px", cursor: "pointer", fontFamily: "var(--font-mono)",
                }}>
                  {universe.length} stocks ↻
                </button>
              </span>
            )}
            {scannedAt && !scanning && (
              <span style={{
                fontSize: "11px", color: C.muted, padding: "3px 8px",
                border: `0.5px solid ${C.border}`, borderRadius: "var(--border-radius-md)",
              }}>updated {scannedAt}</span>
            )}
            <select
              value={selectedExpiry?.iso || ""}
              onChange={e => {
                const next = expiryOptions.find(o => o.iso === e.target.value);
                if (next) setSelectedExpiry(next);
              }}
              title="Expiry month"
              style={{
                fontSize: "12px", padding: "5px 8px",
                background: C.card, color: C.text,
                border: `0.5px solid ${C.border}`,
                borderRadius: "var(--border-radius-md)",
                fontFamily: "var(--font-mono)", cursor: "pointer",
              }}
            >
              {expiryOptions.map(o => (
                <option key={o.iso} value={o.iso}>{o.label}</option>
              ))}
            </select>
            {token && !showTokenPanel && (
              <button onClick={() => setShowTokenPanel(p => !p)} style={{
                fontSize: "11px", padding: "5px 10px", cursor: "pointer",
              }}>token</button>
            )}
            <button onClick={scan} disabled={scanning || !token || !universe} style={{
              fontSize: "13px", padding: "6px 16px",
              cursor: (scanning || !token || !universe) ? "not-allowed" : "pointer",
              opacity: (scanning || !token || !universe) ? 0.6 : 1,
            }}>
              {scanning ? "scanning..." : universeLoading ? "loading universe..." : "scan now ↗"}
            </button>
            <button onClick={logout} style={{
              fontSize: "11px", padding: "5px 10px", cursor: "pointer", color: C.muted,
            }}>sign out</button>
          </div>
        </div>
      )}

      {!selected && showTokenPanel && (
        <TokenPanel token={token} setToken={setToken} onSave={() => setShowTokenPanel(false)} />
      )}

      {universeErr && !selected && (
        <div style={{
          padding: "10px 14px", background: C.lossBg, color: C.loss,
          borderRadius: "var(--border-radius-md)", fontSize: "12px", marginBottom: "1rem",
          fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px",
        }}>
          <span>Could not load NSE F&O universe: {universeErr}</span>
          <button onClick={loadUniverse} style={{ fontSize: "11px", padding: "4px 10px", cursor: "pointer" }}>retry</button>
        </div>
      )}

      {scanErr && !selected && (
        <div style={{
          padding: "10px 14px", background: C.lossBg, color: C.loss,
          borderRadius: "var(--border-radius-md)", fontSize: "12px", marginBottom: "1rem",
          fontFamily: "var(--font-mono)",
        }}>
          Error: {scanErr}
        </div>
      )}

      {neverScanned && !showTokenPanel && (
        <div style={{ padding: "4rem 0", textAlign: "center", color: C.hint, fontFamily: "var(--font-mono)" }}>
          <div style={{ fontSize: "32px", marginBottom: "10px", opacity: 0.2 }}>◈</div>
          <div style={{ fontSize: "13px" }}>Press scan now to fetch live Upstox data</div>
          <div style={{ fontSize: "11px", marginTop: "4px" }}>
            {universeLoading
              ? "Loading NSE F&O universe..."
              : universe
                ? `Real-time NSE F&O quotes · ${universe.length} stocks tracked`
                : "Universe not loaded"
            }
          </div>
        </div>
      )}

      {scanning && <Skeleton/>}

      {!selected && !neverScanned && !scanning && (
        <>
          <TabBar tab={tab} setTab={t => { setTab(t); setSelected(null); }}
            gCount={gainers?.length} lCount={losers?.length}
            rankedReady={rankedGainers ? rankedGainers.length + (rankedLosers?.length || 0) : null}
            convictionReady={convictionGainers ? convictionGainers.length + (convictionLosers?.length || 0) : null}
            techReady={techGainers ? techGainers.length + (techLosers?.length || 0) : null}
            historyCount={scanHistory.length || null} />

          {/* Gainers / Losers tabs — simple list */}
          {(tab === "gainers" || tab === "losers") && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {activeList?.map((stock, i) => (
                <StockCard key={stock.key} stock={stock} rank={i + 1}
                  isLoser={tab === "losers"} onClick={() => setSelected({ stock, list: tab })} />
              ))}
            </div>
          )}

          {/* Ranked tab — sub-tabs + ranked list */}
          {tab === "ranked" && (
            <RankedView
              rankedGainers={rankedGainers}
              rankedLosers={rankedLosers}
              scanning={rankedScanning}
              progress={rankedProgress}
              err={rankedErr}
              onRetry={runRankedScan}
              rankedTab={rankedTab}
              setRankedTab={setRankedTab}
              onSelect={(stock, list) => setSelected({ stock, list })}
            />
          )}

          {/* Conviction tab — equity AND future both open=low/high */}
          {tab === "conviction" && (
            <ConvictionView
              convictionGainers={convictionGainers}
              convictionLosers={convictionLosers}
              scanning={convictionScanning}
              progress={convictionProgress}
              err={convictionErr}
              onRetry={runConvictionScan}
              convictionTab={convictionTab}
              setConvictionTab={setConvictionTab}
              onSelect={(stock, list) => setSelected({ stock, list })}
            />
          )}

          {/* Technicals tab — EMA + VWAP cross filtering */}
          {tab === "technicals" && (
            <TechnicalsView
              techGainers={techGainers}
              techLosers={techLosers}
              scanning={techScanning}
              progress={techProgress}
              err={techErr}
              onRetry={runTechnicalsScan}
              techTab={techTab}
              setTechTab={setTechTab}
              onSelect={(stock, list) => setSelected({ stock, list })}
            />
          )}

          {/* History tab — last 10 scan snapshots with sticky leader detection */}
          {tab === "history" && (
            <HistoryView
              scanHistory={scanHistory}
              historyTab={historyTab}
              setHistoryTab={setHistoryTab}
              onSelect={(stock, list) => setSelected({ stock, list })}
            />
          )}
        </>
      )}

      {selected && (
        <DetailPage stock={selected.stock} isLoser={selected.list === "losers"}
          token={token} selectedExpiry={selectedExpiry}
          onBack={() => setSelected(null)} />
      )}
    </div>
  );
}
