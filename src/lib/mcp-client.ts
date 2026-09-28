import {
  callKlingMcp,
  finishKlingLogin,
  listKlingMcpTools,
  pollKlingLogin,
  putKlingFile,
  refreshKlingToken,
  registerKlingClient,
  stashKlingLogin,
  type McpTokens,
} from "@/lib/kling-mcp";

const CLIENT_KEY = "kling-mcp-client";
const TOKEN_KEY = "kling-mcp-tokens";
const SESSION_KEY = "kling-mcp-session";
const SCOPES = "generation.create generation.read account.credit.read";

export type ToolSchema = {
  type?: string;
  format?: string;
  description?: string;
  enum?: Array<string | number>;
  properties?: Record<string, ToolSchema>;
  required?: string[];
};

export type McpTool = {
  name: string;
  description: string;
  schema: ToolSchema;
};

function randomUrl(bytes: number) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let text = "";
  for (const byte of buf) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function codeChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let text = "";
  for (const byte of new Uint8Array(digest)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function loadMcpTokens(): McpTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as McpTokens;
    if (!parsed.accessToken || !parsed.clientId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveMcpTokens(tokens: McpTokens | null) {
  if (!tokens) {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

function sessionId() {
  return sessionStorage.getItem(SESSION_KEY) || "";
}

function rememberSession(id: string) {
  if (id) sessionStorage.setItem(SESSION_KEY, id);
  else sessionStorage.removeItem(SESSION_KEY);
}

export async function beginKlingLogin() {
  const redirectUri = `${location.origin}/oauth/callback`;
  let clientId = "";
  try {
    const saved = JSON.parse(localStorage.getItem(CLIENT_KEY) || "null") as { clientId?: string; redirectUri?: string } | null;
    if (saved?.clientId && saved.redirectUri === redirectUri) clientId = saved.clientId;
  } catch {
    clientId = "";
  }
  if (!clientId) {
    const registered = await registerKlingClient({ data: { redirectUri } });
    if (!registered.ok) throw new Error(registered.error);
    clientId = registered.clientId;
    localStorage.setItem(CLIENT_KEY, JSON.stringify({ clientId, redirectUri }));
  }
  const verifier = randomUrl(48);
  const loginId = randomUrl(18);
  const stashed = await stashKlingLogin({ data: { loginId, verifier, clientId, redirectUri } });
  if (!stashed.ok) throw new Error(stashed.error);
  const url = new URL("https://kling.ai/auth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", loginId);
  url.searchParams.set("code_challenge", await codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", "https://kling.ai/mcp");
  return { loginId, url: url.toString() };
}

export async function completeKlingLogin(): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  const loginId = params.get("state") || "";
  const described = params.get("error_description") || params.get("error") || "";
  const code = params.get("code") || "";
  const finished = await finishKlingLogin({ data: { loginId, code, error: described } });
  if (!finished.ok) return finished.error;
  return null;
}

export async function pullKlingLogin(loginId: string) {
  return pollKlingLogin({ data: { loginId } });
}

async function freshTokens(): Promise<McpTokens | null> {
  const current = loadMcpTokens();
  if (!current) return null;
  if (current.expiresAt - Date.now() > 60_000) return current;
  if (!current.refreshToken) return current;
  const refreshed = await refreshKlingToken({ data: { refreshToken: current.refreshToken, clientId: current.clientId } });
  if (!refreshed.ok) {
    saveMcpTokens(null);
    return null;
  }
  saveMcpTokens(refreshed.tokens);
  return refreshed.tokens;
}

function unwrap(result: unknown): unknown {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const content = record && Array.isArray(record.content) ? record.content : null;
  if (!content) return result;
  const text = content
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      return typeof row?.text === "string" ? row.text : "";
    })
    .filter(Boolean)
    .join("\n");
  if (!text) return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function mcpTools(): Promise<{ tools: McpTool[]; error: string | null }> {
  const tokens = await freshTokens();
  if (!tokens) return { tools: [], error: "尚未連接可靈帳號" };
  const listed = await listKlingMcpTools({ data: { accessToken: tokens.accessToken, sessionId: sessionId() } });
  if (!listed.ok) {
    if (listed.unauthorized) saveMcpTokens(null);
    return { tools: [], error: listed.error };
  }
  rememberSession(listed.sessionId);
  const tools = Array.isArray(listed.tools)
    ? listed.tools.flatMap((item) => {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
        if (!row || typeof row.name !== "string") return [];
        const schema = (row.inputSchema && typeof row.inputSchema === "object" ? row.inputSchema : {}) as ToolSchema;
        return [{ name: row.name, description: typeof row.description === "string" ? row.description : "", schema }];
      })
    : [];
  return { tools, error: null };
}

export async function mcpCall(tool: string, args: Record<string, string | number | boolean | null | string[]>) {
  const tokens = await freshTokens();
  if (!tokens) return { ok: false as const, error: "尚未連接可靈帳號", data: null as unknown };
  const called = await callKlingMcp({
    data: { accessToken: tokens.accessToken, sessionId: sessionId(), tool, args },
  });
  if (!called.ok) {
    if (called.unauthorized) saveMcpTokens(null);
    return { ok: false as const, error: called.error, data: null as unknown };
  }
  rememberSession(called.sessionId);
  const data = unwrap(called.result);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = record?.code;
  if (record?.isError === true || (typeof code === "number" && code !== 0)) {
    const message = typeof record?.message === "string" && record.message ? record.message : replyText(data);
    return { ok: false as const, error: message || "可靈拒絕了這次生成", data };
  }
  return { ok: true as const, error: null, data };
}

export function replyText(data: unknown) {
  try {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return text.replace(/\s+/g, " ").slice(0, 280);
  } catch {
    return "";
  }
}

export function listedModels(data: unknown) {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (/^kling[-_][a-z0-9._-]{1,48}$/i.test(value)) found.add(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    Object.values(value as Record<string, unknown>).forEach(walk);
  };
  walk(data);
  return [...found];
}

function schemaArgs(schema: ToolSchema | undefined, candidates: Record<string, string | number | boolean | null>) {
  const keys = Object.keys(schema?.properties ?? {});
  if (!keys.length) return candidates;
  const args: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(candidates)) {
    const key = keys.find((item) => item.toLowerCase() === name.toLowerCase());
    if (!key || value === "" || value == null) continue;
    args[key] = value;
  }
  return args;
}

function imageBytes(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { mime: match[1], bytes, base64: match[2] };
  } catch {
    return null;
  }
}

export async function uploadKlingImage(dataUrl: string, tools: McpTool[]) {
  if (/^https?:\/\//i.test(dataUrl)) return { ok: true as const, url: dataUrl };
  const image = imageBytes(dataUrl);
  if (!image) return { ok: false as const, error: "圖片資料不正確，沒有送出" };
  const tool = tools.find((item) => item.name === "file_upload");
  if (!tool) return { ok: false as const, error: "可靈沒有檔案上傳工具。直接塞圖片資料它抓不到，網站上就不會有這支片。" };
  const ticket = await mcpCall(
    "file_upload",
    schemaArgs(tool.schema, {
      filename: "frame.jpg",
      file_name: "frame.jpg",
      name: "frame.jpg",
      content_type: image.mime,
      mime_type: image.mime,
      mime: image.mime,
      size: image.bytes.byteLength,
      file_size: image.bytes.byteLength,
      purpose: "image",
    }),
  );
  if (!ticket.ok) return { ok: false as const, error: ticket.error || "可靈沒有給上傳位址" };
  const uploadUrl = findString(ticket.data, ["upload_url", "uploadUrl", "put_url", "presigned_url", "presignedUrl"]);
  const fileUrl = findString(ticket.data, ["file_url", "fileUrl", "asset_url", "assetUrl", "download_url", "public_url"]);
  if (uploadUrl && /^https?:\/\//.test(uploadUrl)) {
    const method = (findString(ticket.data, ["method", "http_method"]) || "PUT").toUpperCase();
    const sent = await putKlingFile({
      data: {
        url: uploadUrl,
        method,
        contentType: image.mime,
        base64: image.base64,
        headers: headerMap(ticket.data),
      },
    });
    if (!sent.ok) return sent;
    const hosted = fileUrl && /^https?:\/\//.test(fileUrl) ? fileUrl : sent.url;
    return { ok: true as const, url: hosted };
  }
  const hosted = fileUrl && /^https?:\/\//.test(fileUrl) ? fileUrl : findString(ticket.data, ["url"]);
  if (hosted && /^https?:\/\//.test(hosted) && !/upload/i.test(hosted)) return { ok: true as const, url: hosted };
  return { ok: false as const, error: `可靈沒有接受這張圖，所以沒有建立影片。它回：${replyText(ticket.data) || "沒有上傳位址"}` };
}

function headerMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = headerMap(item);
      if (Object.keys(found).length) return found;
    }
    return {};
  }
  const record = value as Record<string, unknown>;
  const headers = record.headers ?? record.upload_headers ?? record.required_headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(headers)) {
      if (typeof item === "string") out[key] = item;
    }
    if (Object.keys(out).length) return out;
  }
  for (const nested of Object.values(record)) {
    const found = headerMap(nested);
    if (Object.keys(found).length) return found;
  }
  return {};
}

