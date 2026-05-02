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

function sendNotification(title, body) {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch {}
  }
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
  if (allStrikes.length === 0) return { ceOpenEqLow: 0, ceOpenEqHigh: 0, peOpenEqLow: 0, peOpenEqHigh: 0, pcr: null };
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
  if (optKeys.length === 0) return { ceOpenEqLow: 0, ceOpenEqHigh: 0, peOpenEqLow: 0, peOpenEqHigh: 0, pcr: null };

  // 6. Fetch OHLC for all those options in one call
  const ohlcData = await fetchOptionOhlc(optKeys, token);
  const ohlcByKey = {};
  Object.values(ohlcData).forEach(item => { ohlcByKey[item.instrument_token] = item; });

  // 7. Count signals with strike-distance weighting
  //    Anchor (ATM) = 3 · OTM 1-5 strikes = 2 · OTM 6-10 strikes = 1.5 · ITM = 1
  //    CE OTM = strike > anchor; PE OTM = strike < anchor
  let ceOpenEqLow = 0, ceOpenEqHigh = 0, peOpenEqLow = 0, peOpenEqHigh = 0;
  let ceOpenLowScore = 0, ceOpenHighScore = 0, peOpenLowScore = 0, peOpenHighScore = 0;

  const strikeWeight = (strike, optType) => {
    if (strike === anchor) return 3;
    const dist = Math.abs(allStrikes.indexOf(strike) - anchorIdx);
    const isOtm = optType === "CE" ? strike > anchor : strike < anchor;
    if (isOtm) return dist <= 5 ? 2 : 1.5;
    return 1; // ITM
  };

  const tally = (opt, strike, type) => {
    if (!opt?.instrument_key) return;
    const live = ohlcByKey[opt.instrument_key]?.live_ohlc;
    if (!live || live.open == null || live.low == null || live.high == null) return;
    const openEqLow  = Math.abs(live.open - live.low)  < 0.01;
    const openEqHigh = Math.abs(live.open - live.high) < 0.01;
    const w = strikeWeight(strike, type);
    if (type === "CE") {
      if (openEqLow)  { ceOpenEqLow++;  ceOpenLowScore  += w; }
      if (openEqHigh) { ceOpenEqHigh++; ceOpenHighScore += w; }
    } else {
      if (openEqLow)  { peOpenEqLow++;  peOpenLowScore  += w; }
      if (openEqHigh) { peOpenEqHigh++; peOpenHighScore += w; }
    }
  };

  for (const r of selected) {
    tally(r.call_options, r.strike_price, "CE");
    tally(r.put_options,  r.strike_price, "PE");
  }

  // Sum OI from chain data (available without extra API call)
  let ceOi = 0, peOi = 0;
  for (const r of selected) {
    ceOi += r.call_options?.market_data?.oi || 0;
    peOi += r.put_options?.market_data?.oi  || 0;
  }
  const pcr = ceOi > 0 ? peOi / ceOi : null;

  return {
    ceOpenEqLow, ceOpenEqHigh, peOpenEqLow, peOpenEqHigh, // raw counts (for display)
    ceOpenLowScore, ceOpenHighScore, peOpenLowScore, peOpenHighScore, // weighted scores (for scoring)
    pcr,
  };
}

