import { config } from "./config.js";
import { getAccountStatus, getOpenPositions } from "./tradelocker/account.js";
import { getPerformanceSummary } from "./lessons.js";
import { getForexNews, formatNewsForPrompt } from "./news.js";
import { getChallengeState } from "./state.js";
import { getRiskReport } from "./risk-manager.js";

export async function generateBriefing() {
  const account = await getAccountStatus();
  const positions = await getOpenPositions();
  const perf = getPerformanceSummary();
  const challenge = getChallengeState();
  const riskReport = getRiskReport(account, positions, []);
  const newsEvents = await getForexNews({ hoursAhead: 12 });

  const now = new Date();
  const lines = [
    "☀️ <b>Morning Briefing</b>",
    `Date: ${now.toISOString().slice(0, 10)}  |  Phase: ${config.challenge.phase.toUpperCase()}`,
    "────────────────────────────",
    "",
    "<b>Account Status</b>",
    `💰 Equity: $${account.equity.toFixed(2)}  |  Balance: $${account.balance.toFixed(2)}`,
    `📊 Margin Level: ${account.marginLevel.toFixed(1)}%  |  Free Margin: $${account.freeMargin.toFixed(2)}`,
    `📈 Daily P&L: ${account.profit >= 0 ? "+" : ""}$${account.profit.toFixed(2)}`,
    `📂 Open Positions: ${positions.length}`,
    "",
    "<b>Challenge Progress</b>",
    `🎯 Profit Target: ${config.challenge.profitTargetPct}%`,
    `🛡️ Daily Loss: ${config.challenge.maxDailyLossPct}%  |  Total DD: ${config.challenge.maxTotalLossPct}%`,
    `📅 Started: ${challenge.startedAt?.slice(0, 10) || "unknown"}`,
    "",
    perf ? [
      "<b>Performance</b>",
      `📊 Total Trades: ${perf.totalTrades}  |  Win Rate: ${perf.winRate}%`,
      `💎 Total P&L: ${perf.totalPnl >= 0 ? "+" : ""}$${perf.totalPnl.toFixed(2)}`,
      `📐 Avg R:R: ${perf.avgRiskReward}`,
    ].join("\n") : "",
    "",
    "<b>Upcoming News (12h)</b>",
    newsEvents.length > 0 ? formatNewsForPrompt(newsEvents) : "No high-impact events.",
    "",
    "────────────────────────────",
    "<b>Risk Status</b>",
    riskReport,
  ].filter(Boolean).join("\n");

  return lines;
}