function findString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }
  for (const nested of Object.values(record)) {
    const found = findString(nested, keys);
    if (found) return found;
  }
  return null;
}

const TASK_ID = /^[A-Za-z0-9_-]{6,128}$/;

export function generationIdOf(data: unknown) {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (TASK_ID.test(trimmed)) return trimmed;
    const labeled = trimmed.match(/(?:generation[_ ]?id|task[_ ]?id)\s*[:=：]\s*["']?([A-Za-z0-9_-]{6,128})/i);
    return labeled?.[1] ?? null;
  }
  const found = findString(data, ["generation_id", "generationId", "task_id", "taskId"]);
  return found && TASK_ID.test(found) ? found : null;
}

const NOT_ACCOUNT = /^(prompt|text|image|duration|model|name|description|query|url|type|string|object|text_to_video|image_to_video|query_tasks|who_am_i|file_upload)$/i;

export function accountLabel(data: unknown) {
  const emails: string[] = [];
  const names: string[] = [];
  const credits: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item !== "string") {
        walk(item);
        continue;
      }
      const text = item.trim();
      if (!text || NOT_ACCOUNT.test(text)) continue;
      if (/email/i.test(key) && text.includes("@")) emails.push(text);
      else if (/^(username|user_name|nickname|display_name|displayName)$/i.test(key)) names.push(text);
      else if (/^(credits|credit|balance|available_credits)$/i.test(key)) credits.push(text);
    }
  };
  walk(data);
  const name = emails[0] || names[0];
  if (name && credits[0]) return `${name} · 點數 ${credits[0]}`;
  if (name) return name;
  return "已連接可靈帳號";
}

