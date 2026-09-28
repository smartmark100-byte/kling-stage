import { createServerFn } from "@tanstack/react-start";

const MCP_URL = "https://kling.ai/mcp";
const AUTH_BASE = "https://kling.ai/auth";
const SCOPES = "generation.create generation.read account.credit.read";
const PROTOCOL = "2025-06-18";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type McpTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function callbackUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (!url.pathname.endsWith("/oauth/callback")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseRpcBody(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const chunks: string[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) chunks.push(trimmed);
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") chunks.push(data);
    }
  }
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(chunks[i]) as unknown;
      const rec = asRecord(parsed);
      if (rec) return rec;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function mcpPost(token: string, sessionId: string, body: unknown) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id") || sessionId,
    payload: parseRpcBody(text),
    text: text.slice(0, 500),
  };
}

function rpcError(payload: Record<string, unknown> | null, status: number, text: string): string | null {
  const err = asRecord(payload?.error);
  if (err) {
    const message = typeof err.message === "string" ? err.message : "可靈 MCP 拒絕了這個請求";
    return message;
  }
  if (status === 401 || status === 403) return "授權過期或被拒絕，請重新連接可靈帳號";
  if (status >= 400) {
    const message = typeof payload?.message === "string" ? payload.message : text.replace(/\s+/g, " ").slice(0, 180);
    return message || `可靈 MCP 回應 ${status}`;
  }
  return null;
}

async function ensureSession(token: string, sessionId: string) {
  if (sessionId) return { sessionId, error: null as string | null, unauthorized: false };
  const init = await mcpPost(token, "", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "可靈片場", version: "1.0.0" },
    },
  });
  const initError = rpcError(init.payload, init.status, init.text);
  if (initError) return { sessionId: "", error: initError, unauthorized: init.status === 401 || init.status === 403 };
  await mcpPost(token, init.sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
  return { sessionId: init.sessionId, error: null as string | null, unauthorized: false };
}

