import { get, getDefaultAccountId } from "./client.js";
import { log } from "../logger.js";

const DRY_RUN_MODE = process.env.DRY_RUN === "true" && (!process.env.TRADELOCKER_EMAIL || !process.env.TRADELOCKER_PASSWORD);

function generateSyntheticOHLCV(symbol, resolution, count = 100) {
  const now = Date.now();
  const minutesMap = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1D": 1440 };
  const interval = minutesMap[resolution] || 60;
  const candles = [];

  // Base price per symbol
  const basePrices = {
    EURUSD: 1.0850, GBPUSD: 1.2650, USDJPY: 151.50, AUDUSD: 0.6550,
    USDCAD: 1.3580, NZDUSD: 0.5950, EURGBP: 0.8570, EURJPY: 164.20,
  };
  let price = basePrices[symbol] || 1.1000;
  const volatility = symbol.includes("JPY") ? 0.15 : 0.0008;

  for (let i = count; i >= 0; i--) {
    const t = now - i * interval * 60_000;
    const change = (Math.random() - 0.48) * volatility * 2;
    price += change;
    const o = price;
    const c = price + (Math.random() - 0.5) * volatility;
    const h = Math.max(o, c) + Math.random() * volatility * 0.5;
    const l = Math.min(o, c) - Math.random() * volatility * 0.5;

    candles.push({
      time: new Date(t).toISOString(),
      open: Math.round(o * 100000) / 100000,
      high: Math.round(h * 100000) / 100000,
      low: Math.round(l * 100000) / 100000,
      close: Math.round(c * 100000) / 100000,
      volume: Math.floor(Math.random() * 10000) + 5000,
    });
  }
  return candles;
}

/**
 * Get OHLCV candlestick data for a symbol.
 * Returns synthetic data in dry-run mode without credentials.
 */
export async function getOHLCV({ symbol, resolution = "1h", from, to, count = 100 }) {
  if (DRY_RUN_MODE) return generateSyntheticOHLCV(symbol, resolution, count);

  try {
    const accountId = await getDefaultAccountId();
    const params = { symbol, resolution, count };

    if (from) {
      params.from = typeof from === "number" ? from : Math.floor(new Date(from).getTime() / 1000);
      delete params.count;
    }
    if (to) {
      params.to = typeof to === "number" ? to : Math.floor(new Date(to).getTime() / 1000);
    }

    const data = await get(`/v1/trade/accounts/${accountId}/history`, params);

    const candles = Array.isArray(data?.bars) ? data.bars
      : Array.isArray(data?.candles) ? data.candles
      : Array.isArray(data) ? data
      : [];

    return candles.map((c) => ({
      time: new Date((c.t || c.time || c.timestamp) * 1000).toISOString(),
      open: parseFloat(c.o || c.open),
      high: parseFloat(c.h || c.high),
      low: parseFloat(c.l || c.low),
      close: parseFloat(c.c || c.close),
      volume: parseFloat(c.v || c.volume || 0),
    }));
  } catch (error) {
    log("market_data_warn", `getOHLCV failed for ${symbol}: ${error.message}`);
    return [];
  }
}

/**
 * Get instrument specifications (pip value, contract size, spread, etc.).
 */
export async function getInstrumentSpecs(symbol = null) {
  try {
    const instruments = await get("/v1/instruments");
    const list = Array.isArray(instruments) ? instruments : (instruments?.instruments || []);

    const specs = list.map((inst) => ({
      symbol: inst.symbol || inst.name,
      pipSize: parseFloat(inst.pipSize || inst.pip_size || inst.tickSize || 0.0001),
      pipValue: parseFloat(inst.pipValue || inst.pip_value || 10),
      contractSize: parseFloat(inst.contractSize || inst.contract_size || 100000),
      minVolume: parseFloat(inst.minVolume || inst.min_volume || 0.01),
      maxVolume: parseFloat(inst.maxVolume || inst.max_volume || 100),
      stepVolume: parseFloat(inst.stepVolume || inst.step_volume || 0.01),
      spread: parseFloat(inst.spread || 0),
      digits: parseInt(inst.digits || inst.precision || 5, 10),
      swapLong: parseFloat(inst.swapLong || inst.swap_long || 0),
      swapShort: parseFloat(inst.swapShort || inst.swap_short || 0),
      tradingHours: inst.tradingHours || inst.trading_hours || "24/5",
    }));

    if (symbol) return specs.find((s) => s.symbol === symbol) || null;
    return specs;
  } catch (error) {
    log("market_data_warn", `getInstrumentSpecs failed: ${error.message}`);
    return symbol ? null : [];
  }
}

/**
 * Get pip value for a symbol. Falls back to standard forex pip values if API fails.
 */
export async function getPipValue(symbol, lotSize = 1.0) {
  const spec = await getInstrumentSpecs(symbol);
  if (spec) return spec.pipValue * lotSize;

  // Standard forex pip values per standard lot
  const standardPipValues = {
    EURUSD: 10, GBPUSD: 10, AUDUSD: 10, NZDUSD: 10,
    USDCAD: 7.3, USDCHF: 9, USDJPY: 8.5,
    EURGBP: 13, EURJPY: 8.5, GBPJPY: 8.5,
  };
  return (standardPipValues[symbol.replace(/[^A-Z]/g, "")] || 10) * lotSize;
}

/**
 * Calculate ATR (Average True Range) from OHLCV data.
 */
export function calculateATR(candles, period = 14) {
  if (candles.length < 2) return 0;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  if (trueRanges.length === 0) return 0;
  const sum = trueRanges.slice(-Math.min(period, trueRanges.length)).reduce((a, b) => a + b, 0);
  return sum / Math.min(period, trueRanges.length);
}

/**
 * Calculate EMA from an array of values.
 */
export function calculateEMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Calculate RSI from an array of values.
 */
export function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return 50;

  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Determine current trend direction from multiple EMA values.
 * Returns "bullish", "bearish", or "neutral".
 */
export function determineTrend(candles) {
  if (candles.length < 50) return "neutral";
  const closes = candles.map((c) => c.close);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const price = closes[closes.length - 1];

  if (price > ema20 && ema20 > ema50) return "bullish";
  if (price < ema20 && ema20 < ema50) return "bearish";
  return "neutral";
}
