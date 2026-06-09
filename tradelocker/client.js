import fetch from "node-fetch";
import WebSocket from "ws";
import { log } from "../logger.js";

const DEMO_BASE = "https://demo-api.tradelocker.com";
const LIVE_BASE = "https://api.tradelocker.com";

function baseUrl() {
  return process.env.TRADELOCKER_SERVER === "live" ? LIVE_BASE : DEMO_BASE;
}

let _accessToken = null;
let _refreshToken = null;
let _tokenExpiresAt = 0;
let _accountId = null;
let _ws = null;
let _wsSubscriptions = new Map();
let _wsReconnectTimer = null;

// ─── Auth ────────────────────────────────────────────────────────

async function authenticate() {
  const email = process.env.TRADELOCKER_EMAIL;
  const password = process.env.TRADELOCKER_PASSWORD;

  if (!email || !password) {
    throw new Error("TRADELOCKER_EMAIL and TRADELOCKER_PASSWORD must be set in .env");
  }

  log("tradelocker", "Authenticating...");
  const res = await fetch(`${baseUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TradeLocker auth failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  _accessToken = data.accessToken || data.access_token;
  _refreshToken = data.refreshToken || data.refresh_token;
  _tokenExpiresAt = Date.now() + ((data.expiresIn || data.expires_in || 3600) - 60) * 1000;
  log("tradelocker", "Authenticated successfully");
  return true;
}

async function ensureAuth() {
  if (_accessToken && Date.now() < _tokenExpiresAt) return;
  if (_refreshToken) {
    try {
      log("tradelocker", "Refreshing token...");
      const res = await fetch(`${baseUrl()}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: _refreshToken }),
      });
      if (res.ok) {
        const data = await res.json();
        _accessToken = data.accessToken || data.access_token;
        _refreshToken = data.refreshToken || data.refresh_token || _refreshToken;
        _tokenExpiresAt = Date.now() + ((data.expiresIn || data.expires_in || 3600) - 60) * 1000;
        return;
      }
    } catch (e) {
      log("tradelocker_warn", `Token refresh failed: ${e.message}`);
    }
  }
  await authenticate();
}

// ─── REST Client ──────────────────────────────────────────────────

async function request(method, path, body = null, retries = 2) {
  await ensureAuth();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = {
        "Authorization": `Bearer ${_accessToken}`,
        "Accept": "application/json",
      };
      if (body) {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 401 && attempt < retries) {
        _accessToken = null;
        await ensureAuth();
        continue;
      }

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
        log("tradelocker_warn", `Rate limited, waiting ${retryAfter}s`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`TradeLocker API ${res.status}: ${text.slice(0, 300)}`);
      }

      return await res.json();
    } catch (error) {
      if (attempt === retries) throw error;
      log("tradelocker_warn", `Request retry ${attempt + 1}/${retries}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

export function get(path, query = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const fullPath = qs ? `${path}?${qs}` : path;
  return request("GET", fullPath);
}

export function post(path, body = {}) {
  return request("POST", path, body);
}

export function put(path, body = {}) {
  return request("PUT", path, body);
}

export function del(path) {
  return request("DELETE", path);
}

// ─── Account ID ───────────────────────────────────────────────────

export async function getDefaultAccountId() {
  if (_accountId) return _accountId;
  await ensureAuth();
  const accounts = await get("/v1/accounts");
  const index = parseInt(process.env.TRADELOCKER_ACCOUNT_ID || "0", 10);
  if (!accounts?.length) throw new Error("No TradeLocker accounts found");
  if (index >= accounts.length) throw new Error(`Account index ${index} out of range (${accounts.length} accounts)`);
  _accountId = accounts[index].id || accounts[index].accountId;
  log("tradelocker", `Using account: ${_accountId}`);
  return _accountId;
}

// ─── WebSocket ────────────────────────────────────────────────────

export function connectWebSocket(onMessage, onAccountUpdate) {
  if (_ws) return;

  const wsUrl = baseUrl().replace("https://", "wss://").replace("http://", "ws://") + "/ws";
  log("tradelocker", `Connecting WebSocket: ${wsUrl}`);

  _ws = new WebSocket(wsUrl);

  _ws.on("open", async () => {
    log("tradelocker", "WebSocket connected");
    try {
      await ensureAuth();
      _ws.send(JSON.stringify({ type: "auth", token: _accessToken }));
    } catch (e) {
      log("tradelocker_error", `WebSocket auth failed: ${e.message}`);
    }
  });

  _ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        log("tradelocker", "WebSocket authenticated");
        // Subscribe to account updates
        getDefaultAccountId().then((accountId) => {
          _ws.send(JSON.stringify({ type: "subscribe", channel: "account", accountId }));
        }).catch(() => {});
        return;
      }
      if (msg.channel === "account" || msg.type === "account_update") {
        onAccountUpdate?.(msg);
        return;
      }
      onMessage?.(msg);
    } catch {
      // ignore parse errors
    }
  });

  _ws.on("close", () => {
    log("tradelocker_warn", "WebSocket disconnected");
    _ws = null;
    scheduleReconnect();
  });

  _ws.on("error", (err) => {
    log("tradelocker_error", `WebSocket error: ${err.message}`);
  });
}

export function subscribePrice(symbol, callback) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) {
    _wsSubscriptions.set(symbol, callback);
    return;
  }
  _ws.send(JSON.stringify({ type: "subscribe", channel: "price", symbol }));
  _wsSubscriptions.set(symbol, callback);
}

export function unsubscribePrice(symbol) {
  _wsSubscriptions.delete(symbol);
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({ type: "unsubscribe", channel: "price", symbol }));
  }
}

export function disconnectWebSocket() {
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  if (_ws) {
    _ws.close();
    _ws = null;
  }
}

function scheduleReconnect() {
  if (_wsReconnectTimer) return;
  _wsReconnectTimer = setTimeout(() => {
    _wsReconnectTimer = null;
    connectWebSocket(
      (msg) => {
        for (const [, cb] of _wsSubscriptions) cb(msg);
      }
    );
  }, 10_000);
}
