/**
 * Trading Journal — Unified trade + news + market context store.
 *
 * Capabilities:
 * - Full trade lifecycle recording (entry → management → exit)
 * - News context snapshots at trade time
 * - Market condition snapshots (volatility, trend, session)
 * - Query engine: "how did EURUSD perform during NFP days?"
 * - Performance analytics: MAE/MFE, holding time distribution, R:R scatter
 */
import fs from "fs";
import { repoPath } from "./repo-root.js";

const JOURNAL_FILE = repoPath("trading-journal.json");

function load() {
  if (!fs.existsSync(JOURNAL_FILE)) return { entries: [], snapshots: [], analytics: {} };
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")); }
  catch { return { entries: [], snapshots: [], analytics: {} }; }
}

function save(data) { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(data, null, 2)); }

// ─── Record Full Trade Lifecycle ──────────────────────────────────

export function recordJournalEntry({
  ticket, symbol, type, strategyId, session, day,
  volume, entryPrice, sl, tp,
  newsContext = null, marketSnapshot = null,
  exitPrice = null, pnl = null, pnlPct = null, closeReason = null,
  mfe = null, // Maximum Favorable Excursion
  mae = null, // Maximum Adverse Excursion
}) {
  const data = load();
  const now = new Date().toISOString();

  // Check if entry already exists (update) or new
  const existing = data.entries.findIndex((e) => e.ticket === ticket);
  const entry = {
    ticket, symbol, type, strategyId, session, day,
    volume, entryPrice, sl, tp,
    openedAt: existing >= 0 ? data.entries[existing].openedAt : now,
    exitPrice: exitPrice ?? null, pnl: pnl ?? null, pnlPct: pnlPct ?? null,
    closeReason: closeReason ?? null, closedAt: exitPrice ? now : null,
    mfe: mfe ?? null, mae: mae ?? null,
    newsContext: newsContext || null,
    marketSnapshot: marketSnapshot || null,
  };

  if (existing >= 0) {
    data.entries[existing] = entry;
  } else {
    data.entries.push(entry);
  }

  // Keep last 500 entries
  if (data.entries.length > 500) data.entries = data.entries.slice(-500);

  save(data);
  return entry;
}

// ─── Market Snapshot ──────────────────────────────────────────────

export function recordMarketSnapshot({ symbol, atr, trend, rsi, session, newsActive, timestamp = new Date().toISOString() }) {
  const data = load();
  data.snapshots.push({ symbol, atr, trend, rsi, session, newsActive, timestamp });
  if (data.snapshots.length > 200) data.snapshots = data.snapshots.slice(-200);
  save(data);
}

// ─── Query Engine ─────────────────────────────────────────────────

export function queryJournal({ symbol = null, strategyId = null, session = null, day = null, hasNews = null, minTrades = 0, maxResults = 50 }) {
  const data = load();
  let filtered = [...data.entries];

  if (symbol) filtered = filtered.filter((e) => e.symbol === symbol);
  if (strategyId) filtered = filtered.filter((e) => e.strategyId === strategyId);
  if (session) filtered = filtered.filter((e) => e.session === session);
  if (day) filtered = filtered.filter((e) => e.day === day);
  if (hasNews === true) filtered = filtered.filter((e) => e.newsContext != null);
  if (hasNews === false) filtered = filtered.filter((e) => e.newsContext == null);

  if (filtered.length < minTrades) {
    return { results: [], count: 0, message: `Only ${filtered.length} trades match — need ${minTrades} minimum.` };
  }

  const wins = filtered.filter((e) => (e.pnl || 0) > 0).length;
  const totalPnl = filtered.reduce((s, e) => s + (e.pnl || 0), 0);
  const avgHoldMin = filtered.filter((e) => e.closedAt).length > 0
    ? filtered.filter((e) => e.closedAt).reduce((s, e) => Math.round((new Date(e.closedAt) - new Date(e.openedAt)) / 60000), 0) / filtered.filter((e) => e.closedAt).length
    : null;
  const avgMfe = filtered.filter((e) => e.mfe != null).reduce((s, e) => s + e.mfe, 0) / (filtered.filter((e) => e.mfe != null).length || 1);
  const avgMae = filtered.filter((e) => e.mae != null).reduce((s, e) => s + e.mae, 0) / (filtered.filter((e) => e.mae != null).length || 1);

  return {
    results: filtered.slice(-maxResults),
    count: filtered.length,
    stats: {
      winRate: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      wins,
      losses: filtered.length - wins,
      avgHoldMinutes: avgHoldMin ? Math.round(avgHoldMin) : null,
      avgMfe: avgMfe ? Math.round(avgMfe * 100) / 100 : null,
      avgMae: avgMae ? Math.round(avgMae * 100) / 100 : null,
      mfeMaeRatio: avgMae > 0 ? Math.round((avgMfe / avgMae) * 100) / 100 : null,
    },
  };
}

