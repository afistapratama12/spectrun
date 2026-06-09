/**
 * Advanced Learning System — Pattern Detection + Rich Lesson Engine
 *
 * Capabilities:
 * - Session-based win rate per pair per strategy
 * - News day impact detection (which events hurt/help which pairs)
 * - Auto-pause underperforming strategies (win rate < 30% over 10+ trades)
 * - Strategy-level recommendation engine
 * - Multi-timeframe lesson derivation (single trade → daily → weekly patterns)
 * - Confidence-weighted lesson ranking
 */
import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { getActiveSession } from "./strategies/index.js";
import { getHighImpactEvents } from "./news.js";

const LESSONS_FILE = repoPath("lessons.json");
const MEMORY_FILE = repoPath("trading-memory.json");

// ─── Persistence ──────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(LESSONS_FILE)) return { lessons: [], performance: [], patterns: {}, pausedStrategies: [] };
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); }
  catch { return { lessons: [], performance: [], patterns: {}, pausedStrategies: [] }; }
}

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return { byPair: {}, bySession: {}, byDay: {}, byNewsDay: {}, strategyStats: {} };
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")); }
  catch { return { byPair: {}, bySession: {}, byDay: {}, byNewsDay: {}, strategyStats: {} }; }
}

function save(data) { fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2)); }
function saveMemory(m) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2)); }

// ─── Record Trade Performance (Enhanced) ──────────────────────────

export async function recordPerformance(perf) {
  const data = load();
  const memory = loadMemory();
  const session = perf.session || getActiveSession();
  const day = new Date().toISOString().slice(0, 10);
  const dateKey = new Date().toISOString();

  const pnl = perf.pnl ?? perf.profit ?? 0;
  const win = pnl > 0;
  const symbol = perf.symbol || "UNKNOWN";
  const strategyId = perf.strategyId || "manual";

  // ── Record base performance ─────────────────────────────────────
  const entry = {
    ticket: perf.ticket || `trade_${Date.now()}`,
    symbol,
    type: perf.type,
    strategyId,
    volume: perf.volume,
    pnl, pnlPct: perf.pnlPct ?? 0,
    riskReward: perf.tpPips && perf.slPips ? perf.tpPips / perf.slPips : null,
    slPips: perf.slPips || null, tpPips: perf.tpPips || null,
    holdMinutes: perf.holdMinutes ?? null,
    session,
    day,
    trend: perf.trend || null,
    reason: perf.reason || null,
    hadNews: !!perf.newsContext,
    closedAt: perf.closedAt || dateKey,
    recordedAt: dateKey,
  };

  data.performance.push(entry);

  // ── Update per-pair memory ──────────────────────────────────────
  if (!memory.byPair[symbol]) memory.byPair[symbol] = { trades: 0, wins: 0, totalPnl: 0, bySession: {}, byStrategy: {} };
  const pair = memory.byPair[symbol];
  pair.trades++; if (win) pair.wins++; pair.totalPnl += pnl;

  if (!pair.bySession[session]) pair.bySession[session] = { trades: 0, wins: 0, totalPnl: 0 };
  pair.bySession[session].trades++; if (win) pair.bySession[session].wins++; pair.bySession[session].totalPnl += pnl;

  if (!pair.byStrategy[strategyId]) pair.byStrategy[strategyId] = { trades: 0, wins: 0, totalPnl: 0 };
  pair.byStrategy[strategyId].trades++; if (win) pair.byStrategy[strategyId].wins++; pair.byStrategy[strategyId].totalPnl += pnl;

  // ── Update per-session memory ───────────────────────────────────
  if (!memory.bySession[session]) memory.bySession[session] = { trades: 0, wins: 0, totalPnl: 0 };
  memory.bySession[session].trades++; if (win) memory.bySession[session].wins++; memory.bySession[session].totalPnl += pnl;

  // ── Update per-day memory ───────────────────────────────────────
  if (!memory.byDay[day]) memory.byDay[day] = { trades: 0, wins: 0, totalPnl: 0 };
  memory.byDay[day].trades++; if (win) memory.byDay[day].wins++; memory.byDay[day].totalPnl += pnl;

  // ── Update news day impact ──────────────────────────────────────
  if (perf.newsContext) {
    const newsKey = `${symbol}:${perf.newsContext}`;
    if (!memory.byNewsDay[newsKey]) memory.byNewsDay[newsKey] = { trades: 0, wins: 0, totalPnl: 0, avgPipMove: 0 };
    memory.byNewsDay[newsKey].trades++; if (win) memory.byNewsDay[newsKey].wins++; memory.byNewsDay[newsKey].totalPnl += pnl;
  }

  // ── Update strategy stats ───────────────────────────────────────
  if (strategyId !== "manual") {
    if (!memory.strategyStats[strategyId]) memory.strategyStats[strategyId] = { trades: 0, wins: 0, totalPnl: 0, last10Results: [] };
    const ss = memory.strategyStats[strategyId];
    ss.trades++; if (win) ss.wins++; ss.totalPnl += pnl;
    ss.last10Results.push({ win, pnl, day, session });
    if (ss.last10Results.length > 10) ss.last10Results = ss.last10Results.slice(-10);
  }

  saveMemory(memory);

  // ── Derive rich lessons ─────────────────────────────────────────
  const lessons = deriveRichLessons(entry, data, memory);
  for (const lesson of lessons) {
    data.lessons.push(lesson);
    log("lessons", `Pattern: ${lesson.pattern} | ${lesson.rule.slice(0, 80)}`);
  }

  // ── Check for strategy auto-pause ───────────────────────────────
  checkAutoPauseStrategies(data, memory);

  save(data);
  return entry;
}

