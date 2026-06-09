/**
 * Consistency Tracker — per-strategy performance tracking for prop-firm compliance.
 *
 * Tracks:
 * - Rolling 20-trade win rate per strategy
 * - Average R:R per strategy
 * - Profit factor per strategy
 * - Daily P&L contribution per strategy (for consistency rule)
 * - Overall blended consistency score
 */
import fs from "fs";
import { repoPath } from "./repo-root.js";
import { getStrategiesByType, getStrategy } from "./strategies/index.js";
import { getPerformanceHistory } from "./lessons.js";

const CONSISTENCY_FILE = repoPath("consistency.json");

function load() {
  if (!fs.existsSync(CONSISTENCY_FILE)) {
    return {
      byStrategy: {},
      dailyContributions: {},
      rollingStats: {},
    };
  }
  try {
    return JSON.parse(fs.readFileSync(CONSISTENCY_FILE, "utf8"));
  } catch {
    return { byStrategy: {}, dailyContributions: {}, rollingStats: {} };
  }
}

function save(data) {
  fs.writeFileSync(CONSISTENCY_FILE, JSON.stringify(data, null, 2));
}

// ─── Record trade in consistency tracker ──────────────────────────

export function recordTradeForConsistency({ strategyId, ticket, symbol, type, pnl, pnlPct, riskReward, win }) {
  const data = load();

  if (!data.byStrategy[strategyId]) {
    data.byStrategy[strategyId] = {
      trades: [],
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      totalRR: 0,
      bestPair: null,
      worstPair: null,
    };
  }

  const stats = data.byStrategy[strategyId];
  stats.trades.push({ ticket, symbol, type, pnl, pnlPct, riskReward, win, at: new Date().toISOString() });
  stats.totalTrades++;
  if (win) stats.wins++;
  else stats.losses++;
  stats.totalPnl += pnl;
  if (riskReward) stats.totalRR += riskReward;

  // Keep only last 50 trades
  if (stats.trades.length > 50) {
    stats.trades = stats.trades.slice(-50);
  }

  save(data);
}

// ─── Rolling 20-trade consistency score ───────────────────────────

export function getConsistencyReport() {
  const data = load();
  const perf = getPerformanceHistory({ hours: 720, limit: 100 }); // 30 days

  const report = {
    overall: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgRR: 0,
      profitFactor: 0,
      consistencyScore: 0,
      meetsMinimum: false,
    },
    byStrategy: {},
    dailyBreakdown: [],
    recommendations: [],
  };

  let allPnl = 0;
  let allRR = 0;
  let allRrCount = 0;
  const byDay = {};

  // Process all trades
  const allTrades = perf?.trades || [];
  for (const trade of allTrades) {
    // Daily grouping
    const day = (trade.closedAt || trade.recordedAt || "").slice(0, 10);
    if (!byDay[day]) byDay[day] = { day, pnl: 0, trades: 0, wins: 0, losses: 0 };
    byDay[day].pnl += trade.pnl || 0;
    byDay[day].trades++;
    if ((trade.pnl || 0) > 0) byDay[day].wins++;
    else byDay[day].losses++;
  }

  // Per-strategy stats from consistency tracker
  for (const [id, stats] of Object.entries(data.byStrategy)) {
    const strategy = getStrategy(id);
    const trades = stats.trades.slice(-20); // rolling 20
    const wins = trades.filter((t) => t.win).length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgRR = stats.totalTrades > 0 ? stats.totalRR / stats.totalTrades : 0;

    const profitFactor = trades
      .reduce((s, t) => {
        if ((t.pnl || 0) > 0) return s + (t.pnl || 0);
        return s - (t.pnl || 0);
      }, 0) / (trades
        .filter((t) => (t.pnl || 0) < 0)
        .reduce((s, t) => s + Math.abs(t.pnl || 0), 0.01));

    report.byStrategy[id] = {
      name: strategy?.name || id,
      type: strategy?.type || "unknown",
      rolling20Wins: wins,
      rolling20Total: trades.length,
      rolling20WinRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalTrades: stats.totalTrades,
      totalWins: stats.wins,
      totalLosses: stats.losses,
      lifetimeWinRate: stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0,
      avgRR: Math.round(avgRR * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      totalPnl: Math.round(stats.totalPnl * 100) / 100,
    };

    allPnl += stats.totalPnl;
    allRR += stats.totalRR;
    allRrCount += stats.totalTrades;
  }

  // Overall stats
  report.overall.totalTrades = allTrades.length;
  report.overall.wins = allTrades.filter((t) => (t.pnl || 0) > 0).length;
  report.overall.losses = allTrades.filter((t) => (t.pnl || 0) <= 0).length;
  report.overall.winRate = allTrades.length > 0
    ? (report.overall.wins / allTrades.length) * 100 : 0;
  report.overall.avgRR = allRrCount > 0 ? Math.round((allRR / allRrCount) * 100) / 100 : 0;

  // Consistency score: weighted blend of win rate + R:R stability
  const wrScore = Math.min(report.overall.winRate / 50, 1.0) * 50; // 50% from win rate
  const rrScore = Math.min(report.overall.avgRR / 2.5, 1.0) * 30; // 30% from R:R
  const stabilityScore = getStabilityScore(report) * 20;            // 20% from stability

  report.overall.consistencyScore = Math.round(wrScore + rrScore + stabilityScore);
  report.overall.meetsMinimum = report.overall.consistencyScore >= 40;

  // Daily breakdown
  report.dailyBreakdown = Object.values(byDay)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({
      ...d,
      winRate: d.trades > 0 ? Math.round((d.wins / d.trades) * 100) : 0,
    }));

  // Recommendations
  if (!report.overall.meetsMinimum) {
    report.recommendations.push("⚠️ Consistency score below 40% minimum — reduce risk per trade, increase selectivity");
    if (report.overall.winRate < 35) {
      report.recommendations.push("Low win rate — consider switching to higher-probability strategies (reversals, S/R bounces)");
    }
    if (report.overall.avgRR < 1.5) {
      report.recommendations.push("Low R:R — widen take profits or tighten stop losses");
    }
  }

  // Strategy-specific recommendations
  for (const [id, stats] of Object.entries(report.byStrategy)) {
    if (stats.totalTrades >= 5 && stats.lifetimeWinRate < 35) {
      report.recommendations.push(`${stats.name}: win rate ${Math.round(stats.lifetimeWinRate)}% — consider pausing or reducing allocation`);
    }
    if (stats.totalTrades >= 5 && stats.profitFactor < 1.2) {
      report.recommendations.push(`${stats.name}: profit factor ${stats.profitFactor} — review entry conditions`);
    }
  }

  return report;
}

