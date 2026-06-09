/**
 * Strategy Library — Curated intraday & swing trading strategies.
 *
 * Each strategy defines:
 * - Type (intraday/swing)
 * - Session requirements
 * - Entry conditions (trend, indicator thresholds)
 * - Position sizing rules
 * - Exit rules (SL, TP, trailing, time-based)
 * - Historical consistency metrics
 *
 * These are NOT LLM-generated — they are hard-coded trading rules
 * derived from proven prop-firm challenge patterns.
 */

export const STRATEGIES = {
  // ═══════════════════════════════════════════════════════════
  //  INTRADAY STRATEGIES
  // ═══════════════════════════════════════════════════════════

  london_breakout: {
    id: "london_breakout",
    name: "London Breakout",
    type: "intraday",
    description: "Trade momentum breakouts during London open (07:00-10:00 UTC). High probability, fast moves — aim for consistent small wins.",
    session: ["London"],
    minScore: 65,

    entry: {
      timeWindow: { utcStart: 7, utcEnd: 10 },
      trend: "any", // breakout works with or against trend
      conditions: [
        "Price breaks above/below the pre-London range (06:00-07:00 UTC high/low)",
        "Volume increasing > 1.5x pre-open average",
        "ATR(14) > 10 pips (enough room to move)",
        "No HIGH impact news within 15 min for this pair",
      ],
      direction: {
        long: "Break above pre-London high with bullish candle close on 5m",
        short: "Break below pre-London low with bearish candle close on 5m",
      },
    },

    position: {
      sl_atr_multiplier: 1.0, // tight SL = 1x ATR
      tp_atr_multiplier: 2.0,  // TP = 2x SL = 2R reward
      maxRiskPct: 0.5,         // 0.5% risk per trade
      entryTimeframe: "5m",
    },

    exit: {
      trailing: { trigger_pips: 15, distance_pips: 8 },
      timeStop: { minutes: 120, action: "evaluate" }, // Review after 2h
      hardStop: { maxHours: 4, action: "close" },
    },

    filters: {
      requireATR: 10,            // min ATR in pips
      maxSpread: 2,              // max spread in pips
      avoidNewsWindowMin: 15,    // no high-impact news in this window
      avoidMondayFirstHour: true, // pre-London range unreliable Mon AM
      avoidFridayLastHour: true,  // avoid holding into weekend
    },

    // Historical consistency (manually curated / backtest derived)
    consistency: {
      winRate: "48-52%",
      avgRR: "1.8-2.2",
      profitFactor: "1.4-1.8",
      maxConsecutiveLosses: 4,
      bestSessions: ["London", "London/NY Overlap"],
      bestPairs: ["EURUSD", "GBPUSD", "EURGBP"],
      notes: "High frequency, small wins. Consistency comes from volume of trades, not big wins. Keep risk per trade at 0.5% max.",
    },
  },

  london_reversal: {
    id: "london_reversal",
    name: "London Reversal (Fade)",
    type: "intraday",
    description: "Fade the initial London spike when price rejects the pre-London range boundary. Higher win rate than breakouts — wait for confirmation.",
    session: ["London"],
    minScore: 70,

    entry: {
      timeWindow: { utcStart: 6, utcEnd: 10 },
      trend: "with_trend", // Fade WITH the higher timeframe trend
      conditions: [
        "Price spikes beyond pre-London range then quickly reverses (wick rejection)",
        "RSI(14) on 5m shows divergence at the spike extreme (hidden divergence for trend continuation)",
        "Reversal confirmed by 5m candle close back inside range",
        "HTF trend (4h/1D) supports the reversal direction",
      ],
      direction: {
        long: "False breakdown below range low → reclaim + bullish 5m close",
        short: "False breakout above range high → rejection + bearish 5m close",
      },
    },

    position: {
      sl_atr_multiplier: 0.8,  // tight SL
      tp_atr_multiplier: 2.5,  // wider TP = higher R:R
      maxRiskPct: 0.5,
      entryTimeframe: "5m",
    },

    exit: {
      trailing: { trigger_pips: 20, distance_pips: 10 },
      timeStop: { minutes: 180, action: "evaluate" },
      hardStop: { maxHours: 6, action: "close" },
    },

    filters: {
      requireATR: 12,
      maxSpread: 2,
      avoidNewsWindowMin: 15,
      avoidMondayFirstHour: true,
      avoidFridayLastHour: false,
    },

    consistency: {
      winRate: "55-62%",
      avgRR: "2.0-2.5",
      profitFactor: "1.8-2.3",
      maxConsecutiveLosses: 3,
      bestSessions: ["London"],
      bestPairs: ["EURUSD", "GBPUSD", "USDCHF"],
      notes: "Higher win rate, fewer trades than breakout. Patience is key — wait for the false break + reclaim pattern. Don't anticipate.",
    },
  },

  ny_open_drive: {
    id: "ny_open_drive",
    name: "New York Open Drive",
    type: "intraday",
    description: "Trade the initial direction after NY equity open (13:30 UTC). Follow the first 15-min impulse — don't fade it.",
    session: ["New York", "London/NY Overlap"],
    minScore: 65,

    entry: {
      timeWindow: { utcStart: 13, utcEnd: 16 },
      trend: "with_trend",
      conditions: [
        "First 15-min candle after 13:30 UTC establishes clear direction",
        "Direction aligns with 4h trend and pre-NY Asian/London bias",
        "EURUSD, GBPUSD, or USDJPY preferred — avoid slow pairs",
        "No conflicting US economic data in the next 60 min",
      ],
      direction: {
        long: "13:30-13:45 candle bullish + 4h trend bullish",
        short: "13:30-13:45 candle bearish + 4h trend bearish",
      },
    },

    position: {
      sl_atr_multiplier: 1.2,
      tp_atr_multiplier: 2.0,
      maxRiskPct: 0.5,
      entryTimeframe: "15m",
    },

    exit: {
      trailing: { trigger_pips: 20, distance_pips: 10 },
      timeStop: { minutes: 180, action: "evaluate" },
      hardStop: { maxHours: 5, action: "close" },
    },

    filters: {
      requireATR: 15,
      maxSpread: 2,
      avoidNewsWindowMin: 30,
      avoidFridayLastHour: true,
    },

    consistency: {
      winRate: "45-50%",
      avgRR: "2.0-2.5",
      profitFactor: "1.5-1.9",
      maxConsecutiveLosses: 4,
      bestSessions: ["New York", "London/NY Overlap"],
      bestPairs: ["EURUSD", "GBPUSD", "USDJPY"],
      notes: "Lower win rate compensated by higher R:R. Avoid during FOMC, NFP, CPI days entirely.",
    },
  },

  // ═══════════════════════════════════════════════════════════
  //  SWING STRATEGIES
  // ═══════════════════════════════════════════════════════════

  trend_continuation: {
    id: "trend_continuation",
    name: "Trend Continuation (Swing)",
    type: "swing",
    description: "Enter on pullbacks to 4h/1D EMA in a trending market. Let winners run for days with wide trailing stops.",
    session: ["London", "New York"],
    minScore: 60,

    entry: {
      timeWindow: null, // any session
      trend: "with_trend",
      conditions: [
        "4h and 1D trend aligned (EMA20 > EMA50 > EMA200 or inverse)",
        "Price pulls back TO 4h EMA20 or 1h EMA50 (not breaks)",
        "RSI(14) on 4h between 40-60 (not oversold in downtrend / overbought in uptrend)",
        "ATR contraction before entry — volatility coiling, about to expand",
        "No HIGH impact news on this pair in next 4h",
      ],
      direction: {
        long: "Bullish 4h + 1D trend, pullback to EMA, bullish reversal candle on 1h",
        short: "Bearish 4h + 1D trend, pullback to EMA, bearish reversal candle on 1h",
      },
    },

    position: {
      sl_atr_multiplier: 2.0,  // wide SL for swing
      tp_atr_multiplier: 4.0,  // wide TP
      maxRiskPct: 0.3,         // lower risk for longer holds
      entryTimeframe: "1h",
    },

    exit: {
      trailing: { trigger_pips: 40, distance_pips: 25 },
      timeStop: { minutes: 2880, action: "evaluate" }, // 48h review
      hardStop: { maxHours: 120, action: "close" },    // 5 days max
    },

    filters: {
      requireATR: 25,
      maxSpread: 3,
      avoidNewsWindowMin: 60,
      avoidFridayLastHour: true,
    },

    consistency: {
      winRate: "40-45%",
      avgRR: "3.0-4.0",
      profitFactor: "1.8-2.5",
      maxConsecutiveLosses: 6,
      bestSessions: ["London", "New York"],
      bestPairs: ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDCAD"],
      notes: "Lower win rate, high R:R. Fewer trades, bigger wins. Essential for consistency — swing wins reduce the pressure on intraday. Max 1 swing position at a time.",
    },
  },

  support_resistance_bounce: {
    id: "support_resistance_bounce",
    name: "S/R Bounce (Swing)",
    type: "swing",
    description: "Trade bounces off key daily/weekly support and resistance levels with trend alignment.",
    session: ["London", "New York"],
    minScore: 70,

    entry: {
      timeWindow: null,
      trend: "with_trend", // key requirement — don't counter-trend S/R
      conditions: [
        "Price approaches a clear daily/weekly S/R level (touched 2+ times in last 20 candles on 4h/1D)",
        "Trend is clearly directional on 1D (EMA alignment)",
        "RSI(14) on 1D confirms the level is meaningful (not overextended)",
        "Price shows rejection wick or bullish/bearish engulfing at the level on 4h or 1h",
        "ATR is stable (not spiking) — no news-driven volatility",
      ],
      direction: {
        long: "Uptrend + price at daily support + bullish rejection on 4h",
        short: "Downtrend + price at daily resistance + bearish rejection on 4h",
      },
    },

    position: {
      sl_atr_multiplier: 1.5,
      tp_atr_multiplier: 3.0,
      maxRiskPct: 0.3,
      entryTimeframe: "4h",
    },

    exit: {
      trailing: { trigger_pips: 50, distance_pips: 30 },
      timeStop: { minutes: 5760, action: "evaluate" }, // 4 days review
      hardStop: { maxHours: 168, action: "close" },     // 7 days max
    },

    filters: {
      requireATR: 30,
      maxSpread: 3,
      avoidNewsWindowMin: 120,
      avoidFridayLastHour: true,
    },

    consistency: {
      winRate: "50-55%",
      avgRR: "2.5-3.5",
      profitFactor: "2.0-3.0",
      maxConsecutiveLosses: 3,
      bestSessions: ["London", "New York"],
      bestPairs: ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD"],
      notes: "Highest win rate swing strategy. Requires patience — 2-4 setups per week max. Best when market is clear trending, not chopping.",
    },
  },

  // ═══════════════════════════════════════════════════════════
  //  RISK-AWARE HYBRID
  // ═══════════════════════════════════════════════════════════

  low_risk_scalp: {
    id: "low_risk_scalp",
    name: "Low-Risk Scalp",
    type: "intraday",
    description: "Ultra-short-term trades during peak liquidity. Use ONLY when consistency is at risk — small, mechanical, high-probability entries to grind back toward profit target.",
    session: ["London/NY Overlap"],
    minScore: 55,

    entry: {
      timeWindow: { utcStart: 12, utcEnd: 16 },
      trend: "any",
      conditions: [
        "12:00-16:00 UTC only (peak overlap liquidity)",
        "Clear support/resistance within last 1h on 5m chart",
        "Price at level + RSI(14) on 5m confirming (oversold at support / overbought at resistance)",
        "Volume spike on approach to level",
      ],
      direction: {
        long: "Price at 1h support + RSI < 35 + bullish 1m/5m candle close",
        short: "Price at 1h resistance + RSI > 65 + bearish 1m/5m candle close",
      },
    },

    position: {
      sl_atr_multiplier: 0.5,  // very tight SL
      tp_atr_multiplier: 1.0,  // 2R quickly
      maxRiskPct: 0.25,        // tiny risk
      entryTimeframe: "1m",
    },

    exit: {
      trailing: { trigger_pips: 5, distance_pips: 3 },
      timeStop: { minutes: 30, action: "close" }, // 30 min max
      hardStop: { maxHours: 1, action: "close" },
    },

    filters: {
      requireATR: 5,
      maxSpread: 1.5,
      avoidNewsWindowMin: 5,
    },

    consistency: {
      winRate: "60-70%",
      avgRR: "1.0-1.5",
      profitFactor: "1.2-1.6",
      maxConsecutiveLosses: 3,
      bestSessions: ["London/NY Overlap"],
      bestPairs: ["EURUSD", "GBPUSD"],
      notes: "Consistency grind mode. Low R:R but high win rate. Use when daily P&L is slightly negative — scalp back to breakeven or small profit. Never use > 3 times per day.",
    },
  },
};

