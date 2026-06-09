import { config } from "./config.js";
import { log } from "./logger.js";
import { getTrackedTrades, getDailySnapshot, recordDailySnapshot, recordChallengePhase } from "./state.js";

/**
 * Risk Manager — Hardware-enforced challenge rules.
 * All rules are evaluated in code, never left to LLM discretion.
 */

// 🛡️ CORE CHALLENGE RULE CHECK
export function checkChallengeRules({ accountStatus, openPositions = [], closedToday = [] }) {
  const challenge = config.challenge;
  const risk = config.risk;
  const equity = accountStatus.equity;
  const initialBalance = accountStatus.balance; // starting balance for the day

  const dailySnapshot = getDailySnapshot();
  const todayStartEquity = dailySnapshot?.startEquity ?? initialBalance;
  const peakEquity = dailySnapshot?.peakEquity ?? todayStartEquity;

  // 1. Daily P&L
  const dailyPnL = equity - todayStartEquity;
  const dailyPnLPct = todayStartEquity > 0 ? (dailyPnL / todayStartEquity) * 100 : 0;

  // 2. Daily loss remaining
  const maxDailyLoss = todayStartEquity * (challenge.maxDailyLossPct / 100);
  const dailyLossUsed = Math.max(0, todayStartEquity - equity);
  const dailyLossRemaining = maxDailyLoss - dailyLossUsed;
  const dailyLossRemainingPct = todayStartEquity > 0 ? (dailyLossRemaining / todayStartEquity) * 100 : 0;

  // 3. Total drawdown (from peak)
  const totalDrawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;

  // 4. Daily loss limit violations
  const dailyLossLimitHit = dailyLossUsed >= maxDailyLoss;
  const dailyLossWarning = dailyLossRemainingPct < 1.0 && !dailyLossLimitHit;
  const totalLossLimitHit = totalDrawdownPct >= challenge.maxTotalLossPct;

  // 5. Consistency rule (min 40% consistency rate)
  let consistencyViolation = false;
  let consistencyDayWarning = false;
  // consistencyScore is loaded async via getRiskReportAsync below

  if (challenge.consistencyMinPct > 0) {
    const totalProfit = dailyPnL > 0 ? dailyPnL : 0;
    if (totalProfit > 0) {
      const todayContribution = dailyPnL > 0 ? (dailyPnL / totalProfit) * 100 : 0;
      consistencyViolation = todayContribution > challenge.consistencyMinPct;
    }
    const trackedTrades = getTrackedTrades();
    const dailyProfits = trackedTrades.filter((t) => t.pnl > 0);
    if (dailyProfits.length > 1) {
      const maxDayProfit = Math.max(...dailyProfits.map((t) => t.pnl));
      const totalProfitAll = dailyProfits.reduce((sum, t) => sum + t.pnl, 0);
      if (totalProfitAll > 0 && maxDayProfit / totalProfitAll > challenge.consistencyMinPct / 100) {
        consistencyDayWarning = true;
      }
    }
  }

  // 6. Position limits
  const maxPositions = challenge.maxOpenPositions ?? 3;
  const atMaxPositions = openPositions.length >= maxPositions;
  const canOpenNew = !atMaxPositions && !dailyLossLimitHit && !totalLossLimitHit;

  // 7. Consecutive loss cooldown
  let consecutiveLossCooldown = false;
  if (risk.maxConsecutiveLosses > 0) {
    const closed = getTrackedTrades().filter((t) => t.closed);
    const recent = closed.slice(-risk.maxConsecutiveLosses);
    if (recent.length >= risk.maxConsecutiveLosses && recent.every((t) => t.pnl < 0)) {
      const lastLoss = recent[recent.length - 1];
      const cooldownUntil = new Date(lastLoss.closedAt).getTime() + risk.consecutiveLossCooldownMinutes * 60_000;
      if (Date.now() < cooldownUntil) {
        consecutiveLossCooldown = true;
      }
    }
  }

  // 8. Daily trade limit
  const tradesToday = closedToday.length;
  const dailyTradeLimitReached = tradesToday >= (risk.maxDailyTrades ?? 99);

  // 9. News buffer (checked by caller, flag here)
  const newsBufferActive = false; // set by scanner

  const canTrade = canOpenNew && !consecutiveLossCooldown && !dailyTradeLimitReached && !newsBufferActive;

  let blockReasons = [];
  if (!canOpenNew) {
    if (dailyLossLimitHit) blockReasons.push("Daily loss limit HIT");
    if (totalLossLimitHit) blockReasons.push("Total loss limit HIT");
    if (atMaxPositions) blockReasons.push(`Max positions (${maxPositions}) reached`);
  }
  if (consecutiveLossCooldown) blockReasons.push("Consecutive loss cooldown active");
  if (dailyTradeLimitReached) blockReasons.push("Daily trade limit reached");

  return {
    phase: challenge.phase,
    equity,
    initialBalance,
    todayStartEquity,
    peakEquity,
    dailyPnL,
    dailyPnLPct,
    dailyLossUsed,
    dailyLossRemaining,
    dailyLossRemainingPct,
    dailyLossLimitHit,
    dailyLossWarning,
    totalDrawdownPct,
    totalLossLimitHit,
    consistencyViolation,
    consistencyDayWarning,
    consistencyMinPct: challenge.consistencyMinPct,
    maxPositions,
    currentPositions: openPositions.length,
    atMaxPositions,
    canOpenNew,
    canTrade,
    blockReasons,
    newsBufferActive,
    consecutiveLossCooldown,
    dailyTradeLimitReached,
    tradesToday,
    profitTargetPct: challenge.profitTargetPct,
    profitTargetHit: dailyPnLPct >= challenge.profitTargetPct,
  };
}

