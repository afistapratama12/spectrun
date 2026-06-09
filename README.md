# Spectrun

**AI Autonomous Forex Trader for Prop-Firm Challenges — powered by LLMs via TradeLocker.**

Spectrun runs a Meridian-style ReAct agent loop, continuously scanning forex markets, executing trades, and managing positions — all while enforcing prop-firm challenge rules (daily drawdown, consistency, profit target) in hard code, never left to LLM discretion.

---

## What it does

- **Scans markets** — evaluates all configured forex pairs with multi-timeframe technical analysis (trend, momentum, volatility, session context) and surfaces high-conviction trade setups
- **Manages trades** — monitors open positions, activates trailing stops, evaluates time-decay, and closes positions based on technical context and risk limits
- **Enforces challenge rules** — hard-coded risk engine tracks daily loss, total drawdown, consistency, consecutive loss cooldowns, and news buffers. The LLM *cannot* override these.
- **Learns from performance** — records every closed trade, derives lessons from wins and losses, and injects them into future agent cycles
- **Forex news integration** — scrapes ForexFactory for high-impact events, blocks trading on affected pairs within configurable buffer windows
- **TradeLocker native** — full REST API integration for account status, order execution, position management, and OHLCV data
- **CLI** — every tool accessible directly from the terminal with JSON output

---

## How it works

Spectrun runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Scanner Agent** | Every 30 min | Market scanning — finds high-conviction trade setups and executes entries |
| **Manager Agent** | Every 10 min | Trade management — monitors positions, trails stops, closes on rules |

### Agent harness

The agent harness is the runtime wrapper around every autonomous cycle. It loads live account state, injects relevant risk reports and lessons, exposes only role-appropriate tools, executes tool calls, and returns a readable cycle summary.

The harness also keeps a structured decision log in `decision-log.json` for entries, exits, and skips. Each entry records the actor, symbol, summary, reason, and key metrics. Recent decisions are injected into the system prompt so the agent can answer "why did you enter?" or "why did you skip?" without guessing.

### Risk enforcement

All challenge rules are enforced in **`risk-manager.js`** — not in the LLM. Before any trade is placed, the executor validates:

- Daily loss limit (default 4% from start-of-day equity)
- Total drawdown from peak (default 8%)
- Position count limit (default 3)
- News buffer (no trading on pairs with imminent high-impact events)
- Consecutive loss cooldown
- Daily trade limit
- Position size (always calculated in code, never by the LLM)

**Data sources:**
- TradeLocker REST API — account status, order execution, positions, OHLCV candles
- TradeLocker WebSocket — real-time price feed and account updates
- ForexFactory (scraped) — high-impact news calendar
- Economic Calendar API — fallback if scraping fails
- OpenRouter — LLM inference (any compatible model)

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key (or any OpenAI-compatible endpoint)
- TradeLocker account (demo or live)
- Telegram bot token (optional)

---

## Setup

### 1. Clone & install

```bash
git clone <repo-url> spectrun
cd spectrun
npm install
```

### 2. Configure

Create `.env` from the example:

```bash
cp .env.example .env
```

Fill in your credentials:

```env
# TradeLocker
TRADELOCKER_EMAIL=your_email@example.com
TRADELOCKER_PASSWORD=your_password
TRADELOCKER_SERVER=demo           # "demo" or "live"
TRADELOCKER_ACCOUNT_ID=0

# OpenRouter
OPENROUTER_API_KEY=sk-or-...

# Safety — always start with dry run
DRY_RUN=true
```

Create `user-config.json` from the example:

```bash
cp user-config.example.json user-config.json
```

Edit challenge rules, risk parameters, and strategy as needed.

### 3. Run

```bash
npm start    # interactive REPL with autonomous cycles
npm run dev  # same as npm start
```

On startup Spectrun fetches your account status, open positions, and begins autonomous cycles immediately.

---

## Running modes

### Interactive REPL

```bash
npm start
```

