// Server-side: fetches the NSE instruments file from Upstox CDN,
// decompresses it, and returns just the NSE F&O underlying stocks (~200).
//
// Runs server-side because:
// 1. The file is gzipped — needs zlib (Node-only)
// 2. Cross-origin: assets.upstox.com may not allow browser fetches
// 3. The full file is large; we filter down to ~200 stocks before returning

import { gunzipSync } from "zlib";

const INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

// Cache for 1 hour — instruments only change once a day
let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 60 * 1000;

export async function GET() {
  try {
    const now = Date.now();
    if (cache && (now - cacheAt) < CACHE_MS) {
      return Response.json({ stocks: cache, count: cache.length, cached: true });
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

    // Filter: pick unique underlying stocks that have F&O contracts
    const seen = new Map();
    for (const inst of instruments) {
      if (
        inst.segment === "NSE_FO" &&
        (inst.instrument_type === "CE" || inst.instrument_type === "PE") &&
        inst.underlying_type === "EQUITY" &&
        inst.underlying_key &&
        inst.underlying_symbol
      ) {
        if (!seen.has(inst.underlying_key)) {
          seen.set(inst.underlying_key, {
            sym: inst.underlying_symbol,
            key: inst.underlying_key,
          });
        }
      }
    }

    const stocks = Array.from(seen.values()).sort((a, b) =>
      a.sym.localeCompare(b.sym)
    );

    cache = stocks;
    cacheAt = now;

    return Response.json({ stocks, count: stocks.length, cached: false });
  } catch (err) {
    return Response.json(
      { error: `Universe fetch failed: ${err.message}` },
      { status: 500 }
    );
  }
}