// ─── Rich Lesson Derivation ───────────────────────────────────────

function deriveRichLessons(perf, data, memory) {
  const lessons = [];
  const win = perf.pnl > 0;
  const symbol = perf.symbol;
  const session = perf.session;
  const strategyId = perf.strategyId;
  const pnlPct = perf.pnlPct ?? 0;

  // 1. Session-specific pattern
  const pairSession = memory.byPair[symbol]?.bySession[session];
  if (pairSession && pairSession.trades >= 3) {
    const wr = (pairSession.wins / pairSession.trades) * 100;
    if (wr >= 70 && pairSession.trades >= 5) {
      lessons.push({
        id: Date.now() + 1, rule: `PATTERN: 📈 ${symbol} is a STRONG PERFORMER during ${session} session — ${pairSession.wins}/${pairSession.trades} wins (${wr.toFixed(0)}% WR). Prioritize this pair in this session.`,
        tags: ["pattern", "session", symbol, session], outcome: "good", pattern: "session_strength",
        confidence: Math.min(0.95, wr / 100 + 0.2), created_at: new Date().toISOString(),
      });
    } else if (wr <= 30 && pairSession.trades >= 5) {
      lessons.push({
        id: Date.now() + 2, rule: `PATTERN: ⚠️ ${symbol} LOSES consistently during ${session} session — ${pairSession.wins}/${pairSession.trades} wins (${wr.toFixed(0)}% WR). Avoid this pair in this session.`,
        tags: ["pattern", "session", symbol, session], outcome: "bad", pattern: "session_weakness",
        confidence: Math.min(0.95, (100 - wr) / 100 + 0.2), created_at: new Date().toISOString(),
      });
    }
  }

  // 2. Strategy performance
  if (strategyId !== "manual" && memory.strategyStats[strategyId]) {
    const ss = memory.strategyStats[strategyId];
    if (ss.trades >= 5) {
      const wr = (ss.wins / ss.trades) * 100;
      if (wr < 35) {
        lessons.push({
          id: Date.now() + 3, rule: `WARNING: Strategy "${strategyId}" has ${wr.toFixed(0)}% WR over ${ss.trades} trades. Consider pausing or reducing allocation.`,
          tags: ["strategy", "warning", strategyId], outcome: "bad", pattern: "strategy_decay",
          confidence: Math.min(0.9, (100 - wr) / 100 + 0.3), created_at: new Date().toISOString(),
        });
      }
    }
  }

  // 3. Day-of-week pattern (check if certain days are consistently bad)
  const day = perf.day;
  const dayStats = memory.byDay[day];
  if (dayStats && dayStats.trades >= 5) {
    const dayWr = (dayStats.wins / dayStats.trades) * 100;
    if (dayWr < 30 && dayStats.trades >= 8) {
      lessons.push({
        id: Date.now() + 4, rule: `PATTERN: ${day} tends to be a losing day — ${dayStats.wins}/${dayStats.trades} wins (${dayWr.toFixed(0)}% WR). Reduce position size or skip trading on ${day}s.`,
        tags: ["pattern", "day", day], outcome: "bad", pattern: "day_weakness",
        confidence: Math.min(0.85, (100 - dayWr) / 100 + 0.2), created_at: new Date().toISOString(),
      });
    }
  }

  // 4. Base trade lesson (good/bad individual)
  const outcome = win ? "good" : pnlPct < -3 ? "bad" : "neutral";
  if (outcome !== "neutral") {
    lessons.push({
      id: Date.now() + 5,
      rule: `${outcome.toUpperCase()}: ${symbol} ${perf.type} | ${session} | ${strategyId !== "manual" ? strategyId : "manual"} | PnL ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%${perf.reason ? ` | ${perf.reason}` : ""}`,
      tags: [outcome, symbol, session],
      outcome,
      pattern: "trade_result",
      confidence: Math.abs(pnlPct) > 5 ? 0.7 : 0.4,
      created_at: new Date().toISOString(),
    });
  }

  return lessons;
}

