const toolDefinitions = [
  // ═══════════════════════════════════════════
  //  ACCOUNT & RISK TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_account_status",
      description: `Get the full trading account status: equity, balance, margin, daily P&L, drawdown from peak, open positions count, and challenge phase progress.

Use this at the start of every scanner and manager cycle. This is the single source of truth for all risk calculations.`,
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_challenge_rules",
      description: `Run all prop-firm challenge rules against the current account state. Returns:
- Can a new trade be opened right now?
- Daily loss remaining (absolute and %)
- Total drawdown from peak
- Consistency rule status (any single day > X% of total profit?)
- Consecutive loss cooldown
- Block reasons if any

Use this BEFORE calling place_trade to ensure the trade won't violate challenge rules.
Rules are enforced in code — the LLM cannot override them.`,
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate_position_size",
      description: `Calculate the correct lot size based on account equity, risk %, stop loss in pips, and symbol.
Returns the lot size, risk amount in dollars, and breakdown of the calculation.

This tool ALWAYS calculates lot size in code — never trust the LLM to calculate it.
The LLM provides the SL pips and direction; this tool returns the exact lot size.`,
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading symbol e.g. EURUSD" },
          sl_pips: { type: "number", description: "Stop loss distance in pips" },
        },
        required: ["symbol", "sl_pips"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  MARKET ANALYSIS TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_pair_analysis",
      description: `Deep-dive technical analysis on a single forex pair across multiple timeframes.
Returns:
- Current price, spread, ATR(14)
- Trend direction (bullish/bearish/neutral) from EMA alignment
- RSI(14) on entry timeframe
- Support and resistance levels
- Multi-timeframe trend confirmation
- Session volatility profile

Use this when you need to evaluate whether a pair has a valid trade setup.`,
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading symbol e.g. EURUSD" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_markets",
      description: `Scan all configured forex pairs and return viable trade setups sorted by conviction.
Each pair gets a quick technical check:
- Trend alignment across multiple timeframes
- RSI status (oversold/overbought/neutral)
- ATR for volatility context
- Whether price is at a key level

Returns the top N setups with direction, estimated SL/TP, and confidence score.
Use this as the primary tool for finding new trade opportunities.`,
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of top setups to return. Default 5." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_forex_news",
      description: `Get upcoming high-impact news events for the next 24 hours.
Returns events with time, currency, impact level, forecast/actual/previous.
Use this to avoid trading pairs that have major news releases within the buffer window.`,
      parameters: {
        type: "object",
        properties: {
          hours_ahead: { type: "number", description: "How many hours ahead to look. Default 24." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_news_buffer",
      description: `Check if a currency pair has high-impact news within the buffer window.
Returns whether trading should be blocked for this pair, and which events are conflicting.
Use this BEFORE placing any trade on a pair.`,
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading symbol e.g. EURUSD" },
        },
        required: ["symbol"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  TRADE EXECUTION TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "place_trade",
      description: `Place a new trade with stop loss and take profit.

CRITICAL: You MUST call calculate_position_size first to get the correct lot size. Do NOT guess or hardcode the lot size.

The risk manager enforces max daily loss, total drawdown, position limits, and news buffer rules before allowing the trade to execute.

WARNING: This executes a real trade on the account. Check DRY_RUN mode.`,
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading symbol e.g. EURUSD" },
          type: { type: "string", enum: ["buy", "sell"], description: "Direction — buy (long) or sell (short)" },
          volume: { type: "number", description: "Lot size from calculate_position_size tool" },
          sl_pips: { type: "number", description: "Stop loss distance in pips from entry" },
          tp_pips: { type: "number", description: "Take profit distance in pips from entry" },
          reason: { type: "string", description: "Brief trade rationale for the decision log" },
        },
        required: ["symbol", "type", "volume", "sl_pips", "tp_pips"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_open_trades",
      description: `List all currently open trades with:
- Ticket ID, symbol, direction, lot size
- Entry price, current price
- Stop loss and take profit levels
- Current P&L in dollars and pips
- Time open

Use this at the start of every manager cycle.`,
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "close_trade",
      description: `Close a specific trade by ticket ID.
Use when:
- Trade has reached its time decay limit (stagnant > 4h with no profit)
- Technical reversal confirmed
- Manual override from Telegram
- Approaching daily loss limit

WARNING: This executes a real trade on the account.`,
      parameters: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "The trade ticket/position ID" },
          reason: { type: "string", description: "Why this trade is being closed" },
        },
        required: ["ticket"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_all_trades",
      description: `Emergency close ALL open trades immediately.
Use only for emergency situations:
- Approaching daily loss limit
- Major unexpected news event
- Manual shutdown

WARNING: This closes ALL positions without discrimination.`,
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Emergency reason for closing all" },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "modify_trade",
      description: `Modify the stop loss and/or take profit of an open trade.
Use for:
- Trailing stop (move SL in profitable direction)
- Tightening TP as target approaches
- Moving SL to breakeven`,
      parameters: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "Trade ticket/position ID" },
          sl: { type: "number", description: "New stop loss price (optional)" },
          tp: { type: "number", description: "New take profit price (optional)" },
        },
        required: ["ticket"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  CONFIG & LEARNING TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "update_config",
      description: `Update runtime configuration. Changes persist to user-config.json.
Valid keys: riskPerTradePct, maxDailyTrades, maxConsecutiveLosses, trailingStopEnabled, trailingTriggerPips, trailingDistancePips, scannerIntervalMin, managerIntervalMin, scannerModel, managerModel, generalModel, allowedPairs, requireTrendAlignment, avoidHighImpactNewsPairs, minRiskRewardRatio, maxOpenPositions, maxDailyLossPct, maxTotalLossPct, profitTargetPct, consistencyMinPct`,
      parameters: {
        type: "object",
        properties: {
          changes: { type: "object", description: "Key-value pairs of settings to update" },
          reason: { type: "string", description: "Why this change is being made" },
        },
        required: ["changes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_performance_history",
      description: `Get closed trade performance records.
Returns individual trades with P&L, R:R, win rate, hold time, setup type.
Use for performance analysis and learning.`,
      parameters: {
        type: "object",
        properties: {
          hours: { type: "number", description: "How many hours to look back (default 168 = 7 days)" },
          limit: { type: "number", description: "Max records to return (default 50)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_decisions",
      description: `Get recent trade decisions (entries, exits, skips) with recorded reasoning.
Use when asked "why did you enter/exit/skip that trade?"`,
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many decisions (default 6)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_lesson",
      description: `Save a trading lesson to permanent memory.
Lessons are injected into future agent cycles.
Examples:
- "PREFER: EURUSD long during London session with 1h/4h trend alignment"
- "AVOID: trading USDJPY within 30min of FOMC / NFP"`,
      parameters: {
        type: "object",
        properties: {
          rule: { type: "string", description: "The lesson — specific and actionable" },
          tags: { type: "array", items: { type: "string" }, description: "Tags e.g. ['strategy', 'session', 'risk']" },
          role: { type: "string", enum: ["SCANNER", "MANAGER", "GENERAL"], description: "Which agent this applies to" },
        },
        required: ["rule"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  STRATEGY & CONSISTENCY TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "scan_strategies",
      description: `List all trading strategies with their type (intraday/swing), current validity, risk parameters, and historical consistency metrics.

Use this to understand which strategies are active right now for the current trading session.
Returns: active session, total strategies, which are valid now, win rate estimates, R:R ranges.`,
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["intraday", "swing"], description: "Filter by strategy type. Omit for all." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_consistency_report",
      description: `Get full consistency report: overall win rate, avg R:R, profit factor, rolling 20-trade stats per strategy, daily P&L breakdown, and recommendations.

Use this to check if you're maintaining the minimum 40% consistency rate. If not, the report will suggest corrective actions (switch strategies, reduce risk, increase selectivity).`,
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_strategy_usage",
      description: `Check strategy diversity — are you using a balanced mix of intraday and swing strategies? Returns percentage split and recommendations.
Use this to ensure you're not overusing one strategy type.`,
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_daily_consistency",
      description: `Check if a projected new trade would violate the daily consistency rule (no single day > 40% of total challenge profit).
Call this BEFORE placing a trade — if it returns violatesConsistency=true, reduce position size or wait for tomorrow.`,
      parameters: {
        type: "object",
        properties: {
          strategy_id: { type: "string", description: "Strategy ID from scan_markets" },
          projected_pnl: { type: "number", description: "Estimated P&L of this trade if it hits TP (optional, default 0)" },
        },
      },
    },
  },
];

export const tools = toolDefinitions.map((tool) => ({
  ...tool,
  function: {
    ...tool.function,
    parameters: tool.function.parameters?.type === "object"
      ? { additionalProperties: false, ...tool.function.parameters }
      : tool.function.parameters,
  },
}));