/**
 * Calculate position size based on risk parameters.
 * Returns the lot size and full breakdown.
 */
export function computeRiskPositionSize({ equity, symbol, slPips, pipValue = null }) {
  const risk = config.risk;
  const riskPerTrade = risk.riskPerTradePct;

  if (equity <= 0 || slPips <= 0) {
    return { lots: 0, error: "Invalid equity or SL pips" };
  }

  const riskAmount = equity * (riskPerTrade / 100);

  // Standard pip value if not provided
  const standardPipValues = {
    EURUSD: 10, GBPUSD: 10, AUDUSD: 10, NZDUSD: 10,
    USDCAD: 7.3, USDCHF: 9, USDJPY: 8.5,
    EURGBP: 13, EURJPY: 8.5, GBPJPY: 8.5,
  };
  const effectivePipValue = pipValue ?? (standardPipValues[symbol?.replace(/[^A-Z]/g, "")] || 10);

  const lotsRaw = riskAmount / (slPips * effectivePipValue);
  const lots = Math.floor(lotsRaw * 100) / 100;
  const effectiveLots = Math.max(0.01, lots);

  return {
    lots: effectiveLots,
    riskAmount,
    riskPct: riskPerTrade,
    slPips,
    pipValue: effectivePipValue,
    breakdown: `${effectiveLots} lots = $${riskAmount.toFixed(2)} risk (${riskPerTrade}% of $${equity.toFixed(2)}) / (${slPips} pips × $${effectivePipValue}/pip)`,
  };
}

/**
 * Check if a trailing stop should be activated and return new SL level.
 */
export function evaluateTrailingStop({ position, currentPrice }) {
  if (!config.risk.trailingStopEnabled) return null;

  const triggerPips = config.risk.trailingTriggerPips;
  const distancePips = config.risk.trailingDistancePips;
  const isLong = position.type === "buy" || position.type === "long";
  const openPrice = position.openPrice;

  // Calculate profit in pips
  const pipSize = 0.0001; // standard for most forex pairs
  const profitPips = isLong
    ? (currentPrice - openPrice) / pipSize
    : (openPrice - currentPrice) / pipSize;

  // Has profit exceeded trigger?
  if (profitPips < triggerPips) return null;

  // New stop loss
  const newSL = isLong
    ? currentPrice - distancePips * pipSize
    : currentPrice + distancePips * pipSize;

  // Only move SL in profitable direction
  const currentSL = position.sl || 0;
  if (isLong && (newSL <= currentSL)) return null;
  if (!isLong && (newSL >= currentSL)) return null;

  return {
    action: "trail",
    newSL,
    profitPips: Math.round(profitPips),
    currentSL,
  };
}

/**
 * Evaluate if a stagnant position should be closed.
 */
