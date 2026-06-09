import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const LESSONS_FILE = repoPath("lessons.json");

function load() {
  if (!fs.existsSync(LESSONS_FILE)) return { lessons: [], performance: [] };
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

// ─── Record Performance ───────────────────────────────────────────

export async function recordPerformance(perf) {
  const data = load();

  const pnl = perf.pnl ?? perf.profit ?? 0;
  const initialCapital = perf.entryCapital ?? perf.equity ?? 0;
  const pnlPct = initialCapital > 0 ? (pnl / initialCapital) * 100 : 0;

  // Derive R:R
  const riskReward = perf.tpPips && perf.slPips ? perf.tpPips / perf.slPips : null;

  const entry = {
    ticket: perf.ticket || `trade_${Date.now()}`,
    symbol: perf.symbol,
    type: perf.type,
    volume: perf.volume,
    openPrice: perf.openPrice,
    closePrice: perf.closePrice,
    pnl,
    pnlPct: Math.round(pnlPct * 100) / 100,
    riskReward,
    slPips: perf.slPips || null,
    tpPips: perf.tpPips || null,
    holdMinutes: perf.holdMinutes ?? null,
    reason: perf.reason || null,
    session: perf.session || null,
    trend: perf.trend || null,
    closedAt: perf.closedAt || new Date().toISOString(),
    recordedAt: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Derive lesson from significant outcomes
  const lesson = deriveLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);
  return entry;
}

export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const data = load();
  const lesson = {
    id: Date.now(),
    rule: String(rule).slice(0, 400),
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  };
  data.lessons.push(lesson);
  save(data);
  log("lessons", `Manual lesson added: ${rule.slice(0, 80)}`);
}

function deriveLesson(perf) {
  const tags = [];
  const outcome = perf.pnl > 0 ? "good" : perf.pnl < -5 ? "bad" : "neutral";
  if (outcome === "neutral") return null;

  let rule = "";
  if (outcome === "good") {
    rule = `WORKED: ${perf.symbol} ${perf.type} during ${perf.session || "unknown"} session — PnL ${perf.pnlPct >= 0 ? "+" : ""}${perf.pnlPct}%${perf.trend ? `, trend=${perf.trend}` : ""}.`;
    tags.push("worked", perf.symbol);
  } else {
    rule = `FAILED: ${perf.symbol} ${perf.type} — PnL ${perf.pnlPct}%. Reason: ${perf.reason || "unknown"}.${perf.session ? ` Session: ${perf.session}.` : ""}`;
    tags.push("failed", perf.symbol);
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    created_at: new Date().toISOString(),
  };
}

// ─── Prompt Injection ─────────────────────────────────────────────

export function getLessonsForPrompt({ agentType = "GENERAL", maxLessons = 20 } = {}) {
  const data = load();
  if (data.lessons.length === 0) return null;

  const selected = data.lessons
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, maxLessons);

  return selected
    .map((l) => {
      const date = l.created_at ? l.created_at.slice(0, 10) : "unknown";
      return `[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
    })
    .join("\n");
}

// ─── Performance Summary ──────────────────────────────────────────

export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;
  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + (x.pnl || 0), 0);
  const wins = p.filter((x) => x.pnl > 0).length;
  const avgPnlPct = p.length > 0 ? p.reduce((s, x) => s + (x.pnlPct || 0), 0) / p.length : 0;
  const avgRR = p.filter((x) => x.riskReward != null).reduce((s, x) => s + x.riskReward, 0) / (p.filter((x) => x.riskReward != null).length || 1);

  return {
    totalTrades: p.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnlPct: Math.round(avgPnlPct * 100) / 100,
    avgRiskReward: Math.round(avgRR * 100) / 100,
    winRate: Math.round((wins / p.length) * 100),
    wins,
    losses: p.length - wins,
  };
}

export function getPerformanceHistory({ hours = 168, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;
  if (p.length === 0) return { trades: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recordedAt >= cutoff)
    .slice(-limit);

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl || 0), 0);
  const wins = filtered.filter((r) => r.pnl > 0).length;

  return {
    hours,
    count: filtered.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    winRate: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    trades: filtered,
  };
}