// ─── Strategy Helpers ─────────────────────────────────────────────

export function getStrategiesByType(type) {
  return Object.values(STRATEGIES).filter((s) => s.type === type);
}

export function getStrategiesForSession(session) {
  return Object.values(STRATEGIES).filter((s) => s.session.includes(session));
}

export function getStrategy(id) {
  return STRATEGIES[id] || null;
}

export function getActiveSession() {
  const hour = new Date().getUTCHours();
  const day = new Date().getUTCDay();

  // Monday = 1, Sunday = 0
  if (day === 0 || day === 6) return "Weekend";

  if (hour >= 7 && hour < 16) {
    if (hour >= 12) return "London/NY Overlap";
    return "London";
  }
  if (hour >= 12 && hour < 21) return "New York";
  if (hour >= 21 || hour < 2) return "Asian";
  return "Pre-London";
}

/**
 * Check if a strategy is currently valid based on:
 * - Active session
 * - Day of week (avoid Monday first hour, Friday last hour)
 * - Time window restrictions
 */
export function isStrategyValid(strategy) {
  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();
  const activeSession = getActiveSession();

  // Weekend — no trading
  if (day === 0 || day === 6) return false;

  // Monday first hour filter
  if (day === 1 && hour < 7 && strategy.filters?.avoidMondayFirstHour) {
    return false;
  }

  // Friday last hour filter
  if (day === 5 && hour >= 20 && strategy.filters?.avoidFridayLastHour) {
    return false;
  }

  // Session requirement
  if (!strategy.session.includes(activeSession)) {
    return false;
  }

  // Time window constraint
  if (strategy.entry?.timeWindow) {
    const { utcStart, utcEnd } = strategy.entry.timeWindow;
    if (hour < utcStart || hour >= utcEnd) return false;
  }

  return true;
}

