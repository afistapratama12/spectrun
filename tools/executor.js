import { getAccountStatus, getOpenPositions, getTodayClosedTrades } from "../tradelocker/account.js";
import { getOHLCV, getInstrumentSpecs, calculateATR, calculateRSI, calculateEMA, determineTrend } from "../tradelocker/market-data.js";
import { placeOrder, modifyPosition, closePosition, closeAllPositions, calculateLotSize } from "../tradelocker/trading.js";
import { getForexNews, checkNewsBuffer as checkNews, formatNewsForPrompt } from "../news.js";
import { checkChallengeRules, computeRiskPositionSize, evaluateTrailingStop, evaluateTimeDecay, getRiskReport, updateDailySnapshot, checkPhaseTransition } from "../risk-manager.js";
import { trackTrade, recordTradeClose, getOpenTrackedTrades, getTrackedTrades, setTradeInstruction, recordTrailingActivation, recordChallengePhase, getStateSummary, syncOpenTrades } from "../state.js";
import { config, reloadUserConfig } from "../config.js";
import { log, logAction } from "../logger.js";
import { getRecentDecisions, appendDecision } from "../decision-log.js";
import { recordPerformance, getPerformanceHistory, getPerformanceSummary, addLesson } from "../lessons.js";
import { STRATEGIES, getStrategiesByType, getStrategiesForSession, getStrategy, getActiveSession, isStrategyValid, scorePairForStrategy, calculateStrategySLTP } from "../strategies/index.js";
import { recordTradeForConsistency, getConsistencyReport, checkDailyConsistency, getStrategyUsageReport } from "../consistency-tracker.js";
import fs from "fs";
import { repoPath } from "../repo-root.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

// ─── Tool Implementations ─────────────────────────────────────────

export async function executeTool(name, args) {
  const startTime = Date.now();

  name = name.replace(/<.*$/, "").trim();

  const fn = toolMap[name];
  if (!fn) {
    return { error: `Unknown tool: ${name}` };
  }

  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: JSON.stringify(result).slice(0, 500),
      duration_ms: duration,
      success,
    });

    return result;
  } catch (error) {
    logAction({ tool: name, args, error: error.message, duration_ms: Date.now() - startTime, success: false });
    return { error: error.message, tool: name };
  }
}

// ─── Tool Map ─────────────────────────────────────────────────────