Starts the full autonomous agent with cron-based scanning + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[scan: 24m 3s | manage: 8m 12s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Full risk report — equity, daily P&L, drawdown, limits |
| `/positions` | List open trades with P&L |
| `/scan` | Trigger a scanner cycle manually |
| `/manage` | Trigger a manager cycle manually |
| `/news` | Upcoming high-impact events (24h) |
| `/briefing` | Daily performance briefing |
| `/config` | Show current runtime config |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask anything, request trades |

### CLI (direct tool invocation)

```bash
node cli.js <command> [options]
```

**Account:**

```bash
node cli.js status              # Account equity, balance, risk status
node cli.js positions           # List open positions
node cli.js closed 24           # Closed trades in last 24h
```

**Markets:**

```bash
node cli.js news 12             # Upcoming news events (12h)
node cli.js analyze EURUSD      # Deep technical analysis on a pair
```

**Trading:**

```bash
node cli.js place EURUSD buy 0.10 20 30    # Place a trade (symbol, dir, lots, sl_pips, tp_pips)
node cli.js close 123456 "take profit"     # Close a trade
node cli.js close-all "emergency"          # Close all trades
node cli.js place EURUSD buy 0.10 20 30 --dry-run   # Simulate
```

**Info:**

```bash
node cli.js config                       # Show current config
node cli.js config set riskPerTradePct 1 # Update config
node cli.js performance                  # Performance summary
node cli.js decisions 10                 # Recent decisions
node cli.js briefing                     # Daily briefing
```

### Non-TTY / PM2

```bash
npm run pm2:start    # daemonize with PM2
npm run pm2:restart  # restart after code/config changes
npm run pm2:logs     # tail logs
npm run pm2:stop     # stop
```

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Challenge

| Field | Default | Description |
|---|---|---|
| `phase` | `evaluation` | Current phase: `evaluation`, `verification`, or `funded` |
| `profitTargetPct` | `4` | Profit target % |
| `maxDailyLossPct` | `4` | Maximum daily loss from start-of-day equity |
| `maxTotalLossPct` | `8` | Maximum total drawdown from peak equity |
| `minTradingDays` | `4` | Minimum unique trading days |
| `consistencyMinPct` | `25` | No single day > X% of total challenge profit |
| `timeLimitDays` | `30` | Challenge time limit |
| `maxOpenPositions` | `3` | Maximum concurrent positions |
| `newsBufferMinutes` | `15` | No trading N minutes before/after high-impact news |
| `allowedSessions` | `["London","New York"]` | Trading session filter |
| `minRiskRewardRatio` | `1.5` | Minimum TP/SL ratio |

### Risk

| Field | Default | Description |
|---|---|---|
| `riskPerTradePct` | `0.5` | % of equity risked per trade |
| `maxDailyTrades` | `5` | Maximum trades per day |
| `maxConsecutiveLosses` | `3` | Consecutive losses before cooldown |
| `consecutiveLossCooldownMinutes` | `60` | Cooldown duration after consecutive losses |
| `trailingStopEnabled` | `true` | Enable trailing stop |
| `trailingTriggerPips` | `10` | Pips in profit before activating trail |
| `trailingDistancePips` | `5` | Pips to trail behind current price |

### Strategy

| Field | Default | Description |
|---|---|---|
| `trendTimeframes` | `["1h","4h","1D"]` | Timeframes for trend analysis |
| `entryTimeframes` | `["5m","15m"]` | Timeframes for entry signals |
| `allowedPairs` | `["EURUSD",...]` | Forex pairs to trade |
| `requireTrendAlignment` | `true` | Require multi-TF trend agreement |
| `avoidHighImpactNewsPairs` | `true` | Skip pairs with upcoming high-impact news |

### Schedule

| Field | Default | Description |
|---|---|---|
| `scannerIntervalMin` | `30` | Scanner cycle frequency |
| `managerIntervalMin` | `10` | Manager cycle frequency |
| `dailyBriefingHourUTC` | `1` | Daily briefing time (UTC) |

### Models

| Field | Default | Description |
|---|---|---|
| `scannerModel` | `openrouter/healer-alpha` | LLM for scanner cycles |
| `managerModel` | `openrouter/healer-alpha` | LLM for manager cycles |
| `generalModel` | `openrouter/healer-alpha` | LLM for chat/REPL |
| `temperature` | `0.3` | LLM temperature |
| `maxSteps` | `15` | Maximum ReAct loop iterations |

---

## How it learns

### Performance recording

After every closed trade, performance is recorded to `lessons.json`:

- Symbol, direction, volume, entry/exit prices
- P&L ($ and %), risk:reward ratio, hold time
- Session, trend context, close reason

### Lesson derivation

Significant outcomes (good or bad) automatically generate lessons:

```
[GOOD] WORKED: EURUSD buy during London session — PnL +1.2%, trend=bullish.
[BAD]  FAILED: USDJPY sell — PnL -2.1%. Reason: stopped out by news spike.
```

Lessons are injected into future agent cycles as part of the system prompt.

### Manual lessons

```bash
node cli.js lesson add "AVOID: trading GBP pairs during BOE speeches"
```

---

## Challenge phases

### Phase 1: Evaluation (default)

- Profit target: configurable (default 4%)
- Daily loss limit enforced
- Total drawdown enforced
- Consistency rule active
- Phase auto-transitions to Verification when profit target is hit

### Phase 2: Verification

- Profit target: same as evaluation (configurable separately)
- Same risk rules apply
- Auto-transitions to Funded when target is hit

### Funded

- No profit target
- Same risk rules (daily loss + total drawdown)
- Payout tracking (to be implemented)

Phase management is handled in `state.js` and checked every manager cycle. Transitions are logged and persisted.

---

## Architecture

```
index.js              Main entry: REPL + cron orchestrator
agent.js              ReAct loop: LLM → tool call → repeat
prompt.js             System prompt builder (SCANNER / MANAGER / GENERAL roles)
config.js             Runtime config from user-config.json + .env
repo-root.js          Stable absolute repo path
logger.js             Structured logging with action audit trail
risk-manager.js       Hard risk enforcement (daily loss, drawdown, consistency)
state.js              Trade registry, daily snapshots, challenge phase state
news.js               ForexFactory scraper + economic calendar API fallback
lessons.js            Learning engine: performance records, lesson derivation
decision-log.js       Structured decision log for entries, exits, skips
briefing.js           Daily performance briefing generator
cli.js                Direct CLI — all tools as subcommands with JSON output

tools/
  definitions.js      Tool schemas (OpenAI function-calling format)
  executor.js         Tool dispatch + pre-execution safety checks

tradelocker/
  client.js           REST + WebSocket client with OAuth, retry, rate limiting
  account.js          Account status, positions, order history
  market-data.js      OHLCV candles, ATR/RSI/EMA/trend, instrument specs
  trading.js          Place/modify/close orders, lot size calculation
```

---

## Position sizing

Position size is **always calculated in code**, not by the LLM. The formula:

```
risk_amount = equity × (riskPerTradePct / 100)
lot_size    = risk_amount / (sl_pips × pip_value)
```

The LLM provides direction + SL pips. The executor calculates the exact lot size and validates against all risk rules before sending to TradeLocker.

---

## News integration

Spectrun scrapes ForexFactory for high-impact news events. If scraping fails, it falls back to a free economic calendar API.

The `check_news_buffer` tool extracts currencies from the pair symbol (e.g., `EURUSD` → `["EUR", "USD"]`) and checks for HIGH-impact events within the configured buffer window. If a conflict is found, trading on that pair is blocked with a clear reason.

---

## TradeLocker setup

1. Create a TradeLocker demo account at your prop firm's platform
2. Get your credentials (email + password)
3. Set `TRADELOCKER_SERVER=demo` in `.env`
4. Set `DRY_RUN=false` when ready for real trading

The client handles OAuth 2.0 token management (login, refresh, expiry) automatically. WebSocket streams provide real-time price and account updates.

---

## Using a local model

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works. Recommended: set `temperature: 0.3` in `user-config.json` for consistent trading decisions.

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose money, and you can fail prop-firm challenges. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software, including failed prop-firm challenges, lost evaluation fees, or trading losses.
