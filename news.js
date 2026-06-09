import fetch from "node-fetch";
import { load } from "cheerio";
import { log } from "./logger.js";
import { config } from "./config.js";

const FOREX_FACTORY_URL = process.env.FOREX_FACTORY_URL || "https://www.forexfactory.com";
const CACHE_TTL = 15 * 60 * 1000;

let _newsCache = null;
let _newsCacheAt = 0;

/**
 * Scrape ForexFactory calendar for upcoming high-impact news.
 */
async function scrapeForexFactory() {
  try {
    const url = `${FOREX_FACTORY_URL}/calendar`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html",
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const $ = load(html);

    const events = [];
    const now = new Date();

    $(".calendar__row").each((_, row) => {
      const $row = $(row);

      // Skip past events
      const timeStr = $row.find(".calendar__time").text().trim();
      if (!timeStr) return;

      const currency = $row.find(".calendar__currency").text().trim();
      const impact = $row.find(".calendar__impact .impact").length || 1;
      const event = $row.find(".calendar__event").text().trim();
      const actual = $row.find(".calendar__actual").text().trim();
      const forecast = $row.find(".calendar__forecast").text().trim();
      const previous = $row.find(".calendar__previous").text().trim();

      if (impact >= 3 && currency) {
        // Parse time
        const timeMatch = timeStr.match(/(\d+):(\d+)(am|pm)/i);
        if (timeMatch) {
          let hours = parseInt(timeMatch[1], 10);
          const mins = parseInt(timeMatch[2], 10);
          const ampm = timeMatch[3].toLowerCase();
          if (ampm === "pm" && hours < 12) hours += 12;
          if (ampm === "am" && hours === 12) hours = 0;

          const eventTime = new Date(now);
          eventTime.setHours(hours, mins, 0, 0);

          if (eventTime > now || Math.abs(eventTime - now) < 3600000) {
            events.push({
              time: eventTime.toISOString(),
              currency,
              impact: impact >= 4 ? "HIGH" : "MEDIUM",
              event,
              actual: actual || null,
              forecast: forecast || null,
              previous: previous || null,
            });
          }
        }
      }
    });

    return events.sort((a, b) => new Date(a.time) - new Date(b.time));
  } catch (error) {
    log("news_warn", `ForexFactory scrape failed: ${error.message}`);
    return [];
  }
}

/**
 * Alternative: Use economic calendar API.
 * Falls back gracefully if scraping fails.
 */
async function fetchEconomicCalendar() {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const from = new Date().toISOString().slice(0, 10);
    const to = tomorrow.toISOString().slice(0, 10);

    // Using a free economic calendar API
    const res = await fetch(
      `https://economic-calendar.tradingview.com/events?from=${from}&to=${to}&minImportance=2`,
      { headers: { "Accept": "application/json" } }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const events = (data?.result || data?.events || []).map((e) => ({
      time: e.date || e.timestamp,
      currency: e.currency || e.country,
      impact: e.importance >= 3 ? "HIGH" : "MEDIUM",
      event: e.title || e.name || e.event,
      actual: e.actual || null,
      forecast: e.forecast || null,
      previous: e.previous || null,
    }));

    return events.sort((a, b) => new Date(a.time) - new Date(b.time));
  } catch (error) {
    log("news_warn", `Economic calendar API failed: ${error.message}`);
    return [];
  }
}

/**
 * Get upcoming high-impact news events.
 * Cached for 15 minutes to avoid rate limiting.
 */
export async function getForexNews({ hoursAhead = 24, forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && _newsCache && (now - _newsCacheAt) < CACHE_TTL) {
    return filterByTimeframe(_newsCache, hoursAhead);
  }

  // Try scraping first, fall back to API
  let events = await scrapeForexFactory();
  if (events.length === 0) {
    log("news", "ForexFactory scraping returned no events — trying calendar API");
    events = await fetchEconomicCalendar();
  }

  _newsCache = events;
  _newsCacheAt = now;

  log("news", `Fetched ${events.length} upcoming events`);
  return filterByTimeframe(events, hoursAhead);
}

function filterByTimeframe(events, hoursAhead) {
  const cutoff = new Date(Date.now() + hoursAhead * 3600000);
  return events.filter((e) => new Date(e.time) <= cutoff);
}

/**
 * Check if a currency pair is affected by upcoming high-impact news
 * within the buffer window.
 */
export function checkNewsBuffer({ symbol, newsEvents }) {
  const bufferMinutes = config.challenge.newsBufferMinutes ?? 15;
  const now = Date.now();
  const bufferMs = bufferMinutes * 60_000;

  // Extract currencies from symbol (e.g., "EURUSD" → ["EUR", "USD"])
  const currencies = [symbol.slice(0, 3), symbol.slice(3, 6)];

  const conflicting = newsEvents.filter((e) => {
    if (!currencies.includes(e.currency)) return false;
    if (e.impact !== "HIGH") return false;
    const eventTime = new Date(e.time).getTime();
    return Math.abs(eventTime - now) < bufferMs;
  });

  return {
    blocked: conflicting.length > 0,
    events: conflicting,
    bufferMinutes,
    reason: conflicting.length > 0
      ? `High-impact news for ${conflicting.map((e) => e.currency).join("/")} within ${bufferMinutes}min buffer: ${conflicting.map((e) => e.event).join(", ")}`
      : null,
  };
}

/**
 * Format news events for LLM prompt injection.
 */
export function formatNewsForPrompt(events) {
  if (!events || events.length === 0) {
    return "No high-impact news events in the upcoming window.";
  }

  const highImpact = events.filter((e) => e.impact === "HIGH");
  const mediumImpact = events.filter((e) => e.impact === "MEDIUM");

  const lines = ["📰 UPCOMING NEWS EVENTS"];
  lines.push("");

  if (highImpact.length > 0) {
    lines.push("🔴 HIGH IMPACT:");
    for (const e of highImpact.slice(0, 10)) {
      const time = new Date(e.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      lines.push(`  ${time} | ${e.currency} | ${e.event}${e.forecast ? ` (f/c: ${e.forecast})` : ""}`);
    }
    lines.push("");
  }

  if (mediumImpact.length > 0) {
    lines.push("🟡 MEDIUM IMPACT:");
    for (const e of mediumImpact.slice(0, 8)) {
      const time = new Date(e.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      lines.push(`  ${time} | ${e.currency} | ${e.event}`);
    }
  }

  return lines.join("\n");
}