function normalizeTaskStatus(raw: string) {
  const status = raw.toLowerCase();
  if (status === "succeed" || status === "succeeded" || status === "completed" || status === "complete") return "succeeded";
  if (status === "submitted") return "submitted";
  if (status === "processing" || status === "running" || status === "pending" || status === "queued" || status === "in_progress") return "processing";
  if (status === "failed" || status === "failure" || status === "canceled" || status === "cancelled") return "failed";
  return null;
}

export function taskViewOf(data: unknown, taskId?: string): { status: string; message: string; videoUrl: string | null; progress: number | null } {
  const empty = { status: "missing", message: "", videoUrl: null as string | null, progress: null as number | null };
  const found: Array<{ id: string; status: string; message: string; videoUrl: string | null; progress: number | null }> = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const record = value as Record<string, unknown>;
    const idValue = record.generation_id ?? record.generationId ?? record.task_id ?? record.taskId ?? record.id;
    const id = typeof idValue === "string" && TASK_ID.test(idValue) ? idValue : "";
    const statusRaw = record.task_status ?? record.status ?? record.state;
    const status = typeof statusRaw === "string" ? normalizeTaskStatus(statusRaw) : null;
    let videoUrl: string | null = null;
    if (typeof record.url === "string" && record.url.startsWith("http") && (record.type === "video" || /\.(mp4|mov|webm)(\?|$)/i.test(record.url))) {
      videoUrl = record.url;
    }
    const works = record.works ?? record.videos;
    if (Array.isArray(works)) {
      for (const item of works) {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
        if (row && typeof row.url === "string" && row.url.startsWith("http")) videoUrl = row.url;
      }
    }
    const messageValue = record.task_status_msg ?? record.message;
    const message = typeof messageValue === "string" ? messageValue : "";
    const progressValue = record.progress ?? record.percent ?? record.percentage;
    const progress = typeof progressValue === "number" && progressValue >= 0 && progressValue <= 100 ? progressValue : null;
    if (status || videoUrl) found.push({ id, status: videoUrl ? "succeeded" : status || "processing", message, videoUrl, progress });
    Object.values(record).forEach(walk);
  };
  walk(data);
  if (taskId) {
    const matched = found.find((item) => item.id === taskId);
    if (matched) return { status: matched.status, message: matched.message, videoUrl: matched.videoUrl, progress: matched.progress };
    let blob = "";
    try {
      blob = JSON.stringify(data);
    } catch {
      blob = "";
    }
    if (blob.includes(taskId) && found.length === 1) {
      const only = found[0];
      return { status: only.status, message: only.message, videoUrl: only.videoUrl, progress: only.progress };
    }
    return empty;
  }
  const first = found[0];
  if (!first) return empty;
  return { status: first.status, message: first.message, videoUrl: first.videoUrl, progress: first.progress };
}

