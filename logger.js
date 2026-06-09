const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = process.env.LOG_LEVEL ? (LOG_LEVELS[process.env.LOG_LEVEL] ?? 2) : 2;

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(category, message) {
  if (LOG_LEVELS[category] != null && LOG_LEVELS[category] < 1) return;
  const prefix = ["error", "warn"].includes(category)
    ? `[${timestamp()}] [${category.toUpperCase()}]`
    : `[${timestamp()}] [${category}]`;
  console.log(`${prefix} ${message}`);
}

const _actionLog = [];

export function logAction({ tool, args, result, error, duration_ms, success }) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    args: JSON.stringify(args).slice(0, 500),
    duration_ms,
    success,
  };
  if (error) entry.error = String(error).slice(0, 300);
  if (result && !error) entry.result = JSON.stringify(result).slice(0, 500);
  _actionLog.push(entry);
  if (_actionLog.length > 500) _actionLog.shift();
  log("action", `${success ? "✓" : "✗"} ${tool} (${duration_ms}ms)${error ? " — " + error : ""}`);
}

export function getActionLog(limit = 50) {
  return _actionLog.slice(-limit);
}
