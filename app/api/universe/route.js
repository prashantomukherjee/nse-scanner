// Server-side: fetches the NSE instruments file from Upstox CDN,
// decompresses it, and returns:
//  1. The list of NSE F&O underlying stocks (~210)
//  2. A map of underlying_key|YYYY-MM → futures instrument_key (for matching equity to futures)

import { gunzipSync } from "zlib";

const INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 60 * 1000; // 1 hour

export async function GET() {
  try {
    const now = Date.now();
    if (cache && (now - cacheAt) < CACHE_MS) {
      return Response.json({ ...cache, cached: true });
    }

    const res = await fetch(INSTRUMENTS_URL);
    if (!res.ok) {
      return Response.json(
        { error: `Failed to fetch instruments: HTTP ${res.status}` },
        { status: 502 }
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const jsonText = gunzipSync(buffer).toString("utf-8");
    const instruments = JSON.parse(jsonText);

    // 1. Equity universe — unique underlying stocks that have options
    const stocksMap = new Map();
    // 2. Futures map — keyed as `underlyingKey|YYYY-MM` → { instrumentKey, expiry, tradingSymbol }
    const futures = {};

    for (const inst of instruments) {
      // Equity options → derive the F&O stock universe
      if (
        inst.segment === "NSE_FO" &&
        (inst.instrument_type === "CE" || inst.instrument_type === "PE") &&
        inst.underlying_type === "EQUITY" &&
        inst.underlying_key &&
        inst.underlying_symbol
      ) {
        if (!stocksMap.has(inst.underlying_key)) {
          stocksMap.set(inst.underlying_key, {
            sym: inst.underlying_symbol,
            key: inst.underlying_key,
          });
        }
      }

      // Stock futures → build lookup by underlying + expiry month
      if (
        inst.segment === "NSE_FO" &&
        inst.instrument_type === "FUT" &&
        inst.underlying_type === "EQUITY" &&
        inst.underlying_key &&
        inst.expiry &&
        inst.instrument_key
      ) {
        // Upstox sometimes returns expiry as a Unix timestamp (number) instead of ISO string.
        // Normalize to "YYYY-MM-DD" string regardless.
        const expiryStr = typeof inst.expiry === "number"
          ? new Date(inst.expiry).toISOString().slice(0, 10)
          : String(inst.expiry).slice(0, 10);

        const expiryMonth = expiryStr.slice(0, 7); // YYYY-MM
        const key = `${inst.underlying_key}|${expiryMonth}`;
        if (!futures[key] || expiryStr > futures[key].expiry) {
          futures[key] = {
            instrumentKey: inst.instrument_key,
            expiry: expiryStr,
            tradingSymbol: inst.trading_symbol,
          };
        }
      }
    }

    const stocks = Array.from(stocksMap.values()).sort((a, b) =>
      a.sym.localeCompare(b.sym)
    );

    cache = { stocks, futures, count: stocks.length };
    cacheAt = now;

    return Response.json({ ...cache, cached: false });
  } catch (err) {
    return Response.json(
      { error: `Universe fetch failed: ${err.message}` },
      { status: 500 }
    );
  }
}