export function argsFor(
  schema: ToolSchema | undefined,
  values: {
    prompt: string;
    duration: number;
    aspect: string;
    resolution: string;
    image: string;
    images?: string[];
    model?: string;
    imageRole?: "first_frame" | "refer_image";
  },
): { args: Record<string, string | number | boolean | null | string[]>; error: string | null } {
  const properties = schema?.properties ?? {};
  const keys = Object.keys(properties);
  const args: Record<string, string | number | boolean | null | string[]> = {};
  const take = (names: string[], value: string | number | null) => {
    const key = keys.find((item) => names.includes(item.toLowerCase()));
    if (!key || value == null || value === "") return;
    const prop = properties[key];
    if (prop?.enum && !prop.enum.map(String).includes(String(value))) return;
    if (typeof value === "number" && prop?.type === "string") args[key] = String(value);
    else args[key] = value;
  };
  take(["prompt", "text", "description"], values.prompt);
  take(["duration", "seconds", "video_length"], values.duration);
  take(["aspect_ratio", "aspectratio", "ratio"], values.aspect);
  take(["resolution", "quality", "mode"], values.resolution);
  take(["model", "model_name", "modelname"], values.model ?? null);
  const role = values.imageRole ?? "first_frame";
  if (values.image) {
    take(
      role === "refer_image"
        ? ["refer_image", "reference_image", "ref_image", "image", "image_url", "imageurl", "url"]
        : ["image", "image_url", "imageurl", "url", "first_frame", "firstframe"],
      values.image,
    );
    const roleKey = keys.find((item) =>
      ["image_type", "image_role", "refer_type", "content_type", "type"].includes(item.toLowerCase()),
    );
    if (roleKey) {
      const prop = properties[roleKey];
      const allowed = !prop?.enum || prop.enum.map(String).includes(role);
      const stringy = !prop?.type || prop.type === "string";
      if (allowed && stringy && prop?.type !== "object") args[roleKey] = role;
    }
  }
  const images = (values.images ?? []).filter((item) => item.startsWith("http"));
  if (images.length > 1 || (images.length && role === "refer_image")) {
    const listKey = keys.find((key) => {
      const prop = properties[key];
      return prop?.type === "array" && /image|refer|ref|url/i.test(key);
    });
    const target = listKey ?? (keys.length ? null : "images");
    if (target) args[target] = images;
    else args.images = images;
  }
  if (values.prompt && !Object.keys(args).some((key) => /prompt/i.test(key))) {
    args.prompt = values.prompt;
  }
  const missing = (schema?.required ?? []).filter((key) => args[key] == null || args[key] === "");
  if (missing.length) return { args, error: `還缺：${missing.join("、")}` };
  return { args, error: null };
}

