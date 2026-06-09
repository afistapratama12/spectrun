import nodeCron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getAccountStatus, getOpenPositions, getTodayClosedTrades } from "./tradelocker/account.js";
import { getRiskReport, updateDailySnapshot, checkPhaseTransition } from "./risk-manager.js";
import { getChallengeState, getStateSummary } from "./state.js";
import { executeTool } from "./tools/executor.js";
import { generateBriefing } from "./briefing.js";
import { getForexNews, formatNewsForPrompt } from "./news.js";
import { getPerformanceSummary } from "./lessons.js";
import { connectWebSocket, disconnectWebSocket } from "./tradelocker/client.js";
import { REPO_ROOT } from "./repo-root.js";

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const indexPath = fileURLToPath(import.meta.url);
const isMain = process.env.pm_id != null
  || (entrypointPath ? path.resolve(entrypointPath) === indexPath : false);

if (isMain) {
  log("startup", "Spectrun AI Trader starting...");
  log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN — paper trading" : "LIVE — real trading"}`);
  log("startup", `Phase: ${config.challenge.phase.toUpperCase()}`);
}

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  scannerLastRun: null,
  managerLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const scan = formatCountdown(nextRunIn(timers.scannerLastRun, config.schedule.scannerIntervalMin));
  const mgmt = formatCountdown(nextRunIn(timers.managerLastRun, config.schedule.managerIntervalMin));
  return `[scan: ${scan} | manage: ${mgmt}]\n> `;
}

// ═══════════════════════════════════════════
//  CYCLE FUNCTIONS
// ═══════════════════════════════════════════
let _managerBusy = false;
let _scannerBusy = false;

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function runScannerCycle() {
  if (_scannerBusy) return;
  _scannerBusy = true;
  timers.scannerLastRun = Date.now();

  log("cron", "Starting SCANNER cycle");
  try {
    const { content } = await agentLoop(
      `SCANNER CYCLE

Follow the mandatory steps in the system prompt:
1. Check news first
2. Check rules 
3. Scan markets
4. Only deploy if you have REAL conviction — no trade is better than a bad trade
5. Report result in 1-3 lines.`,
      config.llm.maxSteps,
      [],
      "SCANNER",
      config.llm.scannerModel,
      2048
    );
    log("cron", `Scanner result: ${stripThink(content).slice(0, 200)}`);
  } catch (error) {
    log("cron_error", `Scanner cycle failed: ${error.message}`);
  } finally {
    _scannerBusy = false;
  }
}

async function runManagerCycle() {
  if (_managerBusy) return;
  _managerBusy = true;
  timers.managerLastRun = Date.now();

  log("cron", "Starting MANAGER cycle");
  try {
    const positions = await getOpenPositions();
    if (positions.length === 0) {
      log("cron", "No open positions — manager cycle skipped");
      return;
    }

    // Check phase transition
    const account = await getAccountStatus();
    updateDailySnapshot(account);
    const transition = checkPhaseTransition(account, positions, []);
    if (transition.shouldTransition) {
      log("cron", `Phase transition: ${transition.from} → ${transition.to}`);
    }

    const { content } = await agentLoop(
      `MANAGER CYCLE — ${positions.length} open position(s)

Review each position:
- Trail stops on profitable trades
- Check for time decay (>4h no profit)
- Check news buffer
- Report a short summary`,
      config.llm.maxSteps,
      [],
      "MANAGER",
      config.llm.managerModel,
      2048
    );
    log("cron", `Manager result: ${stripThink(content).slice(0, 200)}`);
  } catch (error) {
    log("cron_error", `Manager cycle failed: ${error.message}`);
  } finally {
    _managerBusy = false;
  }
}

// ═══════════════════════════════════════════
//  CRON JOBS
// ═══════════════════════════════════════════
let _cronTasks = [];

function startCronJobs() {
  stopCronJobs();

  const scannerTask = nodeCron.schedule(
    `*/${Math.max(1, config.schedule.scannerIntervalMin)} * * * *`,
    runScannerCycle
  );

  const managerTask = nodeCron.schedule(
    `*/${Math.max(1, config.schedule.managerIntervalMin)} * * * *`,
    runManagerCycle
  );

  const briefingTask = nodeCron.schedule(
    `0 ${config.schedule.dailyBriefingHourUTC} * * *`,
    async () => {
      try {
        const briefing = await generateBriefing();
        log("cron", "Daily briefing generated");
      } catch (e) {
        log("cron_error", `Briefing failed: ${e.message}`);
      }
    },
    { timezone: "UTC" }
  );

  _cronTasks = [scannerTask, managerTask, briefingTask];
  log("cron", `Cycles: scanner ${config.schedule.scannerIntervalMin}m, manager ${config.schedule.managerIntervalMin}m`);
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  _cronTasks = [];
}