function getStabilityScore(report) {
  // Check if daily P&L is consistent (no huge swings)
  const dailies = report.dailyBreakdown;
  if (dailies.length < 3) return 0.5;

  const pnls = dailies.map((d) => d.pnl);
  const avg = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const variance = pnls.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / pnls.length;
  const stdDev = Math.sqrt(variance);

  // Lower stdDev = more consistent
  const avgAbs = dailies.reduce((s, d) => s + Math.abs(d.pnl), 0) / dailies.length;
  const cv = avgAbs > 0 ? stdDev / avgAbs : 10;

  return Math.max(0, Math.min(1, 1 - cv));
}

// ─── Check consistency for current day ────────────────────────────

export function checkDailyConsistency({ strategyId, projectedPnl }) {
  const data = load();
  const today = new Date().toISOString().slice(0, 10);

  // Get today's P&L breakdown
  const todayTrades = Object.values(data.byStrategy).flatMap((s) =>
    (s.trades || []).filter((t) => (t.at || "").startsWith(today))
  );

  const todayTotalPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const projectedTotal = todayTotalPnl + (projectedPnl || 0);

  // Contribution check: would this trade make today > 40% of total challenge profit?
  const challengeTotalPnl = Object.values(data.byStrategy).reduce(
    (s, st) => s + st.totalPnl, 0
  ) + todayTotalPnl;

  const todayContribution = projectedTotal > 0 && challengeTotalPnl > 0
    ? (projectedTotal / challengeTotalPnl) * 100
    : 0;

  return {
    todayPnl: todayTotalPnl,
    projectedPnl: projectedPnl || 0,
    projectedTotal,
    todayContributionPct: Math.round(todayContribution * 10) / 10,
    violatesConsistency: todayContribution > 40, // > 40% of total profit from one day
    recommendation: todayContribution > 40
      ? "This trade would push today's profit beyond 40% of total challenge profit — consider reducing size or waiting"
      : null,
  };
}

// ─── Strategy rotation — ensure diverse strategy usage ────────────

export function getStrategyUsageReport() {
  const data = load();
  const entries = Object.entries(data.byStrategy);

  if (entries.length === 0) {
    return { diversity: 0, overused: [], underused: [], recommendation: "No trades yet — use a mix of intraday + swing strategies." };
  }

  const totalTrades = entries.reduce((s, [, st]) => s + st.totalTrades, 0);
  const byType = { intraday: 0, swing: 0 };

  for (const [id, stats] of entries) {
    const strategy = getStrategy(id);
    const type = strategy?.type || "intraday";
    byType[type] = (byType[type] || 0) + stats.totalTrades;
  }

  const intradayPct = totalTrades > 0 ? (byType.intraday / totalTrades) * 100 : 0;
  const swingPct = totalTrades > 0 ? (byType.swing / totalTrades) * 100 : 0;

  const overused = [];
  const underused = [];

  if (intradayPct > 80) {
    overused.push("intraday");
    underused.push("swing — add swing trades for higher R:R and consistency buffer");
  }
  if (swingPct > 80) {
    overused.push("swing");
    underused.push("intraday — add intraday trades for volume and win rate stability");
  }

  return {
    diversity: Math.min(intradayPct, swingPct) > 20 ? "balanced" : "imbalanced",
    intradayPct: Math.round(intradayPct),
    swingPct: Math.round(swingPct),
    overused,
    underused,
    recommendation: underused.length > 0
      ? `Portfolio is ${intradayPct}% intraday / ${swingPct}% swing. Increase ${underused.join(", ")}.`
      : "Strategy mix is well-balanced.",
  };
}