/*
  Multi-factor conviction score (0–100) for a gainer or loser.

  Factors & max weights:
    40 pts — weighted options signal score
               Gainers: ceOpenLowScore + peOpenHighScore
               Losers:  peOpenLowScore + ceOpenHighScore
               Weights: anchor=3 · OTM 1-5=2 · OTM 6-10=1.5 · ITM=1
               Normalised against a target of 20 weighted pts = full marks
    20 pts — equity open = day's low/high
    15 pts — PCR confirmation (low = call-side bullish; high = put-side bearish)
    25 pts — % change magnitude (capped at 5%)
*/
function computeConvictionScore(stock, signals, isGainer) {
  let score = 0;

  // 1. Weighted options signal score (0–40 pts; weighted score of 20 = full marks)
  const weightedSig = isGainer
    ? (signals.ceOpenLowScore  ?? 0) + (signals.peOpenHighScore ?? 0)
    : (signals.peOpenLowScore  ?? 0) + (signals.ceOpenHighScore ?? 0);
  score += Math.min((weightedSig / 20) * 40, 40);

  // 2. Equity open = day's low (bullish) or high (bearish)
  if (stock.open != null) {
    const hit = isGainer
      ? Math.abs(stock.open - (stock.low  ?? stock.open)) < 0.01
      : Math.abs(stock.open - (stock.high ?? stock.open)) < 0.01;
    if (hit) score += 20;
  }

  // 3. PCR — Indian F&O is writing-dominated so OI reflects writers, not buyers:
  //    High CE OI (low PCR)  = call writers capping upside   = bearish
  //    High PE OI (high PCR) = put writers supporting floor  = bullish
  const { pcr } = signals;
  if (pcr != null) {
    if (isGainer)  score += pcr > 1.2 ? 15 : pcr < 0.7 ? -5 : 0;  // high PCR = put writers = floor support = bullish
    else           score += pcr < 0.8 ? 15 : pcr > 1.3 ? -5 : 0;  // low PCR  = call writers = ceiling = bearish
  }

  // 4. % change magnitude (0–25 pts; 5%+ = full marks)
  score += Math.min((Math.abs(stock.changePct ?? 0) / 5) * 25, 25);

  return Math.round(Math.min(Math.max(score, 0), 100));
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
    if (Math.abs(opt.open - opt.low)  < 0.01) return "low";
    if (Math.abs(opt.open - opt.high) < 0.01) return "high";
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

  const lowCnt  = chain?.filter(r => r.open != null && Math.abs(r.open - r.low)  < 0.01).length ?? 0;
  const highCnt = chain?.filter(r => r.open != null && Math.abs(r.open - r.high) < 0.01).length ?? 0;
  const strikesCnt = chain ? [...new Set(chain.map(r => r.strike))].length : 0;
  const totalCeOi = chain?.filter(r => r.type === "CE").reduce((s, r) => s + (r.oi || 0), 0) ?? 0;
  const totalPeOi = chain?.filter(r => r.type === "PE").reduce((s, r) => s + (r.oi || 0), 0) ?? 0;
  const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : null;

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
          {
            label: "PCR (PE OI / CE OI)",
            val: loading ? "…" : pcr != null ? pcr.toFixed(2) : "—",
            color: pcr == null ? C.hint : pcr > 1.2 ? C.gain : pcr < 0.8 ? C.loss : C.muted,
          },
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
        {signals.pcr != null && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "10px", color: C.muted }}>PCR</div>
            <div style={{ fontSize: "13px", fontWeight: 500, color: signals.pcr > 1.2 ? C.gain : signals.pcr < 0.8 ? C.loss : C.muted }}>
              {signals.pcr.toFixed(2)}
            </div>
          </div>
        )}
        <div style={{
          borderRadius: "var(--border-radius-md)",
          padding: "5px 11px", textAlign: "center", minWidth: "52px",
          background: entry.score >= 70 ? C.gainBg : entry.score >= 40 ? C.warnBg : C.surface,
          color:      entry.score >= 70 ? C.gain    : entry.score >= 40 ? C.warnText : C.hint,
        }}>
          <div style={{ fontSize: "13px", fontWeight: 500 }}>{entry.score}</div>
          <div style={{ fontSize: "9px", opacity: 0.7, letterSpacing: "0.06em" }}>/ 100</div>
        </div>
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

