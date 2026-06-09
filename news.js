/**
 * Multi-Source Forex News Engine
 *
 * Priority: ForexFactory HTML scrape → TradingView Calendar API → Finnhub → FMP
 * Features:
 * - Forecast vs Actual comparison with deviation scoring
 * - Impact severity classification (1-5 scale)
 * - Auto-correlation: which news events historically affect which pairs
 * - Session-aware filtering (only show events in active/upcoming sessions)
 * - Graceful degradation: each source failure falls back to the next
 */
import fetch from "node-fetch";
import { load } from "cheerio";
import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";

const FOREX_FACTORY_URL = process.env.FOREX_FACTORY_URL || "https://www.forexfactory.com";
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const FMP_KEY = process.env.FMP_API_KEY || "";

const CACHE_TTL = 10 * 60 * 1000; // 10 min cache
const CORRELATION_FILE = repoPath("news-correlation.json");

let _newsCache = null;
let _newsCacheAt = 0;

// ─── News Correlation Store ──────────────────────────────────────

function loadCorrelations() {
  if (!fs.existsSync(CORRELATION_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CORRELATION_FILE, "utf8")); } catch { return {}; }
}

function saveCorrelations(data) {
  fs.writeFileSync(CORRELATION_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record how a news event actually impacted the market.
 * Called after a trade closes — correlates news with outcome.
 */
export function recordNewsImpact({ currency, event, forecast, actual, symbol, priceChangePips, pairMoved }) {
  const corr = loadCorrelations();
  const key = `${currency}:${event}`;

  if (!corr[key]) {
    corr[key] = { currency, event, occurrences: [], avgPipMove: 0, totalOccurrences: 0 };
  }

  const entry = corr[key];
  entry.occurrences.push({
    actual: actual ?? null,
    forecast: forecast ?? null,
    deviation: forecast && actual ? actual - forecast : null,
    symbol,
    priceChangePips,
    pairMoved,
    recordedAt: new Date().toISOString(),
  });

  // Keep last 20 occurrences
  if (entry.occurrences.length > 20) entry.occurrences = entry.occurrences.slice(-20);

  // Recompute average pip move
  const moves = entry.occurrences.filter((o) => o.priceChangePips != null);
  entry.avgPipMove = moves.length > 0
    ? moves.reduce((s, o) => s + Math.abs(o.priceChangePips), 0) / moves.length
    : 0;
  entry.totalOccurrences = entry.occurrences.length;

  saveCorrelations(corr);
  log("news_correlation", `Recorded ${key}: avg ${entry.avgPipMove.toFixed(1)} pips over ${entry.totalOccurrences} occurrences`);
}

export function getNewsCorrelations(currency = null) {
  const corr = loadCorrelations();
  const entries = Object.values(corr);
  if (!currency) return entries;
  return entries.filter((e) => e.currency === currency);
}

export function getHighImpactEvents(currency = null) {
  const corr = loadCorrelations();
  return Object.values(corr)
    .filter((e) => (!currency || e.currency === currency) && e.avgPipMove > 15)
    .sort((a, b) => b.avgPipMove - a.avgPipMove);
}

// ─── Impact Scoring ──────────────────────────────────────────────

function scoreImpact(forecast, actual, previous) {
  if (forecast == null || actual == null) return 2; // unknown = medium

  const deviation = Math.abs(actual - forecast);
  const prev = previous != null ? Math.abs(previous) : 0.01;
  const relativeDeviation = prev > 0 ? deviation / prev : deviation;

  // Scale 1-5 based on how much the actual deviates from forecast
  if (relativeDeviation > 2.0) return 5;  // massive surprise
  if (relativeDeviation > 1.0) return 4;  // significant surprise
  if (relativeDeviation > 0.5) return 3;  // notable deviation
  if (relativeDeviation > 0.2) return 2;  // minor deviation
  return 1; // in-line with expectations
}

function impactLabel(score) {
  if (score >= 5) return "EXTREME";
  if (score >= 4) return "HIGH";
  if (score >= 3) return "MEDIUM";
  if (score >= 2) return "LOW";
  return "MINIMAL";
}

// ─── Source 1: ForexFactory HTML Scrape ──────────────────────────

async function scrapeForexFactory() {
  try {
    const url = `${FOREX_FACTORY_URL}/calendar?week=this`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      if (res.status === 403) throw new Error("ForexFactory blocked — using fallback");
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();
    if (html.length < 5000) throw new Error("Response too short — likely blocked");

    const $ = load(html);
    const events = [];
    const now = new Date();

    // Parse the calendar table rows
    $("tr.calendar__row, tr.calendar_row").each((_, row) => {
      const $row = $(row);
      const dateCell = $row.find("td.calendar__date, td.calendar_date").text().trim();
      const timeCell = $row.find("td.calendar__time, td.calendar_time").text().trim();
      const currencyCell = $row.find("td.calendar__currency, td.calendar_currency").text().trim();
      const eventCell = $row.find("td.calendar__event, td.calendar_event").text().trim();
      const impactCell = $row.find("td.calendar__impact span, td.calendar_impact span");
      const forecastCell = $row.find("td.calendar__forecast, td.calendar_forecast").text().trim();
      const previousCell = $row.find("td.calendar__previous, td.calendar_previous").text().trim();
      const actualCell = $row.find("td.calendar__actual, td.calendar_actual").text().trim();

      if (!currencyCell || !eventCell) return;

      const impactCount = impactCell.filter(".icon--ff-impact-red, .icon--ff-impact-ora, .icon--ff-impact-yel, .high, .medium").length || 1;
      const impact = impactCount >= 3 ? 3 : impactCount >= 2 ? 2 : 1;

      // Parse time
      let eventTime = null;
      const timeMatch = timeCell.match(/(\d{1,2}):(\d{2})(am|pm)/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1], 10);
        const mins = parseInt(timeMatch[2], 10);
        const ampm = timeMatch[3].toLowerCase();
        if (ampm === "pm" && hours < 12) hours += 12;
        if (ampm === "am" && hours === 12) hours = 0;

        eventTime = new Date(now);
        eventTime.setHours(hours, mins, 0, 0);

        // If the event is more than 12h in the past, it might be tomorrow's
        if (eventTime.getTime() < now.getTime() - 12 * 3600000) {
          eventTime.setDate(eventTime.getDate() + 1);
        }
      }

      if (!eventTime || eventTime.getTime() < now.getTime() - 3600000) return;

      const forecast = parseFloat(forecastCell) || null;
      const actual = parseFloat(actualCell) || null;
      const previous = parseFloat(previousCell) || null;

      events.push({
        id: `ff:${currencyCell}:${eventCell}:${eventTime.toISOString().slice(0, 16)}`,
        time: eventTime.toISOString(),
        currency: currencyCell,
        impact: impact,
        impactSeverity: scoreImpact(forecast, actual, previous),
        event: eventCell,
        forecast,
        actual,
        previous,
        deviation: forecast != null && actual != null ? actual - forecast : null,
        source: "forexfactory",
      });
    });

    if (events.length === 0) throw new Error("No events parsed");
    return events.sort((a, b) => a.time.localeCompare(b.time));
  } catch (error) {
    log("news", `ForexFactory scrape: ${error.message}`);
    return null;
  }
}