const toolMap = {
  get_account_status: async () => {
    const account = await getAccountStatus();
    const positions = await getOpenPositions();
    const closedToday = await getTodayClosedTrades();
    updateDailySnapshot(account);

    const rules = checkChallengeRules({ accountStatus: account, openPositions: positions, closedToday });

    return {
      account: {
        balance: account.balance,
        equity: account.equity,
        freeMargin: account.freeMargin,
        marginLevel: account.marginLevel,
        profit: account.profit,
        currency: account.currency,
        leverage: account.leverage,
      },
      risk: {
        ...rules,
      },
      positions: positions.length,
    };
  },

  check_challenge_rules: async () => {
    const account = await getAccountStatus();
    const positions = await getOpenPositions();
    const closedToday = await getTodayClosedTrades();
    return checkChallengeRules({ accountStatus: account, openPositions: positions, closedToday });
  },

  calculate_position_size: async ({ symbol, sl_pips }) => {
    const account = await getAccountStatus();
    const risk = computeRiskPositionSize({
      equity: account.equity,
      symbol,
      slPips: sl_pips,
    });
    return risk;
  },

  get_pair_analysis: async ({ symbol }) => {
    const strategy = config.strategy;

    // Fetch data for all timeframes in parallel
    const timeframes = [...new Set([...strategy.trendTimeframes, ...strategy.entryTimeframes])];

    const results = await Promise.allSettled(
      timeframes.map((tf) =>
        getOHLCV({ symbol, resolution: tf, count: 100 }).then((candles) => ({ tf, candles }))
      )
    );

    const dataByTf = {};
    for (const r of results) {
      if (r.status === "fulfilled") dataByTf[r.value.tf] = r.value.candles;
    }

    const entryTf = strategy.entryTimeframes[0] || "15m";
    const entryCandles = dataByTf[entryTf] || [];

    const rsi = calculateRSI(entryCandles.map((c) => c.close), 14);
    const atr = calculateATR(entryCandles, 14);
    const trend = determineTrend(dataByTf[strategy.trendTimeframes[0]] || []);
    const lastPrice = entryCandles.length > 0 ? entryCandles[entryCandles.length - 1].close : null;

    // Support and resistance (simple: recent swing highs/lows from entry TF)
    let support = null, resistance = null;
    if (entryCandles.length > 20) {
      const recent = entryCandles.slice(-20);
      support = Math.min(...recent.map((c) => c.low));
      resistance = Math.max(...recent.map((c) => c.high));
    }

    // Session info
    const hour = new Date().getUTCHours();
    let session = "Asian";
    if (hour >= 7 && hour < 16) session = "London";
    else if (hour >= 12 && hour < 21) session = "New York";
    if (hour >= 12 && hour < 16) session = "London/NY Overlap";

    const allowed = config.strategy.allowedPairs || [];
    const pairAllowed = allowed.includes(symbol);

    return {
      symbol,
      price: lastPrice,
      spread: null, // would need real-time data
      atr,
      rsi: Math.round(rsi * 100) / 100,
      trend,
      support,
      resistance,
      session,
      pairAllowed,
      timeframesAnalyzed: Object.keys(dataByTf),
    };
  },

  scan_markets: async ({ limit = 5, strategyType = null } = {}) => {
    const allowed = config.strategy.allowedPairs || [];
    if (allowed.length === 0) return { setups: [], error: "No pairs configured in strategy.allowedPairs" };

    const activeSession = getActiveSession();
    const validStrategies = Object.values(STRATEGIES).filter((s) => {
      if (strategyType && s.type !== strategyType) return false;
      return isStrategyValid(s);
    });

    if (validStrategies.length === 0) {
      return { setups: [], strategySetups: [], message: `No valid strategies for current session (${activeSession})` };
    }

    const results = await Promise.allSettled(
      allowed.map(async (symbol) => {
        try {
          const analysis = await toolMap.get_pair_analysis({ symbol });
          return { symbol, analysis };
        } catch { return null; }
      })
    );

    const setups = results
      .filter((r) => r.status === "fulfilled" && r.value)
      .map((r) => r.value)
      .filter(({ analysis }) => analysis?.price && analysis?.pairAllowed);

    // Strategy-aware scoring: score each pair against each valid strategy
    const strategySetups = [];
    for (const { symbol, analysis } of setups) {
      for (const strategy of validStrategies) {
        const scored = scorePairForStrategy(strategy, analysis);
        if (scored.passed) {
          strategySetups.push({
            strategyId: strategy.id,
            strategyName: strategy.name,
            strategyType: strategy.type,
            symbol,
            price: analysis.price,
            direction: analysis.trend === "bullish" ? "buy" : analysis.trend === "bearish" ? "sell" : null,
            trend: analysis.trend,
            rsi: analysis.rsi,
            atr: Math.round(analysis.atr * 100000) / 100000,
            session: analysis.session,
            estimatedSL: scored.sltp?.slPips,
            estimatedTP: scored.sltp?.tpPips,
            riskReward: scored.sltp?.riskReward,
            maxRiskPct: scored.maxRiskPct,
            score: scored.score,
            checks: scored.reason,
          });
        }
      }
    }

    strategySetups.sort((a, b) => b.score - a.score);

    // Also include summary by strategy type
    const byType = { intraday: 0, swing: 0 };
    for (const s of strategySetups) {
      byType[s.strategyType] = (byType[s.strategyType] || 0) + 1;
    }

    return {
      activeSession,
      validStrategies: validStrategies.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      strategySetups: strategySetups.slice(0, limit),
      byType,
      totalScanned: allowed.length,
      validPairs: setups.length,
    };
  },

  get_forex_news: async ({ hours_ahead = 24 } = {}) => {
    const events = await getForexNews({ hoursAhead: hours_ahead });
    return { events, count: events.length, formattedPrompt: formatNewsForPrompt(events) };
  },

  check_news_buffer: async ({ symbol }) => {
    const events = await getForexNews({ hoursAhead: 2 });
    return checkNews({ symbol, newsEvents: events });
  },

  place_trade: async ({ symbol, type, volume, sl_pips, tp_pips, reason = "" }) => {
    const account = await getAccountStatus();
    const positions = await getOpenPositions();
    const closedToday = await getTodayClosedTrades();

    // 1. Risk check
    const rules = checkChallengeRules({ accountStatus: account, openPositions: positions, closedToday });
    if (!rules.canTrade) {
      return {
        success: false,
        blocked: true,
        reason: `Risk rules blocked trade: ${rules.blockReasons.join(" | ")}`,
        rules,
      };
    }

    // 2. News buffer check
    const events = await getForexNews({ hoursAhead: 2 });
    const newsCheck = checkNews({ symbol, newsEvents: events });
    if (newsCheck.blocked) {
      return {
        success: false,
        blocked: true,
        reason: newsCheck.reason,
      };
    }

    // 3. Verify lot size
    const sizeCheck = computeRiskPositionSize({
      equity: account.equity,
      symbol,
      slPips: sl_pips,
    });
    const maxLot = sizeCheck.lots * 1.1; // allow 10% flexibility
    if (volume > maxLot || volume < 0.01) {
      return {
        success: false,
        error: `Lot size ${volume} is outside allowed range [0.01, ${maxLot.toFixed(2)}]. Calculated: ${sizeCheck.breakdown}`,
      };
    }

    // 4. Get current price to calculate SL/TP prices
    const candles = await getOHLCV({ symbol, resolution: "5m", count: 5 });
    if (candles.length === 0) {
      return { success: false, error: `No price data available for ${symbol}` };
    }
    const currentPrice = candles[candles.length - 1].close;

    const pipSize = 0.0001; // standard for most pairs
    const slPrice = type === "buy"
      ? currentPrice - sl_pips * pipSize
      : currentPrice + sl_pips * pipSize;
    const tpPrice = type === "buy"
      ? currentPrice + tp_pips * pipSize
      : currentPrice - tp_pips * pipSize;

    // 5. Place the trade
    const result = await placeOrder({
      symbol,
      type,
      volume,
      sl: Math.round(slPrice * 100000) / 100000,
      tp: Math.round(tpPrice * 100000) / 100000,
      orderType: "market",
      comment: reason || "Spectrun AI",
    });

    if (!result.success && !result.dry_run) {
      return result;
    }

    // 6. Track in state
    if (!result.dry_run && result.ticket) {
      trackTrade({
        ticket: result.ticket,
        symbol,
        type,
        volume,
        openPrice: currentPrice,
        sl: result.sl,
        tp: result.tp,
        reason,
      });
    }

    appendDecision({
      type: "entry",
      actor: "SCANNER",
      symbol,
      summary: `${type.toUpperCase()} ${volume} ${symbol} @ ${currentPrice}`,
      reason: reason || "AI scan setup",
      metrics: {
        sl_pips,
        tp_pips,
        risk_pct: config.risk.riskPerTradePct,
        position_size: result.dry_run ? "DRY_RUN" : result.ticket,
      },
    });

    return {
      ...result,
      risk: sizeCheck,
      currentPrice,
      slPrice: Math.round(slPrice * 100000) / 100000,
      tpPrice: Math.round(tpPrice * 100000) / 100000,
    };
  },

  get_open_trades: async () => {
    const positions = await getOpenPositions();

    // Sync with state
    syncOpenTrades(positions.map((p) => String(p.id || p.ticket)));

    return {
      count: positions.length,
      positions: positions.map((p) => {
        const pipSize = 0.0001;
        const pipsFromEntry = p.openPrice && p.currentPrice
          ? Math.round((Math.abs(p.currentPrice - p.openPrice) / pipSize) * 10) / 10
          : 0;

        return {
          ticket: p.ticket || p.id,
          symbol: p.symbol,
          type: p.type,
          volume: p.volume,
          openPrice: p.openPrice,
          currentPrice: p.currentPrice,
          profit: p.profit,
          profitPct: p.profitPct,
          pipsFromEntry,
          sl: p.sl,
          tp: p.tp,
          openTime: p.openTime,
        };
      }),
    };
  },

  close_trade: async ({ ticket, reason = "manual" }) => {
    const result = await closePosition({ positionId: ticket });

    if (result.success) {
      recordTradeClose({
        ticket,
        closePrice: result.closePrice,
        pnl: result.profit,
        reason,
      });

      appendDecision({
        type: "exit",
        actor: "MANAGER",
        symbol: "see trade registry",
        summary: `Closed ${ticket}: ${reason}`,
        reason,
        metrics: { pnl: result.profit },
      });
    }

    return result;
  },

  close_all_trades: async ({ reason }) => {
    const positions = await getOpenPositions();

    for (const p of positions) {
      try {
        await toolMap.close_trade({ ticket: p.ticket || p.id, reason });
      } catch (e) {
        log("executor_warn", `Failed to close ${p.ticket}: ${e.message}`);
      }
    }

    return await closeAllPositions();
  },

  modify_trade: async ({ ticket, sl, tp }) => {
    const result = await modifyPosition({
      positionId: ticket,
      sl: sl ?? undefined,
      tp: tp ?? undefined,
    });

    if (result.success && sl) {
      recordTrailingActivation({
        ticket,
        newSL: sl,
        profitPips: 0,
      });
    }

    return result;
  },

  update_config: ({ changes, reason = "" }) => {
    const applied = {};
    const unknown = [];

    for (const [key, val] of Object.entries(changes)) {
      const section = findConfigSection(key);
      if (!section) { unknown.push(key); continue; }

      const [sectionName, field] = section;
      config[sectionName][field] = val;
      applied[key] = val;
    }

    if (Object.keys(applied).length === 0) {
      return { success: false, unknown, reason };
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
    }

    for (const [key, val] of Object.entries(applied)) {
      userConfig[key] = val;
    }
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    log("config", `Config updated: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },

  get_performance_history: async ({ hours = 168, limit = 50 } = {}) => {
    return getPerformanceHistory({ hours, limit });
  },

  get_recent_decisions: async ({ limit = 6 } = {}) => {
    return { decisions: getRecentDecisions(limit) };
  },

  add_lesson: async ({ rule, tags = [], role = null }) => {
    addLesson(rule, tags, { role });
    return { saved: true, rule, tags, role };
  },

  scan_strategies: async ({ type = null } = {}) => {
    const activeSession = getActiveSession();
    const all = Object.values(STRATEGIES).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      description: s.description,
      validNow: isStrategyValid(s),
      minScore: s.minScore,
      maxRiskPct: s.position.maxRiskPct,
      consistency: s.consistency,
    }));

    return {
      activeSession,
      totalStrategies: all.length,
      validNow: all.filter((s) => s.validNow).length,
      strategies: type ? all.filter((s) => s.type === type) : all,
    };
  },

  get_consistency_report: async () => {
    return getConsistencyReport();
  },

  get_strategy_usage: async () => {
    return getStrategyUsageReport();
  },

  check_daily_consistency: async ({ strategy_id, projected_pnl = 0 } = {}) => {
    return checkDailyConsistency({ strategyId: strategy_id, projectedPnl: projected_pnl });
  },
};

function findConfigSection(key) {
  const map = {
    riskPerTradePct: ["risk", "riskPerTradePct"],
    maxDailyTrades: ["risk", "maxDailyTrades"],
    maxConsecutiveLosses: ["risk", "maxConsecutiveLosses"],
    consecutiveLossCooldownMinutes: ["risk", "consecutiveLossCooldownMinutes"],
    trailingStopEnabled: ["risk", "trailingStopEnabled"],
    trailingTriggerPips: ["risk", "trailingTriggerPips"],
    trailingDistancePips: ["risk", "trailingDistancePips"],
    allowedPairs: ["strategy", "allowedPairs"],
    requireTrendAlignment: ["strategy", "requireTrendAlignment"],
    avoidHighImpactNewsPairs: ["strategy", "avoidHighImpactNewsPairs"],
    minRiskRewardRatio: ["challenge", "minRiskRewardRatio"],
    maxOpenPositions: ["challenge", "maxOpenPositions"],
    maxDailyLossPct: ["challenge", "maxDailyLossPct"],
    maxTotalLossPct: ["challenge", "maxTotalLossPct"],
    profitTargetPct: ["challenge", "profitTargetPct"],
    consistencyMinPct: ["challenge", "consistencyMinPct"],
    scannerIntervalMin: ["schedule", "scannerIntervalMin"],
    managerIntervalMin: ["schedule", "managerIntervalMin"],
    scannerModel: ["llm", "scannerModel"],
    managerModel: ["llm", "managerModel"],
    generalModel: ["llm", "generalModel"],
  };
  return map[key] || null;
}