// ─── Analytics ────────────────────────────────────────────────────

export function getJournalAnalytics() {
  const data = load();
  const closed = data.entries.filter((e) => e.pnl != null);
  if (closed.length === 0) return { message: "No closed trades yet." };

  // Win rate by session
  const bySession = {};
  for (const e of closed) {
    const s = e.session || "unknown";
    if (!bySession[s]) bySession[s] = { trades: 0, wins: 0, totalPnl: 0 };
    bySession[s].trades++; if ((e.pnl || 0) > 0) bySession[s].wins++; bySession[s].totalPnl += (e.pnl || 0);
  }

  // Win rate by strategy
  const byStrategy = {};
  for (const e of closed) {
    const s = e.strategyId || "manual";
    if (!byStrategy[s]) byStrategy[s] = { trades: 0, wins: 0, totalPnl: 0 };
    byStrategy[s].trades++; if ((e.pnl || 0) > 0) byStrategy[s].wins++; byStrategy[s].totalPnl += (e.pnl || 0);
  }

  // Win rate on news days vs non-news
  const newsTrades = closed.filter((e) => e.newsContext != null);
  const nonNewsTrades = closed.filter((e) => e.newsContext == null);

  // Distribution: what close reasons appear most?
  const closeReasons = {};
  for (const e of closed) {
    const reason = e.closeReason || "unknown";
    closeReasons[reason] = (closeReasons[reason] || 0) + 1;
  }

  // Top-performing pairs
  const byPair = {};
  for (const e of closed) {
    const s = e.symbol;
    if (!byPair[s]) byPair[s] = { trades: 0, wins: 0, totalPnl: 0, bestPnl: -Infinity, worstPnl: Infinity };
    byPair[s].trades++; if ((e.pnl || 0) > 0) byPair[s].wins++; byPair[s].totalPnl += (e.pnl || 0);
    byPair[s].bestPnl = Math.max(byPair[s].bestPnl, e.pnl || 0);
    byPair[s].worstPnl = Math.min(byPair[s].worstPnl, e.pnl || 0);
  }

  const overallWR = closed.length > 0 ? Math.round((closed.filter((e) => (e.pnl || 0) > 0).length / closed.length) * 100) : 0;
  const overallPnl = Math.round(closed.reduce((s, e) => s + (e.pnl || 0), 0) * 100) / 100;

  return {
    totalClosedTrades: closed.length,
    overallWinRate: overallWR,
    overallPnl,
    bySession: Object.entries(bySession).map(([s, st]) => ({ session: s, ...st, winRate: st.trades > 0 ? Math.round((st.wins / st.trades) * 100) : 0 })),
    byStrategy: Object.entries(byStrategy).map(([s, st]) => ({ strategy: s, ...st, winRate: st.trades > 0 ? Math.round((st.wins / st.trades) * 100) : 0 })),
    byPair: Object.entries(byPair).map(([s, st]) => ({ pair: s, ...st, winRate: st.trades > 0 ? Math.round((st.wins / st.trades) * 100) : 0 })),
    newsDays: { trades: newsTrades.length, winRate: newsTrades.length > 0 ? Math.round((newsTrades.filter((e) => (e.pnl || 0) > 0).length / newsTrades.length) * 100) : 0, totalPnl: Math.round(newsTrades.reduce((s, e) => s + (e.pnl || 0), 0) * 100) / 100 },
    nonNewsDays: { trades: nonNewsTrades.length, winRate: nonNewsTrades.length > 0 ? Math.round((nonNewsTrades.filter((e) => (e.pnl || 0) > 0).length / nonNewsTrades.length) * 100) : 0, totalPnl: Math.round(nonNewsTrades.reduce((s, e) => s + (e.pnl || 0), 0) * 100) / 100 },
    closeReasons: Object.entries(closeReasons).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

// ─── Snapshot Query ───────────────────────────────────────────────

export function getRecentSnapshots(symbol = null, limit = 20) {
  const data = load();
  let snaps = [...data.snapshots];
  if (symbol) snaps = snaps.filter((s) => s.symbol === symbol);
  return snaps.slice(-limit);
}