export const registerKlingClient = createServerFn({ method: "POST" })
  .validator((input: { redirectUri: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true; clientId: string } | { ok: false; error: string }> => {
    const redirectUri = callbackUrl(data?.redirectUri);
    if (!redirectUri) return { ok: false, error: "回跳網址不正確" };
    try {
      const res = await fetch(`${AUTH_BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "可靈片場",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: SCOPES,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as { client_id?: string; error_description?: string; message?: string };
      if (!res.ok || !body.client_id) {
        return { ok: false, error: body.error_description || body.message || "無法向可靈登記這個程式" };
      }
      return { ok: true, clientId: body.client_id };
    } catch {
      return { ok: false, error: "連不到可靈授權服務" };
    }
  });

async function tokenRequest(form: URLSearchParams) {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    message?: string;
  };
  return { res, body };
}

function tokensFrom(
  body: { access_token?: string; refresh_token?: string; expires_in?: number },
  clientId: string,
  previousRefresh: string,
): McpTokens | null {
  if (!body.access_token) return null;
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || previousRefresh,
    expiresAt: Date.now() + expiresIn * 1000,
    clientId,
  };
}

type PendingLogin = {
  verifier: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
  error: string | null;
  tokens: McpTokens | null;
};

const oauthSessions = (() => {
  const slot = globalThis as { __klingOauthSessions__?: Map<string, PendingLogin> };
  slot.__klingOauthSessions__ ??= new Map();
  return slot.__klingOauthSessions__;
})();

function pruneOauthSessions() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, session] of oauthSessions) {
    if (session.createdAt < cutoff) oauthSessions.delete(id);
  }
}

export const stashKlingLogin = createServerFn({ method: "POST" })
  .validator((input: { loginId: string; verifier: string; clientId: string; redirectUri: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const loginId = typeof data?.loginId === "string" ? data.loginId.trim() : "";
    const verifier = typeof data?.verifier === "string" ? data.verifier.trim() : "";
    const clientId = typeof data?.clientId === "string" ? data.clientId.trim() : "";
    const redirectUri = callbackUrl(data?.redirectUri);
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(loginId)) return { ok: false, error: "登入編號不正確" };
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return { ok: false, error: "授權校驗失敗，請再連一次" };
    if (!clientId || clientId.length > 200 || !redirectUri) return { ok: false, error: "無法開始可靈登入" };
    pruneOauthSessions();
    oauthSessions.set(loginId, { verifier, clientId, redirectUri, createdAt: Date.now(), error: null, tokens: null });
    return { ok: true };
  });

export const finishKlingLogin = createServerFn({ method: "POST" })
  .validator((input: { loginId: string; code: string; error: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const loginId = typeof data?.loginId === "string" ? data.loginId.trim() : "";
    const session = oauthSessions.get(loginId);
    if (!session) return { ok: false, error: "這次登入已失效，請回片場再連一次" };
    const described = typeof data?.error === "string" ? data.error.trim() : "";
    if (described) {
      session.error = described;
      return { ok: false, error: described };
    }
    const code = typeof data?.code === "string" ? data.code.trim() : "";
    if (!code || code.length > 2000) {
      session.error = "可靈沒有回傳授權碼";
      return { ok: false, error: session.error };
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: session.redirectUri,
      client_id: session.clientId,
      code_verifier: session.verifier,
      resource: MCP_URL,
    });
    try {
      const { res, body } = await tokenRequest(form);
      const tokens = tokensFrom(body, session.clientId, "");
      if (!res.ok || !tokens) {
        session.error = body.error_description || body.message || "換取授權失敗";
        return { ok: false, error: session.error };
      }
      session.tokens = tokens;
      session.error = null;
      return { ok: true };
    } catch {
      session.error = "連不到可靈授權服務";
      return { ok: false, error: session.error };
    }
  });

export const pollKlingLogin = createServerFn({ method: "POST" })
  .validator((input: { loginId: string }) => input)
  .handler(
    async ({
      data,
    }): Promise<
      | { status: "pending" }
      | { status: "ok"; tokens: McpTokens }
      | { status: "error"; error: string }
      | { status: "missing" }
    > => {
      const loginId = typeof data?.loginId === "string" ? data.loginId.trim() : "";
      const session = oauthSessions.get(loginId);
      if (!session) return { status: "missing" };
      if (session.error) {
        oauthSessions.delete(loginId);
        return { status: "error", error: session.error };
      }
      if (session.tokens) {
        const tokens = session.tokens;
        oauthSessions.delete(loginId);
        return { status: "ok", tokens };
      }
      return { status: "pending" };
    },
  );

export const exchangeKlingCode = createServerFn({ method: "POST" })
  .validator((input: { code: string; redirectUri: string; clientId: string; codeVerifier: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true; tokens: McpTokens } | { ok: false; error: string }> => {
    const redirectUri = callbackUrl(data?.redirectUri);
    const code = typeof data?.code === "string" ? data.code.trim() : "";
    const clientId = typeof data?.clientId === "string" ? data.clientId.trim() : "";
    const codeVerifier = typeof data?.codeVerifier === "string" ? data.codeVerifier.trim() : "";
    if (!redirectUri || !code || code.length > 2000 || !clientId || clientId.length > 200) {
      return { ok: false, error: "授權資料不完整" };
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return { ok: false, error: "授權校驗失敗，請再連一次" };
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
      resource: MCP_URL,
    });
    try {
      const { res, body } = await tokenRequest(form);
      const tokens = tokensFrom(body, clientId, "");
      if (!res.ok || !tokens) return { ok: false, error: body.error_description || body.message || "換取授權失敗" };
      return { ok: true, tokens };
    } catch {
      return { ok: false, error: "連不到可靈授權服務" };
    }
  });

export const refreshKlingToken = createServerFn({ method: "POST" })
  .validator((input: { refreshToken: string; clientId: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true; tokens: McpTokens } | { ok: false; error: string }> => {
    const refreshToken = typeof data?.refreshToken === "string" ? data.refreshToken.trim() : "";
    const clientId = typeof data?.clientId === "string" ? data.clientId.trim() : "";
    if (!refreshToken || refreshToken.length > 4000 || !clientId || clientId.length > 200) {
      return { ok: false, error: "沒有可刷新的授權" };
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: MCP_URL,
    });
    try {
      const { res, body } = await tokenRequest(form);
      const tokens = tokensFrom(body, clientId, refreshToken);
      if (!res.ok || !tokens) return { ok: false, error: body.error_description || body.message || "授權刷新失敗" };
      return { ok: true, tokens };
    } catch {
      return { ok: false, error: "連不到可靈授權服務" };
    }
  });

export const putKlingFile = createServerFn({ method: "POST" })
  .validator((input: { url: string; method?: string; contentType: string; base64: string; headers?: Record<string, string> }) => input)
  .handler(async ({ data }): Promise<{ ok: true; url: string } | { ok: false; error: string }> => {
    const rawUrl = typeof data?.url === "string" ? data.url.trim() : "";
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return { ok: false, error: "上傳位址不正確" };
    }
    if (target.protocol !== "https:") return { ok: false, error: "上傳位址不正確" };
    const contentType = typeof data?.contentType === "string" && /^image\/[a-z0-9.+-]+$/i.test(data.contentType) ? data.contentType : "image/jpeg";
    const base64 = typeof data?.base64 === "string" ? data.base64.replace(/\s/g, "") : "";
    if (!/^[A-Za-z0-9+/=]+$/.test(base64) || base64.length < 32 || base64.length > 2_000_000) {
      return { ok: false, error: "圖片資料不正確" };
    }
    const bytes = Buffer.from(base64, "base64");
    const headers: Record<string, string> = { "Content-Type": contentType };
    const extra = data?.headers && typeof data.headers === "object" ? data.headers : {};
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value !== "string" || value.length > 800) continue;
      if (!/^[A-Za-z0-9-]{1,48}$/.test(key)) continue;
      headers[key] = value;
    }
    const send = (method: "PUT" | "POST") =>
      fetch(target.toString(), {
        method,
        headers,
        body: bytes,
        signal: AbortSignal.timeout(45_000),
      });
    try {
      const preferred = data?.method?.toUpperCase() === "POST" ? "POST" : "PUT";
      let res = await send(preferred);
      if (res.status === 405) res = await send(preferred === "PUT" ? "POST" : "PUT");
      if (!res.ok) {
        const text = (await res.text()).replace(/\s+/g, " ").slice(0, 140);
        return { ok: false, error: `圖片上傳失敗（${res.status}）${text ? `：${text}` : ""}` };
      }
      return { ok: true, url: target.toString().split("?")[0] };
    } catch {
      return { ok: false, error: "圖片傳不到可靈的上傳位址" };
    }
  });

type ToolArg = string | number | boolean | null | string[];

export const callKlingMcp = createServerFn({ method: "POST" })
  .validator((input: { accessToken: string; sessionId: string; tool: string; args: Record<string, ToolArg> }) => input)
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; sessionId: string; result: Json; unauthorized: false }
      | { ok: false; error: string; sessionId: string; unauthorized: boolean }
    > => {
      const accessToken = typeof data?.accessToken === "string" ? data.accessToken.trim() : "";
      const tool = typeof data?.tool === "string" ? data.tool.trim() : "";
      const sessionIn = typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
      if (!accessToken || accessToken.length > 8000) return { ok: false, error: "尚未連接可靈帳號", sessionId: "", unauthorized: true };
      if (!/^[a-z0-9_-]{1,80}$/i.test(tool)) return { ok: false, error: "工具名稱不正確", sessionId: sessionIn, unauthorized: false };
      const args = asRecord(data?.args) ?? {};
      const clean: Record<string, ToolArg> = {};
      for (const [key, value] of Object.entries(args)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) continue;
        if (typeof value === "string") {
          if (value.length > 1_800_000) return { ok: false, error: "送出的內容太大", sessionId: sessionIn, unauthorized: false };
          clean[key] = value;
        } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
          if (value.length > 7) return { ok: false, error: "參考圖最多 7 張", sessionId: sessionIn, unauthorized: false };
          const size = value.reduce((sum, item) => sum + item.length, 0);
          if (size > 1_800_000) return { ok: false, error: "送出的內容太大", sessionId: sessionIn, unauthorized: false };
          clean[key] = value;
        } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
          clean[key] = value;
        }
      }
      try {
        let session = await ensureSession(accessToken, sessionIn);
        if (session.error) {
          return { ok: false, error: session.error, sessionId: session.sessionId, unauthorized: session.unauthorized };
        }
        const send = (sessionId: string) =>
          mcpPost(accessToken, sessionId, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: tool, arguments: clean },
          });
        let response = await send(session.sessionId);
        let message = rpcError(response.payload, response.status, response.text);
        if (message && /session/i.test(message) && sessionIn) {
          session = await ensureSession(accessToken, "");
          if (session.error) {
            return { ok: false, error: session.error, sessionId: "", unauthorized: session.unauthorized };
          }
          response = await send(session.sessionId);
          message = rpcError(response.payload, response.status, response.text);
        }
        if (message || !response.payload) {
          return {
            ok: false,
            error: message || "可靈沒有回傳結果",
            sessionId: response.sessionId,
            unauthorized: response.status === 401 || response.status === 403,
          };
        }
        const result = response.payload.result;
        return { ok: true, sessionId: response.sessionId, result: result as Json, unauthorized: false };
      } catch {
        return { ok: false, error: "連不到可靈 MCP", sessionId: sessionIn, unauthorized: false };
      }
    },
  );

export const listKlingMcpTools = createServerFn({ method: "POST" })
  .validator((input: { accessToken: string; sessionId: string }) => input)
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; sessionId: string; tools: Json }
      | { ok: false; error: string; sessionId: string; unauthorized: boolean }
    > => {
      const accessToken = typeof data?.accessToken === "string" ? data.accessToken.trim() : "";
      const sessionIn = typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
      if (!accessToken || accessToken.length > 8000) {
        return { ok: false, error: "尚未連接可靈帳號", sessionId: "", unauthorized: true };
      }
      try {
        const session = await ensureSession(accessToken, sessionIn);
        if (session.error) {
          return { ok: false, error: session.error, sessionId: session.sessionId, unauthorized: session.unauthorized };
        }
        const response = await mcpPost(accessToken, session.sessionId, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        });
        const message = rpcError(response.payload, response.status, response.text);
        if (message || !response.payload) {
          return {
            ok: false,
            error: message || "讀不到可靈工具清單",
            sessionId: response.sessionId,
            unauthorized: response.status === 401 || response.status === 403,
          };
        }
        const result = asRecord(response.payload.result);
        return { ok: true, sessionId: response.sessionId, tools: (result?.tools ?? []) as Json };
      } catch {
        return { ok: false, error: "連不到可靈 MCP", sessionId: sessionIn, unauthorized: false };
      }
    },
  );