// ─── Auto-Pause Underperforming Strategies ────────────────────────

function checkAutoPauseStrategies(data, memory) {
  const now = new Date().toISOString();
  for (const [id, stats] of Object.entries(memory.strategyStats)) {
    if (stats.trades < 10) continue;

    const wr = (stats.wins / stats.trades) * 100;
    const last10 = stats.last10Results || [];
    const last10Wins = last10.filter((r) => r.win).length;
    const last10WR = last10.length > 0 ? (last10Wins / last10.length) * 100 : null;

    // Auto-pause: last 10 trades < 30% WR
    if (last10WR != null && last10WR < 30 && last10.length >= 8) {
      if (!data.pausedStrategies.find((p) => p.id === id)) {
        data.pausedStrategies.push({
          id,
          pausedAt: now,
          reason: `Last 10 trades: ${last10Wins}/${last10.length} wins (${last10WR.toFixed(0)}% WR)`,
          lifetimeWR: wr,
          lifetimeTrades: stats.trades,
          autoResumeAfter: 20, // 20 more trades or manual resume
        });
        log("lessons", `⚠️ AUTO-PAUSED strategy "${id}": ${last10Wins}/${last10.length} last 10 (${last10WR.toFixed(0)}% WR)`);
      }
    }

    // Auto-resume: if was paused and now showing recovery
    const paused = data.pausedStrategies.find((p) => p.id === id);
    if (paused && last10WR != null && last10WR >= 40) {
      data.pausedStrategies = data.pausedStrategies.filter((p) => p.id !== id);
      log("lessons", `✅ Strategy "${id}" resumed — last 10 now ${last10Wins}/${last10.length} (${last10WR.toFixed(0)}% WR)`);
    }
  }
}

// ─── Manual Lessons ───────────────────────────────────────────────

export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: String(rule).slice(0, 400),
    tags, outcome: "manual", pattern: "manual",
    pinned: !!pinned, role: role || null,
    confidence: 1.0,
    created_at: new Date().toISOString(),
  });
  save(data);
}

// ─── Pattern Query Engine ─────────────────────────────────────────

export function getPatternReport() {
  const data = load();
  const memory = loadMemory();
  const patterns = [];

  // Session patterns
  for (const [symbol, p] of Object.entries(memory.byPair)) {
    for (const [session, s] of Object.entries(p.bySession || {})) {
      if (s.trades >= 3) {
        patterns.push({
          type: "session",
          subject: `${symbol} @ ${session}`,
          winRate: (s.wins / s.trades) * 100,
          trades: s.trades,
          totalPnl: s.totalPnl,
          strength: s.trades >= 5 ? ((s.wins / s.trades) * 100) > 60 ? "strong" : ((s.wins / s.trades) * 100) < 35 ? "weak" : "neutral" : "insufficient_data",
        });
      }
    }
  }

  // Day patterns
  for (const [day, d] of Object.entries(memory.byDay || {})) {
    if (d.trades >= 3) {
      patterns.push({
        type: "day",
        subject: day,
        winRate: (d.wins / d.trades) * 100,
        trades: d.trades,
        totalPnl: d.totalPnl,
        strength: d.trades >= 5 ? ((d.wins / d.trades) * 100) > 55 ? "strong" : ((d.wins / d.trades) * 100) < 35 ? "weak" : "neutral" : "insufficient_data",
      });
    }
  }

  // Strategy stats
  for (const [id, ss] of Object.entries(memory.strategyStats || {})) {
    if (ss.trades >= 3) {
      const isPaused = data.pausedStrategies?.find((p) => p.id === id);
      patterns.push({
        type: "strategy",
        subject: id,
        winRate: (ss.wins / ss.trades) * 100,
        trades: ss.trades,
        totalPnl: ss.totalPnl,
        paused: !!isPaused,
        pauseReason: isPaused?.reason || null,
        strength: ss.trades >= 5 ? ((ss.wins / ss.trades) * 100) > 50 ? "strong" : ((ss.wins / ss.trades) * 100) < 30 ? "weak" : "neutral" : "insufficient_data",
      });
    }
  }

  // Paused strategies
  const paused = (data.pausedStrategies || []).map((p) => ({
    ...p,
    type: "paused",
    subject: p.id,
  }));

  return {
    patterns,
    pausedStrategies: paused,
    totalLessons: data.lessons.length,
    totalTrades: data.performance.length,
    highConfidenceLessons: data.lessons.filter((l) => l.confidence >= 0.8).length,
  };
}