// ─── Source 2: TradingView Economic Calendar API ─────────────────

async function fetchTradingViewCalendar() {
  try {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const from = now.toISOString().slice(0, 10);
    const to = tomorrow.toISOString().slice(0, 10);

    const res = await fetch(
      `https://economic-calendar.tradingview.com/events?from=${from}T00:00:00Z&to=${to}T23:59:59Z&minImportance=1`,
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const raw = data?.result || data?.events || [];
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("Empty response");

    return raw.map((e) => {
      const forecast = e.forecast != null ? parseFloat(e.forecast) : null;
      const actual = e.actual != null ? parseFloat(e.actual) : null;
      const previous = e.previous != null ? parseFloat(e.previous) : null;

      return {
        id: `tv:${e.currency || e.country}:${e.title || e.name}`,
        time: e.date || e.timestamp,
        currency: (e.currency || e.countryCode || "").toUpperCase(),
        impact: e.importance || e.impact || 2,
        impactSeverity: scoreImpact(forecast, actual, previous),
        event: e.title || e.name || e.event || "",
        forecast,
        actual,
        previous,
        deviation: forecast != null && actual != null ? actual - forecast : null,
        source: "tradingview",
      };
    }).sort((a, b) => a.time.localeCompare(b.time));
  } catch (error) {
    log("news", `TradingView API: ${error.message}`);
    return null;
  }
}

// ─── Source 3: Finnhub Economic Calendar ─────────────────────────

async function fetchFinnhubCalendar() {
  if (!FINNHUB_KEY) return null;
  try {
    const now = new Date();
    const from = now.toISOString().slice(0, 10);
    const to = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${FINNHUB_KEY}`,
      { signal: AbortSignal.timeout(10_000) }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const raw = data?.economicCalendar || data || [];
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("Empty");

    return raw.map((e) => {
      const forecast = e.forecast != null ? parseFloat(e.forecast) : null;
      const actual = e.actual != null ? parseFloat(e.actual) : null;
      const previous = e.prev != null ? parseFloat(e.prev) : null;

      return {
        id: `fh:${e.country}:${e.event}`,
        time: e.date || e.time,
        currency: (e.currency || e.country || "").toUpperCase().slice(0, 3),
        impact: e.impact === "high" ? 3 : e.impact === "medium" ? 2 : 1,
        impactSeverity: scoreImpact(forecast, actual, previous),
        event: e.event || "",
        forecast,
        actual,
        previous,
        deviation: forecast != null && actual != null ? actual - forecast : null,
        source: "finnhub",
      };
    });
  } catch (error) {
    log("news", `Finnhub: ${error.message}`);
    return null;
  }
}

// ─── Source 4: FMP Economic Calendar ─────────────────────────────

async function fetchFMPCalendar() {
  if (!FMP_KEY) return null;
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const res = await fetch(
      `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`,
      { signal: AbortSignal.timeout(10_000) }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error("Empty");

    return data.map((e) => {
      const forecast = e.forecast != null ? parseFloat(e.forecast) : null;
      const actual = e.actual != null ? parseFloat(e.actual) : null;
      const previous = e.previous != null ? parseFloat(e.previous) : null;

      return {
        id: `fmp:${e.country}:${e.event}`,
        time: e.date,
        currency: (e.currency || e.country || "").toUpperCase().slice(0, 3),
        impact: e.impact === "High" ? 3 : e.impact === "Medium" ? 2 : 1,
        impactSeverity: scoreImpact(forecast, actual, previous),
        event: e.event || "",
        forecast,
        actual,
        previous,
        deviation: forecast != null && actual != null ? actual - forecast : null,
        source: "fmp",
      };
    });
  } catch (error) {
    log("news", `FMP: ${error.message}`);
    return null;
  }
}

// ─── Main: Multi-source orchestration ────────────────────────────

function dedupAndMerge(eventLists) {
  const map = new Map();

  for (const events of eventLists) {
    if (!Array.isArray(events)) continue;
    for (const e of events) {
      if (!e.event || !e.currency) continue;

      // Generate dedup key: currency + event name first 40 chars + hour
      const hour = e.time?.slice(11, 13) || "00";
      const key = `${e.currency}:${e.event.slice(0, 40)}:${hour}`;

      const existing = map.get(key);
      if (!existing || (e.impactSeverity || 0) > (existing.impactSeverity || 0)) {
        map.set(key, e);
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Get upcoming high-impact news events with correlation data.
 * Multi-source with graceful degradation.
 *
 * @param {Object} opts
 * @param {number} opts.hoursAhead - How many hours to look ahead (default 24)
 * @param {boolean} opts.forceRefresh - Skip cache
 * @param {string} opts.currency - Filter by currency
 * @returns {Object} { events, highImpact, correlations }
 */
export async function getForexNews({ hoursAhead = 24, forceRefresh = false, currency = null } = {}) {
  const now = Date.now();
  if (!forceRefresh && _newsCache && (now - _newsCacheAt) < CACHE_TTL) {
    return buildNewsResponse(_newsCache, hoursAhead, currency);
  }

  // Try sources in priority order
  let events;
  events = await scrapeForexFactory();
  if (!events) events = await fetchTradingViewCalendar();
  if (!events) events = await fetchFinnhubCalendar();
  if (!events) events = await fetchFMPCalendar();

  if (!events) {
    // All sources failed — return cached if available
    if (_newsCache && _newsCache.length > 0) {
      log("news", "All sources failed, using stale cache");
      return buildNewsResponse(_newsCache, hoursAhead, currency);
    }
    log("news_warn", "All news sources failed, no cache available");
    return { events: [], highImpact: [], correlations: [], summary: "No news data available — all sources offline." };
  }

  // Enrich with correlation data
  const correlations = loadCorrelations();
  for (const e of events) {
    const key = `${e.currency}:${e.event}`;
    e.correlation = correlations[key] || null;
  }

  _newsCache = events;
  _newsCacheAt = now;

  log("news", `Loaded ${events.length} events from ${[...new Set(events.map(e => e.source))].join(", ")}`);
  return buildNewsResponse(events, hoursAhead, currency);
}

function buildNewsResponse(events, hoursAhead, currency) {
  const cutoff = new Date(Date.now() + hoursAhead * 3600000);
  const filtered = events
    .filter((e) => new Date(e.time) <= cutoff)
    .filter((e) => !currency || e.currency === currency);

  const highImpact = filtered.filter((e) => e.impactSeverity >= 4 || e.impact >= 3);
  const correlations = loadCorrelations();

  return {
    events: filtered,
    highImpact,
    correlations: Object.values(correlations).filter((c) =>
      !currency || c.currency === currency
    ),
    summary: formatNewsSummary(filtered),
    count: filtered.length,
    highImpactCount: highImpact.length,
  };
}

// ─── News Buffer Check (Enhanced) ─────────────────────────────────

export function checkNewsBuffer({ symbol, newsEvents }) {
  const bufferMinutes = config.challenge.newsBufferMinutes ?? 15;
  const now = Date.now();
  const bufferMs = bufferMinutes * 60_000;

  const currencies = [symbol.slice(0, 3), symbol.slice(3, 6)];

  const conflicting = newsEvents.filter((e) => {
    if (!currencies.includes(e.currency)) return false;
    const eventTime = new Date(e.time).getTime();
    const timeUntil = eventTime - now;

    // Block if event is within buffer window (before OR slightly after)
    const inBufferBefore = timeUntil > 0 && timeUntil < bufferMs;
    const inBufferAfter = timeUntil < 0 && Math.abs(timeUntil) < bufferMs * 0.5;
    return (inBufferBefore || inBufferAfter) && (e.impactSeverity >= 3 || e.impact >= 3);
  });

  // Check correlation data for additional warning
  const corr = loadCorrelations();
  const correlatedHighImpact = conflicting.filter((e) => {
    const key = `${e.currency}:${e.event}`;
    const entry = corr[key];
    return entry && entry.avgPipMove > 20; // historically moves market > 20 pips
  });

  return {
    blocked: conflicting.length > 0,
    severity: conflicting.length > 0
      ? (correlatedHighImpact.length > 0 ? "CRITICAL" : "WARNING")
      : "CLEAR",
    events: conflicting,
    correlatedHighImpact,
    bufferMinutes,
    reason: conflicting.length > 0
      ? `${correlatedHighImpact.length > 0 ? "⚡ " : ""}News impacting ${[...new Set(conflicting.map(e => e.currency))].join("/")} within ${bufferMinutes}min: ${conflicting.map(e => `${e.event}${e.impactSeverity >= 4 ? " (SURPRISE)" : ""}`).join(", ")}`
      : null,
  };
}

// ─── Formatting ───────────────────────────────────────────────────

function formatNewsSummary(events) {
  if (!events || events.length === 0) return "No news events in the upcoming window.";

  const highSeverity = events.filter((e) => e.impactSeverity >= 4);
  const moderate = events.filter((e) => e.impactSeverity >= 2 && e.impactSeverity < 4);

  return [
    `📅 ${events.length} events upcoming`,
    highSeverity.length > 0 ? `⚡ ${highSeverity.length} HIGH severity (surprise potential)` : null,
    moderate.length > 0 ? `📊 ${moderate.length} MODERATE impact` : null,
  ].filter(Boolean).join(" | ");
}

export function formatNewsForPrompt(events) {
  if (!events || events.length === 0) {
    return "📅 No news events in the upcoming window.";
  }

  const high = events.filter((e) => e.impactSeverity >= 4);
  const med = events.filter((e) => e.impactSeverity >= 2 && e.impactSeverity < 4);

  const lines = ["📰 NEWS CALENDAR"];

  if (high.length > 0) {
    lines.push("");
    lines.push("🔴 HIGH SEVERITY (trade with caution):");
    for (const e of high.slice(0, 8)) {
      const time = new Date(e.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      const sev = "⚡".repeat(Math.min(e.impactSeverity, 5));
      const corr = e.correlation ? ` [HIST: ~${e.correlation.avgPipMove.toFixed(0)} pips]` : "";
      lines.push(`  ${time} | ${e.currency} | ${e.event}${e.forecast != null ? ` (f/c: ${e.forecast})` : ""} ${sev}${corr}`);
    }
  }

  if (med.length > 0) {
    lines.push("");
    lines.push("🟡 MODERATE:");
    for (const e of med.slice(0, 6)) {
      const time = new Date(e.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      lines.push(`  ${time} | ${e.currency} | ${e.event}${e.forecast != null ? ` (f/c: ${e.forecast})` : ""}`);
    }
  }

  return lines.join("\n");
}

/**
 * Get detailed news context for a specific trade/entry decision.
 * Returns: relevant events, their severity, and historical correlation.
 */
export function getNewsContextForPair(symbol, newsEvents) {
  const currencies = [symbol.slice(0, 3), symbol.slice(3, 6)];
  const now = Date.now();

  const relevant = newsEvents.filter((e) => {
    if (!currencies.includes(e.currency)) return false;
    const eventTime = new Date(e.time).getTime();
    // Events within 2h either direction
    return Math.abs(eventTime - now) < 2 * 3600000;
  });

  const severity = relevant.length > 0
    ? Math.max(...relevant.map((e) => e.impactSeverity || 1))
    : 0;

  return {
    symbol,
    currencies,
    hasHighImpactNews: relevant.some((e) => e.impactSeverity >= 4),
    relevantEvents: relevant,
    recommendation: severity >= 4 ? "AVOID"
      : severity >= 3 ? "CAUTION"
      : "OK",
  };
}