export function planMcpVideo(
  tools: McpTool[],
  values: {
    prompt: string;
    duration: number;
    aspect: string;
    resolution: string;
    image: string;
    images?: string[];
    model: string;
    imageRole: "first" | "refer";
    allowedModels?: string[];
    spec?: unknown;
  },
): { tool: string; args: Record<string, string | number | boolean | null | string[]>; error: string | null } {
  const allowed = values.allowedModels ?? [];
  let model = values.model;
  if (allowed.length && !allowed.includes(model)) {
    const fallback =
      model === "kling-3.0-omni"
        ? allowed.find((item) => /omni/i.test(item))
        : allowed.find((item) => item.toLowerCase() === model.toLowerCase());
    if (!fallback) return { tool: "", args: {}, error: `可靈沒有「${model}」。這個帳號可用：${allowed.join("、")}` };
    model = fallback;
  }
  const omni = /omni/i.test(model);
  const omniTool = tools.find((tool) => /omni/i.test(tool.name));
  const fallbackName = values.image ? "image_to_video" : "text_to_video";
  const chosen = omni && omniTool ? omniTool : tools.find((tool) => tool.name === fallbackName);
  if (!chosen) {
    return {
      tool: fallbackName,
      args: {},
      error: omni ? "可靈帳號還沒提供 Omni，請改用 API Key" : "找不到生成工具",
    };
  }
  const keys = Object.keys(chosen.schema?.properties ?? {});
  const hasModel = keys.some((key) => ["model", "model_name", "modelname"].includes(key.toLowerCase()));
  if (omni && !omniTool && !hasModel) {
    return { tool: chosen.name, args: {}, error: "可靈帳號這條還沒有 Omni。請改用 API Key，模型選 3.0 Omni。" };
  }
  const imageRole = omni && values.imageRole === "refer" ? "refer_image" : "first_frame";
  const modelKey = keys.find((key) => ["model", "model_name", "modelname"].includes(key.toLowerCase()));
  const modelEnum = modelKey ? chosen.schema?.properties?.[modelKey]?.enum?.map(String) : undefined;
  if (modelEnum?.length) {
    const aliases = model === "kling-3.0-omni" || /omni/i.test(model) ? ["kling-v3-omni", "kling-video-o1", model] : [model, "kling-v3", "kling-3.0-turbo"];
    const hit = aliases.find((item) => modelEnum.includes(item));
    if (!hit) {
      return { tool: chosen.name, args: {}, error: `可靈不接受「${model}」。它要的是：${modelEnum.join("、")}` };
    }
    model = hit;
  }
  const prompt =
    imageRole === "refer_image" && values.prompt && !/@image_\d+\b/.test(values.prompt)
      ? `${(values.images ?? [values.image]).filter(Boolean).map((_, index) => `@image_${index + 1}`).join(" ")} ${values.prompt}`.trim()
      : values.prompt;
  const built = argsFor(chosen.schema, {
    prompt,
    duration: values.duration,
    aspect: values.aspect,
    resolution: values.resolution,
    image: values.image,
    images: values.images,
    model,
    imageRole,
  });
  const sentRefer =
    imageRole === "refer_image" &&
    (Object.keys(built.args).some((key) => /refer|images/i.test(key)) || /omni/i.test(chosen.name));
  if (imageRole === "refer_image" && values.image && !sentRefer) {
    return { tool: chosen.name, args: built.args, error: "這個帳號工具只能把圖片當首幀。參考圖請改用 API Key 的 3.0 Omni。" };
  }
  if (values.prompt && !built.args.prompt) built.args.prompt = values.prompt;
  for (const name of specArgs(values.spec, chosen.name)) {
    if (/prompt/i.test(name) && values.prompt && (built.args[name] == null || built.args[name] === "")) {
      built.args[name] = values.prompt;
    }
  }
  if (omni && !omniTool) {
    const modelSent = Object.entries(built.args).some(([key, value]) => /model/i.test(key) && String(value).includes("omni"));
    if (!modelSent) {
      return { tool: chosen.name, args: built.args, error: "可靈帳號這條還沒有 Omni。請改用 API Key，模型選 3.0 Omni。" };
    }
  }
  return { tool: chosen.name, args: built.args, error: built.error };
}

function specArgs(data: unknown, toolName: string) {
  const names: string[] = [];
  const visit = (value: unknown, active: boolean) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, active);
      return;
    }
    const record = value as Record<string, unknown>;
    const label = [record.name, record.tool, record.command, record.id].find((item) => typeof item === "string");
    const next = active || (typeof label === "string" && label.toLowerCase() === toolName.toLowerCase());
    if (next && Array.isArray(record.required)) {
      for (const item of record.required) if (typeof item === "string") names.push(item);
    }
    for (const child of Object.values(record)) visit(child, next);
  };
  visit(data, false);
  return [...new Set(names)];
}

export function queryArgs(schema: ToolSchema | undefined, id: string) {
  const keys = Object.keys(schema?.properties ?? {});
  const key = keys.find((item) => /generation|task.?id|^id$/i.test(item)) ?? keys[0];
  if (!key) return { generation_id: id };
  return { [key]: id };
}