// ─── Prompt Injection (Enhanced) ──────────────────────────────────

export function getLessonsForPrompt({ agentType = "GENERAL", maxLessons = 25 } = {}) {
  const data = load();
  const patterns = data.lessons.filter((l) => l.pattern && l.confidence >= 0.7).sort((a, b) => b.confidence - a.confidence);
  const recent = data.lessons.filter((l) => !l.pattern || l.confidence < 0.7).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

  const selected = [...patterns.slice(0, 10), ...recent.slice(0, maxLessons - 10)];

  if (selected.length === 0) return null;

  const sections = [];
  const patternLessons = selected.filter((l) => l.pattern && l.pattern !== "trade_result");
  const tradeLessons = selected.filter((l) => l.pattern === "trade_result" || !l.pattern);

  if (patternLessons.length > 0) {
    sections.push("── PATTERNS (learned from history) ──\n" + patternLessons.map((l) => {
      const conf = l.confidence ? ` [${(l.confidence * 100).toFixed(0)}% conf]` : "";
      return `${l.rule}${conf}`;
    }).join("\n"));
  }

  if (tradeLessons.length > 0) {
    sections.push("── RECENT TRADES ──\n" + tradeLessons.map((l) => {
      const date = l.created_at ? l.created_at.slice(0, 10) : "?";
      return `[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
    }).join("\n"));
  }

  // Add paused strategy warnings
  if (data.pausedStrategies?.length > 0) {
    sections.push("── ⚠️ PAUSED STRATEGIES ──\n" + data.pausedStrategies.map((p) =>
      `🚫 ${p.id}: paused — ${p.reason} (${Math.round(p.lifetimeWR)}% lifetime over ${p.lifetimeTrades} trades)`
    ).join("\n"));
  }

  return sections.join("\n\n");
}

// ─── Performance Summary (Enhanced) ───────────────────────────────

export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;
  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + (x.pnl || 0), 0);
  const wins = p.filter((x) => x.pnl > 0).length;

  return {
    totalTrades: p.length, totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnlPct: Math.round((p.reduce((s, x) => s + (x.pnlPct || 0), 0) / p.length) * 100) / 100,
    avgRR: Math.round((p.filter((x) => x.riskReward != null).reduce((s, x) => s + x.riskReward, 0) / (p.filter((x) => x.riskReward != null).length || 1)) * 100) / 100,
    winRate: Math.round((wins / p.length) * 100), wins, losses: p.length - wins,
    pausedStrategies: (data.pausedStrategies || []).length,
  };
}

export function getPerformanceHistory({ hours = 168, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;
  if (p.length === 0) return { trades: [], count: 0, hours };
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const filtered = p.filter((r) => r.recordedAt >= cutoff).slice(-limit);
  return {
    hours, count: filtered.length,
    totalPnl: Math.round(filtered.reduce((s, r) => s + (r.pnl || 0), 0) * 100) / 100,
    winRate: filtered.length > 0 ? Math.round((filtered.filter((r) => r.pnl > 0).length / filtered.length) * 100) : null,
    trades: filtered,
  };
}

export function getPausedStrategies() {
  const data = load();
  return data.pausedStrategies || [];
}

export function resumeStrategy(strategyId) {
  const data = load();
  const before = data.pausedStrategies.length;
  data.pausedStrategies = (data.pausedStrategies || []).filter((p) => p.id !== strategyId);
  save(data);
  const after = data.pausedStrategies.length;
  return { resumed: before > after, strategyId };
}