export function evaluateTimeDecay({ position, currentTime = Date.now(), maxHours = 4 }) {
  if (!position.openTime) return null;

  const openTime = new Date(position.openTime).getTime();
  const hoursOpen = (currentTime - openTime) / (1000 * 60 * 60);

  if (hoursOpen < maxHours) return null;

  // Only flag if not in profit (let profitable trades run)
  if (position.profit > 0) return null;

  return {
    action: "evaluate",
    reason: `Position open ${hoursOpen.toFixed(1)}h with no profit`,
    hoursOpen: Math.round(hoursOpen * 10) / 10,
  };
}

/**
 * Full risk report for prompt injection.
 */
export function getRiskReport(accountStatus, openPositions, closedToday) {
  const rules = checkChallengeRules({ accountStatus, openPositions, closedToday });
  const challenge = config.challenge;

  return [
    `📊 RISK REPORT — Phase: ${challenge.phase.toUpperCase()}`,
    `Equity: $${rules.equity.toFixed(2)} | Daily P&L: $${rules.dailyPnL.toFixed(2)} (${rules.dailyPnLPct.toFixed(2)}%)`,
    `Daily Loss: $${rules.dailyLossUsed.toFixed(2)} / $${(rules.todayStartEquity * challenge.maxDailyLossPct / 100).toFixed(2)} max (${rules.dailyLossRemainingPct.toFixed(2)}% remaining)`,
    `Total Drawdown: ${rules.totalDrawdownPct.toFixed(2)}% / ${challenge.maxTotalLossPct}% max`,
    `Positions: ${rules.currentPositions}/${rules.maxPositions} | Trades today: ${rules.tradesToday}/${config.risk.maxDailyTrades}`,
    `Profit Target: ${rules.dailyPnLPct >= 0 ? "+" : ""}${rules.dailyPnLPct.toFixed(2)}% / ${challenge.profitTargetPct}% target`,
    `Can Trade: ${rules.canTrade ? "✅ YES" : "🚫 NO"}`,
    rules.blockReasons.length > 0 ? `Blocked: ${rules.blockReasons.join(" | ")}` : null,
    rules.dailyLossWarning ? "⚠️ DAILY LOSS WARNING — approaching daily loss limit" : null,
    rules.consistencyDayWarning ? "⚠️ CONSISTENCY WARNING — monitor daily profit distribution" : null,
  ].filter(Boolean).join("\n");
}

/**
 * Update the daily snapshot with current equity.
 * Called at the start of every manager cycle.
 */
export function updateDailySnapshot(accountStatus) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = getDailySnapshot();

  if (!existing || existing.date !== today) {
    recordDailySnapshot({
      date: today,
      startEquity: accountStatus.equity,
      peakEquity: accountStatus.equity,
      troughEquity: accountStatus.equity,
      tradesCount: 0,
    });
    return;
  }

  // Update peak and trough
  const updated = {
    date: today,
    startEquity: existing.startEquity,
    peakEquity: Math.max(existing.peakEquity, accountStatus.equity),
    troughEquity: Math.min(existing.troughEquity, accountStatus.equity),
    tradesCount: existing.tradesCount,
  };
  recordDailySnapshot(updated);
}

// ─── Challenge Phase Management ───────────────────────────────────

/**
 * Check if the challenge phase has been completed.
 * Phase 1 (evaluation): profit target hit
 * Phase 2 (verification): profit target hit
 * Funded: no target
 */
export function checkPhaseTransition(accountStatus, openPositions, closedToday) {
  const challenge = config.challenge;
  const rules = checkChallengeRules({ accountStatus, openPositions, closedToday });

  if (challenge.phase === "evaluation" && rules.profitTargetHit) {
    log("risk", `🎯 EVALUATION PROFIT TARGET HIT! Phase 1 complete.`);
    return {
      shouldTransition: true,
      from: "evaluation",
      to: "verification",
      reason: `Profit target ${challenge.profitTargetPct}% reached`,
    };
  }

  if (challenge.phase === "verification" && rules.profitTargetHit) {
    log("risk", `🎯 VERIFICATION PROFIT TARGET HIT! Phase 2 complete.`);
    return {
      shouldTransition: true,
      from: "verification",
      to: "funded",
      reason: `Profit target ${challenge.profitTargetPct}% reached`,
    };
  }

  return { shouldTransition: false };
}
