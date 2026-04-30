import { gunzipSync } from "zlib";

const INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 60 * 1000;

export async function GET() {
  try {
    const now = Date.now();
    if (cache && (now - cacheAt) < CACHE_MS) {
      return Response.json({ ...cache, cached: true });
    }

    const res = await fetch(INSTRUMENTS_URL);
    if (!res.ok) {
      return Response.json({ error: `Failed to fetch instruments: HTTP ${res.status}` }, { status: 502 });
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const jsonText = gunzipSync(buffer).toString("utf-8");
    const instruments = JSON.parse(jsonText);

    const stocksMap = new Map();
    const futures = {};

    for (const inst of instruments) {
      if (
        inst.segment === "NSE_FO" &&
        (inst.instrument_type === "CE" || inst.instrument_type === "PE") &&
        inst.underlying_type === "EQUITY" &&
        inst.underlying_key && inst.underlying_symbol
      ) {
        if (!stocksMap.has(inst.underlying_key)) {
          stocksMap.set(inst.underlying_key, { sym: inst.underlying_symbol, key: inst.underlying_key });
        }
      }

      if (
        inst.segment === "NSE_FO" &&
        inst.instrument_type === "FUT" &&
        inst.underlying_type === "EQUITY" &&
        inst.underlying_key && inst.expiry && inst.instrument_key
      ) {
        const expiryMonth = inst.expiry.slice(0, 7);
        const key = `${inst.underlying_key}|${expiryMonth}`;
        if (!futures[key] || inst.expiry > futures[key].expiry) {
          futures[key] = {
            instrumentKey: inst.instrument_key,
            expiry: inst.expiry,
            tradingSymbol: inst.trading_symbol,
          };
        }
      }
    }

    const stocks = Array.from(stocksMap.values()).sort((a, b) => a.sym.localeCompare(b.sym));
    cache = { stocks, futures, count: stocks.length };
    cacheAt = now;

    return Response.json({ ...cache, cached: false });
  } catch (err) {
    return Response.json({ error: `Universe fetch failed: ${err.message}` }, { status: 500 });
  }
}