import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { getAccountStatus, getOpenPositions, getTodayClosedTrades } from "./tradelocker/account.js";
import { getRiskReport, updateDailySnapshot } from "./risk-manager.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";
import { config } from "./config.js";
import { log } from "./logger.js";

const SCANNER_TOOLS = new Set([
  "get_account_status", "check_challenge_rules", "calculate_position_size",
  "get_pair_analysis", "scan_markets", "get_forex_news", "check_news_buffer",
  "place_trade", "get_open_trades",
  "scan_strategies", "get_consistency_report", "get_strategy_usage", "check_daily_consistency",
  "get_pattern_report", "query_journal",
]);

const MANAGER_TOOLS = new Set([
  "get_account_status", "check_challenge_rules",
  "get_open_trades", "close_trade", "close_all_trades", "modify_trade",
  "get_forex_news",
  "get_consistency_report", "get_pattern_report",
]);

const GENERAL_PERSIST_TOOLS = new Set([
  "update_config", "add_lesson", "get_performance_history", "get_recent_decisions",
]);

const WRITE_TOOLS = new Set(["place_trade", "close_trade", "close_all_trades", "modify_trade"]);

const ONCE_PER_SESSION = new Set(["place_trade", "close_trade"]);
const NO_RETRY_TOOLS = new Set(["place_trade"]);

function getToolsForRole(agentType) {
  if (agentType === "SCANNER") return tools.filter((t) => SCANNER_TOOLS.has(t.function.name));
  if (agentType === "MANAGER") return tools.filter((t) => MANAGER_TOOLS.has(t.function.name));
  return tools;
}

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "sk-placeholder",
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false } = options;

  const account = await getAccountStatus();
  const positions = await getOpenPositions();
  const closedToday = await getTodayClosedTrades();
  updateDailySnapshot(account);

  const riskReport = getRiskReport(account, positions, closedToday);
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();

  const systemPrompt = buildSystemPrompt(agentType, account, positions, riskReport, lessons, perfSummary, decisionSummary);

  let messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];

  const firedOnce = new Set();
  let sawToolCall = false;

  for (let step = 0; step < maxSteps; step++) {
    const usedModel = model || config.llm[`${agentType.toLowerCase()}Model`] || DEFAULT_MODEL;

    try {
      const response = await client.chat.completions.create({
        model: usedModel,
        messages,
        tools: getToolsForRole(agentType),
        temperature: config.llm.temperature,
        max_tokens: maxOutputTokens ?? config.llm.maxTokens,
        tool_choice: "auto",
      });

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error("API returned no choices");
      }

      const msg = response.choices[0].message;

      // Repair malformed JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
              } catch {
                tc.function.arguments = "{}";
              }
            }
          }
        }
      }

      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (!msg.content) {
          messages.pop();
          continue;
        }

        if (!sawToolCall) {
          const ACTION_INTENTS = /\b(deploy|trade|position|order|buy|sell|close|exit|market)\b/i;
          if (ACTION_INTENTS.test(goal)) {
            messages.pop();
            messages.push({
              role: "system",
              content: "This request requires tool execution. Call the appropriate tool first.",
            });
            continue;
          }
        }

        return { content: stripThink(msg.content), userMessage: goal };
      }

      sawToolCall = true;

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (tc) => {
        const name = tc.function.name.replace(/<.*$/, "").trim();
        let args;

        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "Invalid args" }) };
        }

        // Block once-per-session tools from double execution
        if (ONCE_PER_SESSION.has(name) && firedOnce.has(name)) {
          return {
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ blocked: true, reason: `${name} already executed this session` }),
          };
        }

        const result = await executeTool(name, args);

        if (NO_RETRY_TOOLS.has(name)) firedOnce.add(name);
        else if (ONCE_PER_SESSION.has(name) && result?.success === true) firedOnce.add(name);

        return {
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("agent_error", `Step ${step + 1}: ${error.message}`);
      if (error.status === 429) {
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      if (step === 0) throw error;
      return { content: `Agent encountered an error after ${step + 1} steps: ${error.message}`, userMessage: goal };
    }
  }

  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}
