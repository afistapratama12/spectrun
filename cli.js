import fs from "fs";
import { exec } from "child_process";
import { config, computePositionSize, formatCurrency, formatPct } from "./config.js";
import { executeTool } from "./tools/executor.js";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { getAccountStatus, getOpenPositions } from "./tradelocker/account.js";
import { getForexNews, formatNewsForPrompt } from "./news.js";
import { getRiskReport } from "./risk-manager.js";
import { getPerformanceSummary } from "./lessons.js";
import { getRecentDecisions } from "./decision-log.js";
import { getConsistencyReport } from "./consistency-tracker.js";
import { STRATEGIES, getActiveSession, getStrategiesByType, isStrategyValid } from "./strategies/index.js";

const USAGE = `Spectrun — AI Prop-Firm Trader CLI

Usage: node cli.js <command> [options]

Account:
  status                    Account equity, balance, P&L
  positions                 List open positions
  closed [hours]            Recent closed trades (default 24h)

Markets:
  news [hours]              Upcoming news events (default 24h)
  analyze <symbol>          Deep analysis on a pair
  scan [intraday|swing]     Strategy-aware market scan

Strategy:
  strategies                List all strategies + current validity
  consistency               Full consistency report + 40% min check
  usage                     Strategy mix diversity report
  check <strategy_id> <pnl> Check if trade violates daily consistency

Trade:
  place <symbol> <dir> <lots> <sl> <tp>   Place a trade
  close <ticket> <reason>                 Close a trade
  close-all <reason>                      Emergency close all

Info:
  config                    Show current runtime config
  config set <key> <value>  Update a config value
  performance               Performance summary
  decisions [limit]         Recent trade decisions
  briefing                  Generate daily briefing

Flags:
  --dry-run                 Simulate without executing (overrides env)`;

const [,, command, ...args] = process.argv;

const isDry = args.includes("--dry-run") || process.env.DRY_RUN === "true";

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  if (!command || command === "help") {
    console.log(USAGE);
    return;
  }

  try {
    switch (command) {
      case "status": {
        const account = await getAccountStatus();
        const positions = await getOpenPositions();
        const risk = getRiskReport(account, positions, []);
        printJson({ account: { equity: account.equity, balance: account.balance, margin: account.marginLevel }, risk });
        break;
      }
      case "positions": {
        const positions = await getOpenPositions();
        printJson({ count: positions.length, positions });
        break;
      }
      case "closed": {
        const hours = parseInt(args[0], 10) || 24;
        const result = await executeTool("get_performance_history", { hours, limit: 50 });
        printJson(result);
        break;
      }
      case "news": {
        const hours = parseInt(args[0], 10) || 24;
        const events = await getForexNews({ hoursAhead: hours, forceRefresh: true });
        printJson({ events, formatted: formatNewsForPrompt(events) });
        break;
      }
      case "analyze": {
        const symbol = args[0];
        if (!symbol) { console.log("Usage: analyze <symbol>"); return; }
        const result = await executeTool("get_pair_analysis", { symbol });
        printJson(result);
        break;
      }
      case "place": {
        const [symbol, type, volume, sl, tp] = args;
        if (!symbol || !type || !volume || !sl || !tp) {
          console.log("Usage: place <symbol> <buy|sell> <lots> <sl_pips> <tp_pips> [--dry-run]");
          return;
        }
        const result = await executeTool("place_trade", {
          symbol, type, volume: parseFloat(volume), sl_pips: parseInt(sl), tp_pips: parseInt(tp), reason: "CLI manual",
        });
        printJson(result);
        break;
      }
      case "close": {
        const [ticket, ...reasonParts] = args;
        const reason = reasonParts.join(" ") || "CLI manual";
        if (!ticket) { console.log("Usage: close <ticket> [reason]"); return; }
        const result = await executeTool("close_trade", { ticket, reason });
        printJson(result);
        break;
      }
      case "close-all": {
        const reason = args.join(" ") || "CLI emergency";
        const result = await executeTool("close_all_trades", { reason });
        printJson(result);
        break;
      }
      case "config": {
        if (args[0] === "set" && args[1] && args[2] !== undefined) {
          const key = args[1];
          const raw = args[2];
          const value = raw === "true" ? true : raw === "false" ? false : isNaN(raw) ? raw : Number(raw);
          const result = await executeTool("update_config", { changes: { [key]: value }, reason: "CLI" });
          printJson(result);
        } else {
          printJson({
            challenge: config.challenge,
            risk: config.risk,
            strategy: config.strategy,
            schedule: config.schedule,
          });
        }
        break;
      }
      case "performance": {
        printJson(getPerformanceSummary());
        break;
      }
      case "decisions": {
        const limit = parseInt(args[0], 10) || 10;
        printJson({ decisions: getRecentDecisions(limit) });
        break;
      }
      case "scan": {
        const type = args[0] || null;
        const result = await executeTool("scan_markets", { limit: 10, strategyType: type });
        printJson(result);
        break;
      }
      case "strategies": {
        const type = args[0] || null;
        const result = await executeTool("scan_strategies", { type });
        printJson(result);
        break;
      }
      case "consistency": {
        const report = getConsistencyReport();
        printJson(report);
        break;
      }
      case "usage": {
        const result = await executeTool("get_strategy_usage", {});
        printJson(result);
        break;
      }
      case "check": {
        const [strategyId, pnlStr] = args;
        const result = await executeTool("check_daily_consistency", {
          strategy_id: strategyId, projected_pnl: parseFloat(pnlStr) || 0,
        });
        printJson(result);
        break;
      }
      case "briefing": {
        const { generateBriefing } = await import("./briefing.js");
        const briefing = await generateBriefing();
        console.log(briefing);
        break;
      }
      default:
        console.log(`Unknown command: ${command}\nRun "node cli.js help" for available commands.`);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