// ═══════════════════════════════════════════
//  SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopCronJobs();
  disconnectWebSocket();

  try {
    const account = await getAccountStatus();
    log("shutdown", `Final equity: $${account.equity.toFixed(2)}`);
  } catch {
    // ignore
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
let _ttyInterface = null;
const sessionHistory = [];
const MAX_HISTORY = 20;

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }, 10_000);

  console.log(`
╔═══════════════════════════════════════════╗
║      Spectrun — AI Prop-Firm Trader       ║
╚═══════════════════════════════════════════╝
`);

  busy = true;
  (async () => {
    try {
      const account = await getAccountStatus();
      const positions = await getOpenPositions();
      const state = getStateSummary();

      console.log(`Phase:    ${state.phase.toUpperCase()}`);
      console.log(`Equity:   $${account.equity.toFixed(2)}`);
      console.log(`Balance:  $${account.balance.toFixed(2)}`);
      console.log(`Positions: ${positions.length} open`);
      console.log(`Mode:     ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}\n`);
    } catch (e) {
      console.log(`Startup info unavailable: ${e.message}\n`);
    } finally {
      busy = false;
    }
  })();

  startCronJobs();
  cronStarted = true;

  console.log(`Commands: /status /positions /scan /manage /news /briefing /config /stop\n`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      busy = true;
      try {
        const account = await getAccountStatus();
        const positions = await getOpenPositions();
        const riskReport = getRiskReport(account, positions, []);
        console.log(`\n${riskReport}\n`);
      } catch (e) {
        console.log(`Error: ${e.message}`);
      } finally {
        busy = false;
        rl.prompt();
      }
      return;
    }

    if (input === "/positions") {
      busy = true;
      try {
        const positions = await getOpenPositions();
        if (positions.length === 0) {
          console.log("\nNo open positions.\n");
        } else {
          console.log(`\n📊 ${positions.length} Open Positions:`);
          for (const p of positions) {
            console.log(`  ${p.symbol} ${p.type} | ${p.volume} lots | Entry: ${p.openPrice} | Current: ${p.currentPrice} | P&L: $${p.profit?.toFixed(2) || "?"}`);
          }
          console.log();
        }
      } catch (e) {
        console.log(`Error: ${e.message}`);
      } finally {
        busy = false;
        rl.prompt();
      }
      return;
    }

    if (input === "/news") {
      busy = true;
      try {
        const events = await getForexNews({ hoursAhead: 24 });
        console.log(`\n${formatNewsForPrompt(events)}\n`);
      } catch (e) {
        console.log(`Error: ${e.message}`);
      } finally {
        busy = false;
        rl.prompt();
      }
      return;
    }

    if (input === "/scan") {
      busy = true;
      try {
        console.log("\nRunning scanner cycle...\n");
        await runScannerCycle();
        console.log();
      } finally {
        busy = false;
        rl.prompt();
      }
      return;
    }

    if (input === "/manage") {
      busy = true;
      try {
        console.log("\nRunning manager cycle...\n");
        await runManagerCycle();
        console.log();
      } finally {
        busy = false;
        rl.prompt();
      }
      return;
    }

    if (input === "/briefing") {
      busy = true;
      try {
        const briefing = await generateBriefing();
        console.log(`\n${briefing}\n`);
      } catch (e) {
        console.log(`Error: ${e.message}`);
      } finally {
        busy = false;
        rl.prompt();
      }
      return;
    }

    if (input === "/config") {
      busy = true;
      try {
        const cfg = config;
        console.log(`
Challenge:  phase=${cfg.challenge.phase} target=${cfg.challenge.profitTargetPct}% dailyLoss=${cfg.challenge.maxDailyLossPct}% totalDD=${cfg.challenge.maxTotalLossPct}%
Risk:       perTrade=${cfg.risk.riskPerTradePct}% maxDaily=${cfg.risk.maxDailyTrades} consecutiveLoss=${cfg.risk.maxConsecutiveLosses}
Strategy:   pairs=${cfg.strategy.allowedPairs.join(",")} trend=${cfg.strategy.requireTrendAlignment} news=${cfg.strategy.avoidHighImpactNewsPairs}
Schedule:   scan=${cfg.schedule.scannerIntervalMin}m manage=${cfg.schedule.managerIntervalMin}m
`);
      } catch (e) {
        console.log(`Error: ${e.message}`);
      } finally {
        busy = false;
        rl.prompt();
      }
      return;
    }

    // Free-form chat
    busy = true;
    try {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${stripThink(content)}\n`);
    } catch (e) {
      console.log(`Error: ${e.message}`);
    } finally {
      busy = false;
      rl.prompt();
    }
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY mode — start cycles immediately
  log("startup", "Non-TTY mode — starting cron cycles");
  startCronJobs();
  cronStarted = true;

  // Run scanner once on startup
  setTimeout(() => {
    runScannerCycle().catch((e) => log("startup_error", e.message));
  }, 5000);
}
