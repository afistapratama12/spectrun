import { get, getDefaultAccountId } from "./client.js";
import { log } from "../logger.js";

const DRY_RUN_MODE = process.env.DRY_RUN === "true" && (!process.env.TRADELOCKER_EMAIL || !process.env.TRADELOCKER_PASSWORD);

function dummyAccount() {
  return {
    accountId: "dry-run-demo",
    balance: 100_000,
    equity: 100_000,
    margin: 0,
    freeMargin: 100_000,
    marginLevel: 0,
    profit: 0,
    currency: "USD",
    leverage: 100,
    isDemo: true,
  };
}

/**
 * Get full account status. Returns dummy data in dry-run mode without credentials.
 */
export async function getAccountStatus() {
  if (DRY_RUN_MODE) return dummyAccount();

  const accountId = await getDefaultAccountId();
  const accounts = await get("/v1/accounts");

  const account = accounts.find((a) => (a.id || a.accountId) === accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);

  return {
    accountId,
    balance: parseFloat(account.balance ?? 0),
    equity: parseFloat(account.equity ?? 0),
    margin: parseFloat(account.margin ?? 0),
    freeMargin: parseFloat(account.freeMargin ?? account.free_margin ?? 0),
    marginLevel: parseFloat(account.marginLevel ?? account.margin_level ?? 0),
    profit: parseFloat(account.profit ?? account.pl ?? 0),
    currency: account.currency || "USD",
    leverage: account.leverage || 100,
    isDemo: account.isDemo ?? true,
  };
}

/**
 * Get all open positions from TradeLocker.
 */
export async function getOpenPositions() {
  if (DRY_RUN_MODE) return [];

  try {
    const accountId = await getDefaultAccountId();
    const data = await get(`/v1/trade/accounts/${accountId}/positions`);
    const positions = Array.isArray(data) ? data : (data?.positions || data?.data || []);

    return positions.map((p) => ({
      id: p.id || p.positionId,
      ticket: p.ticket || p.id,
      symbol: p.symbol || p.instrument,
      type: (p.type || p.direction || "").toLowerCase(),
      volume: parseFloat(p.volume || p.lots || 0),
      openPrice: parseFloat(p.openPrice || p.open_price || p.entryPrice || 0),
      currentPrice: parseFloat(p.currentPrice || p.current_price || p.markPrice || 0),
      sl: parseFloat(p.sl || p.stopLoss || p.stop_loss || 0) || null,
      tp: parseFloat(p.tp || p.takeProfit || p.take_profit || 0) || null,
      profit: parseFloat(p.profit || p.pl || p.pnl || 0),
      profitPct: parseFloat(p.profitPct || p.pnlPct || 0),
      swap: parseFloat(p.swap || p.commission || 0),
      openTime: p.openTime || p.open_time || p.createdAt,
      comment: p.comment || "",
    }));
  } catch (error) {
    log("tradelocker_warn", `getOpenPositions failed: ${error.message}`);
    return [];
  }
}

/**
 * Get pending orders.
 */
export async function getPendingOrders() {
  try {
    const accountId = await getDefaultAccountId();
    const data = await get(`/v1/trade/accounts/${accountId}/orders`);
    return Array.isArray(data) ? data : (data?.orders || []);
  } catch (error) {
    log("tradelocker_warn", `getPendingOrders failed: ${error.message}`);
    return [];
  }
}

/**
 * Get today's closed trades. Returns empty array in dry-run mode.
 */
export async function getTodayClosedTrades() {
  if (DRY_RUN_MODE) return [];

  try {
    const accountId = await getDefaultAccountId();
    const today = new Date().toISOString().slice(0, 10);
    const data = await get(`/v1/trade/accounts/${accountId}/history`, {
      from: `${today}T00:00:00Z`,
      to: new Date().toISOString(),
    });
    const trades = Array.isArray(data) ? data : (data?.trades || data?.history || []);
    return trades.filter((t) => t.closed || t.closeTime);
  } catch (error) {
    log("tradelocker_warn", `getTodayClosedTrades failed: ${error.message}`);
    return [];
  }
}