function HistoryView({ history, onClear }) {
  const [expanded, setExpanded] = useState(null);

  if (history.length === 0) {
    return (
      <div style={{ padding: "4rem 0", textAlign: "center", color: C.hint, fontFamily: "var(--font-mono)" }}>
        <div style={{ fontSize: "32px", marginBottom: "10px", opacity: 0.2 }}>⟳</div>
        <div style={{ fontSize: "13px" }}>No scan history yet</div>
        <div style={{ fontSize: "11px", marginTop: "4px" }}>Run a scan to start recording history</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <div style={{ fontSize: "11px", color: C.muted, fontFamily: "var(--font-mono)" }}>
          {history.length} scan{history.length !== 1 ? "s" : ""} stored locally · last 10 kept
        </div>
        <button onClick={onClear} style={{ fontSize: "11px", padding: "4px 10px", cursor: "pointer", color: C.loss }}>
          clear history
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {history.map((entry, i) => {
          const isOpen = expanded === i;
          const ts = new Date(entry.ts).toLocaleString("en-IN", {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          });
          const top = entry.gainers[0];
          const bot = entry.losers[0];
          return (
            <div key={entry.ts} style={{
              background: C.card, border: `0.5px solid ${C.border}`,
              borderRadius: "var(--border-radius-lg)", overflow: "hidden",
            }}>
              <div onClick={() => setExpanded(isOpen ? null : i)} style={{
                padding: "12px 16px", cursor: "pointer", display: "flex",
                alignItems: "center", justifyContent: "space-between",
              }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: C.text }}>
                  {i === 0 ? <span style={{ color: C.infoText, marginRight: "6px" }}>latest ·</span> : null}{ts}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                  {top && (
                    <span style={{ fontSize: "11px", color: C.gain, fontFamily: "var(--font-mono)" }}>
                      ▲ {top.sym} +{top.changePct?.toFixed(2)}%
                    </span>
                  )}
                  {bot && (
                    <span style={{ fontSize: "11px", color: C.loss, fontFamily: "var(--font-mono)" }}>
                      ▼ {bot.sym} {bot.changePct?.toFixed(2)}%
                    </span>
                  )}
                  <span style={{ color: C.hint, fontSize: "14px" }}>{isOpen ? "∧" : "∨"}</span>
                </div>
              </div>
              {isOpen && (
                <div style={{
                  padding: "0 16px 14px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px",
                  borderTop: `0.5px solid ${C.border}`, paddingTop: "10px",
                }}>
                  <div>
                    <div style={{ fontSize: "10px", color: C.hint, marginBottom: "6px", fontFamily: "var(--font-mono)", letterSpacing: "0.08em" }}>
                      TOP GAINERS
                    </div>
                    {entry.gainers.slice(0, 5).map((s, j) => (
                      <div key={s.sym} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                        <span style={{ color: C.muted }}>{j + 1}. {s.sym}</span>
                        <span style={{ color: C.gain }}>+{s.changePct?.toFixed(2)}%</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: "10px", color: C.hint, marginBottom: "6px", fontFamily: "var(--font-mono)", letterSpacing: "0.08em" }}>
                      TOP LOSERS
                    </div>
                    {entry.losers.slice(0, 5).map((s, j) => (
                      <div key={s.sym} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                        <span style={{ color: C.muted }}>{j + 1}. {s.sym}</span>
                        <span style={{ color: C.loss }}>{s.changePct?.toFixed(2)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TabBar({ tab, setTab, gCount, lCount, rankedReady, convictionReady, historyCount }) {
  const tabs = [
    { id: "gainers",    label: "▲ gainers",      color: C.gain,     bg: C.gainBg,  count: gCount },
    { id: "losers",     label: "▼ losers",       color: C.loss,     bg: C.lossBg,  count: lCount },
    { id: "ranked",     label: "◆ ranked",       color: C.infoText, bg: C.infoBg,  count: rankedReady },
    { id: "conviction", label: "◇ open=low/high", color: C.warnText, bg: C.warnBg,  count: convictionReady },
    { id: "history",    label: "⟳ history",      color: C.muted,    bg: C.surface, count: historyCount || null },
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

  // Expiry selector — current and next month only
  const expiryOptions = getMonthlyExpiries();
  const [selectedExpiry, setSelectedExpiry] = useState(expiryOptions[0]);

  // Notification permission
  const [notifPerm, setNotifPerm] = useState("default");
  useEffect(() => {
    if (typeof Notification !== "undefined") setNotifPerm(Notification.permission);
  }, []);

  // Scan history — persisted in localStorage
  const [scanHistory, setScanHistory] = useState([]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("nse_scan_history");
      if (saved) setScanHistory(JSON.parse(saved));
    } catch {}
  }, []);

  function saveHistory(gainedList, lostList) {
    const entry = {
      ts: new Date().toISOString(),
      gainers: gainedList.map(s => ({ sym: s.sym, ltp: s.ltp, changePct: s.changePct })),
      losers:  lostList.map(s  => ({ sym: s.sym, ltp: s.ltp, changePct: s.changePct })),
    };
    setScanHistory(prev => {
      const next = [entry, ...prev].slice(0, 10);
      try { localStorage.setItem("nse_scan_history", JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function clearHistory() {
    setScanHistory([]);
    try { localStorage.removeItem("nse_scan_history"); } catch {}
  }

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
      setGainers(enriched.slice(0, 20));
      setLosers(enriched.slice(-20).reverse());
      setScannedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
      saveHistory(enriched.slice(0, 20), enriched.slice(-20).reverse());
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
        const score = computeConvictionScore(stock, signals, isGainer);
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
    const topG = rGainers[0];
    const topL = rLosers[0];
    sendNotification(
      "Ranked scan complete",
      [
        topG && `Bullish: ${topG.stock.sym} (score ${topG.score})`,
        topL && `Bearish: ${topL.stock.sym} (score ${topL.score})`,
      ].filter(Boolean).join(" · ") || "No signals found"
    );
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
          // Bullish signal: BOTH equity and future have open === day's low
          const equityOpenEqLow = Math.abs(stock.open - stock.low) < 0.01;
          const futureOpenEqLow = Math.abs(futOhlc.open - futOhlc.low) < 0.01;
          if (equityOpenEqLow && futureOpenEqLow) {
            gainerHits.push({ stock, futOhlc });
          }
        } else {
          // Bearish signal: BOTH equity and future have open === day's high
          const equityOpenEqHigh = Math.abs(stock.open - stock.high) < 0.01;
          const futureOpenEqHigh = Math.abs(futOhlc.open - futOhlc.high) < 0.01;
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
      sendNotification(
        "Conviction scan complete",
        [
          gainerHits.length && `${gainerHits.length} bullish (open=low)`,
          loserHits.length  && `${loserHits.length} bearish (open=high)`,
        ].filter(Boolean).join(" · ") || "No conviction signals"
      );
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
            <button
              onClick={() => {
                if (typeof Notification === "undefined") return;
                if (notifPerm === "granted") return;
                Notification.requestPermission().then(p => setNotifPerm(p));
              }}
              title={notifPerm === "granted" ? "Notifications on" : notifPerm === "denied" ? "Notifications blocked in browser" : "Enable notifications"}
              style={{
                fontSize: "13px", padding: "5px 8px", cursor: notifPerm === "denied" ? "not-allowed" : "pointer",
                opacity: notifPerm === "denied" ? 0.4 : 1,
                color: notifPerm === "granted" ? C.gain : C.muted,
              }}
            >{notifPerm === "granted" ? "🔔" : "🔕"}</button>
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
            historyCount={scanHistory.length} />

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

          {/* History tab — past scan results stored in localStorage */}
          {tab === "history" && (
            <HistoryView history={scanHistory} onClear={clearHistory} />
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