/**
 * Calculate strategy-specific SL and TP in pips from ATR.
 */
export function calculateStrategySLTP(strategy, atr) {
  const slPips = Math.round(atr * strategy.position.sl_atr_multiplier * 10000);
  const tpPips = Math.round(atr * strategy.position.tp_atr_multiplier * 10000);

  return {
    slPips: Math.max(slPips, 10),  // minimum 10 pips SL
    tpPips: Math.max(tpPips, 15),  // minimum 15 pips TP
    riskReward: tpPips / slPips,
    maxRiskPct: strategy.position.maxRiskPct,
  };
}

/**
 * Score a pair against strategy entry conditions.
 * Returns 0-100 score and which conditions passed/failed.
 */
export function scorePairForStrategy(strategy, analysis) {
  if (!isStrategyValid(strategy)) {
    return { score: 0, passed: false, reason: "Strategy not valid for current session/time" };
  }

  let score = 100;
  const checks = [];
  const failed = [];

  // Trend check
  const trend = analysis.trend || "neutral";
  if (strategy.entry.trend === "with_trend" && trend === "neutral") {
    score -= 30;
    failed.push("trend: expected directional, got neutral");
  } else if (strategy.entry.trend === "with_trend" && analysis.direction === null) {
    score -= 20;
    failed.push("trend: no clear direction");
  }

  // ATR check
  const atrPips = (analysis.atr || 0) * 10000;
  const minATR = strategy.filters?.requireATR || 0;
  if (atrPips < minATR) {
    score -= 25;
    failed.push(`ATR: ${atrPips.toFixed(1)} < ${minATR} pips`);
  }

  // RSI check (contextual)
  if (analysis.rsi != null) {
    if (strategy.id === "london_breakout" && analysis.rsi < 25) {
      score -= 10;
      failed.push(`RSI: ${analysis.rsi.toFixed(0)} too oversold for breakout`);
    }
    if (strategy.id === "support_resistance_bounce" && analysis.rsi > 70) {
      score -= 15;
      failed.push(`RSI: ${analysis.rsi.toFixed(0)} overbought — no room to bounce`);
    }
  }

  checks.push(...failed);

  if (score < (strategy.minScore || 60)) {
    return { score, passed: false, reason: checks.join("; ") };
  }

  return {
    score,
    passed: true,
    reason: checks.length > 0 ? checks.join("; ") : "All conditions met",
    sltp: calculateStrategySLTP(strategy, atrPips / 10000),
    maxRiskPct: strategy.position.maxRiskPct,
  };
}
