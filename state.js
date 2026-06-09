import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");
const SNAPSHOT_FILE = repoPath("daily-snapshots.json");

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      trades: {},
      openTradeIds: [],
      challenge: { phase: "evaluation", startedAt: new Date().toISOString(), completedAt: null },
      dailySnapshots: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (error) {
    log("state_warn", `Invalid state.json: ${error.message}`);
    return { trades: {}, openTradeIds: [], challenge: {}, dailySnapshots: [] };
  }
}

function saveState(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSnapshots(data) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
}

// ─── Trade Tracking ───────────────────────────────────────────────

export function trackTrade({
  ticket,
  symbol,
  type,
  volume,
  openPrice,
  sl,
  tp,
  reason,
}) {
  const state = loadState();
  const id = String(ticket);

  state.trades[id] = {
    id,
    ticket,
    symbol,
    type,
    volume,
    openPrice,
    sl: sl || null,
    tp: tp || null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    closePrice: null,
    pnl: null,
    reason: reason || null,
    managerActions: [],
    trailingActivations: [],
  };

  if (!state.openTradeIds.includes(id)) {
    state.openTradeIds.push(id);
  }

  saveState(state);
  log("state", `Trade tracked: ${symbol} ${type} ${volume} lots @ ${openPrice}`);
  return state.trades[id];
}

export function recordTradeClose({ ticket, closePrice, pnl, reason }) {
  const state = loadState();
  const id = String(ticket);

  if (!state.trades[id]) {
    log("state_warn", `Trade ${id} not found in registry`);
    return null;
  }

  state.trades[id].closedAt = new Date().toISOString();
  state.trades[id].closePrice = closePrice;
  state.trades[id].pnl = pnl;
  state.trades[id].closeReason = reason || "manual";
  state.openTradeIds = state.openTradeIds.filter((t) => t !== id);

  saveState(state);
  log("state", `Trade closed: ${state.trades[id].symbol} PnL: ${pnl.toFixed(2)}`);
  return state.trades[id];
}

export function recordTrailingActivation({ ticket, newSL, profitPips }) {
  const state = loadState();
  const id = String(ticket);

  if (!state.trades[id]) return null;

  state.trades[id].trailingActivations = state.trades[id].trailingActivations || [];
  state.trades[id].trailingActivations.push({
    at: new Date().toISOString(),
    newSL,
    profitPips,
  });

  saveState(state);
}

export function getTrackedTrade(ticket) {
  const state = loadState();
  return state.trades[String(ticket)] || null;
}

export function getTrackedTrades() {
  const state = loadState();
  return Object.values(state.trades);
}

export function getOpenTrackedTrades() {
  const state = loadState();
  return state.openTradeIds.map((id) => state.trades[id]).filter(Boolean);
}

export function syncOpenTrades(activeIds) {
  const state = loadState();
  const activeIdSet = new Set(activeIds.map(String));

  // Close tracked trades that are no longer open in TradeLocker
  for (const id of [...state.openTradeIds]) {
    if (!activeIdSet.has(id) && state.trades[id] && !state.trades[id].closedAt) {
      state.openTradeIds = state.openTradeIds.filter((t) => t !== id);
      log("state", `Trade ${id} no longer open in TradeLocker — marked as externally closed`);
    }
  }

  saveState(state);
}

// ─── Daily Snapshots ───────────────────────────────────────────────

export function recordDailySnapshot({ date, startEquity, peakEquity, troughEquity, tradesCount }) {
  const snapshots = loadSnapshots();
  const existing = snapshots.findIndex((s) => s.date === date);

  const entry = { date, startEquity, peakEquity, troughEquity, tradesCount, updatedAt: new Date().toISOString() };

  if (existing >= 0) {
    snapshots[existing] = entry;
  } else {
    snapshots.push(entry);
  }

  saveSnapshots(snapshots);
}

export function getDailySnapshot() {
  const snapshots = loadSnapshots();
  const today = new Date().toISOString().slice(0, 10);
  return snapshots.find((s) => s.date === today) || null;
}

export function getAllDailySnapshots() {
  return loadSnapshots();
}

// ─── Challenge Phase ───────────────────────────────────────────────

export function recordChallengePhase({ phase, reason }) {
  const state = loadState();
  const prevPhase = state.challenge?.phase || "evaluation";

  state.challenge = {
    ...state.challenge,
    phase,
    previousPhase: prevPhase,
    phaseChangedAt: new Date().toISOString(),
    phaseChangeReason: reason || "automated",
  };

  if (phase === "funded") {
    state.challenge.completedAt = new Date().toISOString();
  }

  saveState(state);
  log("state", `Challenge phase: ${prevPhase} → ${phase} (${reason})`);
}

export function getChallengeState() {
  const state = loadState();
  return {
    phase: state.challenge?.phase || "evaluation",
    startedAt: state.challenge?.startedAt || null,
    completedAt: state.challenge?.completedAt || null,
    previousPhase: state.challenge?.previousPhase || null,
    phaseChangedAt: state.challenge?.phaseChangedAt || null,
  };
}

export function getStateSummary() {
  const state = loadState();
  const openTrades = getOpenTrackedTrades();

  return {
    phase: state.challenge?.phase || "evaluation",
    totalTrades: Object.keys(state.trades).length,
    openTrades: openTrades.length,
    openPositions: openTrades.map((t) => ({
      ticket: t.ticket,
      symbol: t.symbol,
      type: t.type,
      volume: t.volume,
      openPrice: t.openPrice,
      openedAt: t.openedAt,
    })),
    lastTradeClosedAt: Object.values(state.trades)
      .filter((t) => t.closedAt)
      .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))[0]?.closedAt || null,
  };
}

// ─── Position Instruction ──────────────────────────────────────────

export function setTradeInstruction(ticket, instruction) {
  const state = loadState();
  const id = String(ticket);

  if (!state.trades[id]) return false;

  state.trades[id].instruction = instruction || null;
  saveState(state);
  log("state", `Instruction set for trade ${id}: "${instruction}"`);
  return true;
}

export function clearTradeInstruction(ticket) {
  return setTradeInstruction(ticket, null);
}
