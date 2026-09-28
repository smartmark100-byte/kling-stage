import { createServerFn } from "@tanstack/react-start";
import {
  LEGACY_MODELS,
  NEW_MODELS,
  type ApiResult,
  type AspectRatio,
  type AuthKind,
  type GenMode,
  type ImageRole,
  type JobView,
  type ProbeResult,
  type RegionId,
  type Resolution,
} from "@/lib/kling-shared";

const BASE: Record<RegionId, string> = {
  singapore: "https://api-singapore.klingai.com",
  beijing: "https://api-beijing.klingai.com",
};

const NEW_IDS = new Set<string>(NEW_MODELS.map((m) => m.id));
const LEGACY_IDS = new Set<string>(LEGACY_MODELS.map((m) => m.id));

type AuthInput =
  | { kind: "apikey"; apiKey: string; accessKey?: string; secretKey?: string }
  | { kind: "legacy"; apiKey?: string; accessKey: string; secretKey: string };

type CreateBody = {
  auth: AuthInput;
  region: RegionId;
  mode: GenMode;
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  imageRole: ImageRole;
  imageUrl: string;
  imageBase64: string;
  images: Array<{ url: string; base64: string }>;
};

type QueryBody = {
  auth: AuthInput;
  region: RegionId;
  taskId: string;
  authKind: AuthKind;
  mode: GenMode;
};

function fail(error: string, requestId: string | null = null): ApiResult {
  return { ok: false, error, requestId, task: null };
}

function okTask(task: JobView, requestId: string | null): ApiResult {
  return { ok: true, error: null, requestId, task };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isRegion(value: unknown): value is RegionId {
  return value === "singapore" || value === "beijing";
}

function cleanAuth(value: unknown): AuthInput | string {
  const rec = asRecord(value);
  if (!rec) return "金鑰格式不對";
  if (rec.kind === "legacy") {
    const accessKey = typeof rec.accessKey === "string" ? rec.accessKey.trim() : "";
    const secretKey = typeof rec.secretKey === "string" ? rec.secretKey.trim() : "";
    if (accessKey.length < 4 || accessKey.length > 200) return "請填 Access Key";
    if (secretKey.length < 4 || secretKey.length > 400) return "請填 Secret Key";
    return { kind: "legacy", accessKey, secretKey };
  }
  if (rec.kind === "apikey") {
    const apiKey = typeof rec.apiKey === "string" ? rec.apiKey.trim() : "";
    if (apiKey.length < 8 || apiKey.length > 500) return "請貼上可靈 API Key";
    return { kind: "apikey", apiKey };
  }
  return "請選擇金鑰類型";
}

function parseCreate(input: unknown): CreateBody | string {
  const rec = asRecord(input);
  if (!rec) return "請求格式不對";
  const auth = cleanAuth(rec.auth);
  if (typeof auth === "string") return auth;
  if (!isRegion(rec.region)) return "請選擇機房";
  if (rec.mode !== "text" && rec.mode !== "image") return "請選擇文字或圖片";
  const model = typeof rec.model === "string" ? rec.model : "";
  if (auth.kind === "apikey" && !NEW_IDS.has(model)) return "這個模型不能用 API Key 介面";
  if (auth.kind === "legacy" && !LEGACY_IDS.has(model)) return "這個模型不能用舊版金鑰";
  const prompt = typeof rec.prompt === "string" ? rec.prompt.trim() : "";
  if (prompt.length > 2500) return "提示詞請壓在 2500 字以內";
  if (rec.mode === "text" && prompt.length < 2) return "請寫一段鏡頭描述";
  const duration = typeof rec.duration === "number" ? rec.duration : NaN;
  const flexible = auth.kind === "apikey" && (model === "kling-3.0-turbo" || model === "kling-3.0-omni");
  if (flexible) {
    if (!Number.isInteger(duration) || duration < 3 || duration > 15) return "時長請選 3 到 15 秒";
  } else if (duration !== 5 && duration !== 10) {
    return "這個模型只接受 5 秒或 10 秒";
  }
  const aspectRatio = rec.aspectRatio;
  if (aspectRatio !== "16:9" && aspectRatio !== "9:16" && aspectRatio !== "1:1") {
    return "畫幅不正確";
  }
  const resolution = rec.resolution;
  const omni = model === "kling-3.0-omni";
  if (resolution !== "720p" && resolution !== "1080p" && !(omni && resolution === "4k")) return "解析度不正確";
  const imageRole: ImageRole = rec.imageRole === "refer" ? "refer" : "first";
  if (imageRole === "refer" && !omni) return "參考圖只有 3.0 Omni 能用";
  if (imageRole === "refer" && rec.mode !== "image") return "參考圖要搭配圖片";
  const imageUrl = typeof rec.imageUrl === "string" ? rec.imageUrl.trim() : "";
  const imageBase64 = typeof rec.imageBase64 === "string" ? rec.imageBase64.replace(/\s/g, "") : "";
  const images: Array<{ url: string; base64: string }> = [];
  if (imageRole === "refer" && Array.isArray(rec.images)) {
    if (rec.images.length > 7) return "參考圖最多 7 張";
    for (const item of rec.images) {
      const row = asRecord(item);
      if (!row) return "參考圖格式不對";
      const url = typeof row.url === "string" ? row.url.trim() : "";
      const base64 = typeof row.base64 === "string" ? row.base64.replace(/\s/g, "") : "";
      const problem = checkImage(url, base64);
      if (problem) return problem;
      if (!url && !base64) return "有一張參考圖是空的";
      images.push({ url, base64 });
    }
  }
  if (imageRole === "refer" && !images.length && (imageUrl || imageBase64)) {
    const problem = checkImage(imageUrl, imageBase64);
    if (problem) return problem;
    images.push({ url: imageUrl, base64: imageBase64 });
  }
  if (rec.mode === "image" && imageRole !== "refer") {
    const problem = checkImage(imageUrl, imageBase64);
    if (problem) return problem;
    if (!imageUrl && !imageBase64) return "請上傳圖片，或貼上圖片網址";
  }
  if (imageRole === "refer" && !images.length) return "請至少放一張參考圖";
  if (images.reduce((sum, item) => sum + item.base64.length, 0) > 4_500_000) {
    return "參考圖加起來太大，請少放幾張";
  }
  if (imageRole === "refer" && prompt.length < 2) return "參考圖請寫鏡頭描述，可用 @image_1 指這張圖";
  return {
    auth,
    region: rec.region,
    mode: rec.mode,
    model,
    prompt,
    duration,
    aspectRatio,
    resolution,
    imageRole,
    imageUrl,
    imageBase64,
    images,
  };
}

function checkImage(url: string, base64: string): string | null {
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "圖片網址不正確";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "圖片網址必須是 http 或 https";
  }
  if (base64 && base64.length > 1_800_000) return "圖片太大，請換一張較小的";
  if (base64 && !/^[A-Za-z0-9+/=]+$/.test(base64)) return "圖片資料不正確";
  return null;
}

function parseQuery(input: unknown): QueryBody | string {
  const rec = asRecord(input);
  if (!rec) return "請求格式不對";
  const auth = cleanAuth(rec.auth);
  if (typeof auth === "string") return auth;
  if (!isRegion(rec.region)) return "請選擇機房";
  if (rec.authKind !== "apikey" && rec.authKind !== "legacy") return "金鑰類型不對";
  if (rec.mode !== "text" && rec.mode !== "image") return "任務類型不對";
  const taskId = typeof rec.taskId === "string" ? rec.taskId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) return "任務編號不正確";
  if (auth.kind !== rec.authKind) return "金鑰類型和任務不相符";
  return { auth, region: rec.region, taskId, authKind: rec.authKind, mode: rec.mode };
}

async function bearer(auth: AuthInput): Promise<string> {
  if (auth.kind === "apikey") return auth.apiKey;
  const { SignJWT } = await import("jose");
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(auth.accessKey)
    .setExpirationTime(now + 1800)
    .setNotBefore(now - 5)
    .sign(new TextEncoder().encode(auth.secretKey));
}

type Envelope = { code?: number | string; message?: string; request_id?: string; data?: unknown };

async function klingCall(url: string, token: string, init?: { method?: string; body?: string }) {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init?.body,
    signal: AbortSignal.timeout(init?.body ? 45_000 : 20_000),
  });
  const text = await res.text();
  let json: Envelope | null = null;
  try {
    json = JSON.parse(text) as Envelope;
  } catch {
    json = null;
  }
  return { res, json, text };
}

function requestIdOf(json: Envelope | null) {
  return json && typeof json.request_id === "string" ? json.request_id : null;
}

function readVideo(item: Record<string, unknown>): Pick<JobView, "videoUrl" | "watermarkUrl" | "duration"> {
  let videoUrl: string | null = null;
  let watermarkUrl: string | null = null;
  let duration: string | null = null;
  const take = (video: Record<string, unknown>) => {
    if (typeof video.url === "string" && video.url) videoUrl = video.url;
    if (typeof video.watermark_url === "string" && video.watermark_url) watermarkUrl = video.watermark_url;
    if (video.duration != null && video.duration !== "") duration = String(video.duration);
  };
  if (Array.isArray(item.outputs)) {
    for (const output of item.outputs) {
      const rec = asRecord(output);
      if (rec?.type === "video") take(rec);
    }
  }
  const result = asRecord(item.task_result);
  const videos = result && Array.isArray(result.videos) ? result.videos : [];
  const first = asRecord(videos[0]);
  if (first) take(first);
  return { videoUrl, watermarkUrl, duration };
}

function normalizeTask(raw: unknown): JobView | null {
  const item = asRecord(raw);
  if (!item) return null;
  const id = String(item.id ?? item.task_id ?? "");
  if (!id || id === "undefined") return null;
  let status = String(item.status ?? item.task_status ?? "submitted").toLowerCase();
  if (status === "succeed" || status === "success" || status === "completed") status = "succeeded";
  if (status === "running" || status === "pending" || status === "queued") status = "processing";
  if (status === "failed" || status === "failure" || status === "canceled" || status === "cancelled") status = "failed";
  const message = String(item.message ?? item.task_status_msg ?? "");
  return { id, status, message, ...readVideo(item) };
}

function tasksFrom(data: unknown): JobView[] {
  if (Array.isArray(data)) {
    return data.map(normalizeTask).filter((task): task is JobView => task !== null);
  }
  const rec = asRecord(data);
  if (!rec) return [];
  if (Array.isArray(rec.result)) {
    return rec.result.map(normalizeTask).filter((task): task is JobView => task !== null);
  }
  const one = normalizeTask(rec);
  return one ? [one] : [];
}

function localize(message: string) {
  if (/does not support AK\/SK/i.test(message)) {
    return "這組是舊版 Access Key，不能當 API Key 用。請改切到「舊版 AK / SK」，或到可靈後台建立新的 API Key。";
  }
  return message;
}

function explainHttp(status: number, json: Envelope | null, text: string): string {
  const fromApi = json?.message?.trim();
  if (status === 401 || status === 403) return localize(fromApi || "金鑰被拒絕，請核對機房與金鑰");
  if (fromApi) return localize(fromApi);
  const snippet = text.replace(/\s+/g, " ").slice(0, 180);
  return snippet ? `可靈回應 ${status}：${snippet}` : `可靈回應 ${status}`;
}

function businessError(json: Envelope | null): string | null {
  if (!json || json.code == null || json.code === "") return null;
  const code = Number(json.code);
  if (code === 0) return null;
  return localize(json.message?.trim() || `可靈回傳錯誤 ${json.code}`);
}

function networkError(error: unknown): string {
  const msg = error instanceof Error ? error.message : "";
  if (/timeout|aborted|abort/i.test(msg)) return "連線逾時，可靈沒有回應";
  return "連不到可靈，請稍後再試";
}

async function tokenOrFail(auth: AuthInput): Promise<string | ApiResult> {
  try {
    return await bearer(auth);
  } catch {
    return fail("舊版金鑰簽章失敗，請檢查 Access Key 與 Secret Key");
  }
}

export const createKlingVideo = createServerFn({ method: "POST" })
  .validator((input: CreateBody) => input)
  .handler(async ({ data }): Promise<ApiResult> => {
    const parsed = parseCreate(data);
    if (typeof parsed === "string") return fail(parsed);
    const token = await tokenOrFail(parsed.auth);
    if (typeof token !== "string") return token;
    const base = BASE[parsed.region];
    let url: string;
    let body: string;
    if (parsed.auth.kind === "apikey") {
      const frame = parsed.imageUrl || parsed.imageBase64;
      if (parsed.model === "kling-3.0-omni") {
        url = `${base}/omni-video/kling-3.0-omni`;
        const tags = parsed.images.map((_, index) => `@image_${index + 1}`);
        const spoken = tags.some((tag) => parsed.prompt.includes(tag))
          ? `${tags.filter((tag) => !parsed.prompt.includes(tag)).join(" ")} ${parsed.prompt}`.trim()
          : `${tags.join(" ")} ${parsed.prompt}`.trim();
        const contents: Array<Record<string, string>> = [];
        if (spoken) contents.push({ type: "prompt", text: spoken });
        if (parsed.imageRole === "refer") {
          parsed.images.forEach((image, index) => {
            contents.push({ type: "refer_image", url: image.url || image.base64, id: `image_${index + 1}` });
          });
        } else if (parsed.mode === "image") {
          contents.push({ type: "first_frame", url: frame });
        }
        body = JSON.stringify({
          contents,
          settings: {
            resolution: parsed.resolution,
            aspect_ratio: parsed.aspectRatio,
            duration: parsed.duration,
            audio: "off",
            multi_shot: false,
          },
          options: { watermark_info: { enabled: false } },
        });
      } else {
        const path = parsed.mode === "text" ? "text-to-video" : "image-to-video";
        url = `${base}/${path}/${parsed.model}`;
        if (parsed.mode === "text") {
          body = JSON.stringify({
            prompt: parsed.prompt,
            settings: {
              resolution: parsed.resolution,
              aspect_ratio: parsed.aspectRatio,
              duration: parsed.duration,
            },
            options: { watermark_info: { enabled: false } },
          });
        } else {
          const contents: Array<Record<string, string>> = [];
          if (parsed.prompt) contents.push({ type: "prompt", text: parsed.prompt });
          contents.push({ type: "first_frame", url: frame });
          body = JSON.stringify({
            contents,
            settings: { resolution: parsed.resolution, duration: parsed.duration },
            options: { watermark_info: { enabled: false } },
          });
        }
      }
    } else {
      const mode = parsed.resolution === "1080p" ? "pro" : "std";
      if (parsed.mode === "text") {
        url = `${base}/v1/videos/text2video`;
        body = JSON.stringify({
          model_name: parsed.model,
          prompt: parsed.prompt,
          duration: String(parsed.duration),
          aspect_ratio: parsed.aspectRatio,
          mode,
        });
      } else {
        url = `${base}/v1/videos/image2video`;
        body = JSON.stringify({
          model_name: parsed.model,
          prompt: parsed.prompt || "Natural cinematic motion.",
          image: parsed.imageUrl || parsed.imageBase64,
          duration: String(parsed.duration),
          mode,
        });
      }
    }
    try {
      const { res, json, text } = await klingCall(url, token, { method: "POST", body });
      const requestId = requestIdOf(json);
      if (!res.ok) return fail(explainHttp(res.status, json, text), requestId);
      const biz = businessError(json);
      if (biz) return fail(biz, requestId);
      const task = tasksFrom(json?.data)[0];
      if (!task) return fail("可靈沒有回任務編號", requestId);
      return okTask(task, requestId);
    } catch (error) {
      return fail(networkError(error));
    }
  });

export const queryKlingTask = createServerFn({ method: "POST" })
  .validator((input: QueryBody) => input)
  .handler(async ({ data }): Promise<ApiResult> => {
    const parsed = parseQuery(data);
    if (typeof parsed === "string") return fail(parsed);
    const token = await tokenOrFail(parsed.auth);
    if (typeof token !== "string") return token;
    const base = BASE[parsed.region];
    const url =
      parsed.authKind === "apikey"
        ? `${base}/tasks?${new URLSearchParams({ task_ids: parsed.taskId })}`
        : `${base}/v1/videos/${parsed.mode === "text" ? "text2video" : "image2video"}/${parsed.taskId}`;
    try {
      const { res, json, text } = await klingCall(url, token);
      const requestId = requestIdOf(json);
      if (!res.ok) return fail(explainHttp(res.status, json, text), requestId);
      const biz = businessError(json);
      if (biz) return fail(biz, requestId);
      const task = tasksFrom(json?.data).find((item) => item.id === parsed.taskId) ?? tasksFrom(json?.data)[0];
      if (!task) return fail("還沒查到這筆任務", requestId);
      return okTask(task, requestId);
    } catch (error) {
      return fail(networkError(error));
    }
  });

export const probeKlingKey = createServerFn({ method: "POST" })
  .validator((input: { auth: AuthInput; region: RegionId }) => input)
  .handler(async ({ data }): Promise<ProbeResult> => {
    const auth = cleanAuth(data?.auth);
    if (typeof auth === "string") return { ok: false, error: auth, detail: null };
    if (!isRegion(data?.region)) return { ok: false, error: "請選擇機房", detail: null };
    const token = await bearer(auth).catch(() => null);
    if (!token) return { ok: false, error: "舊版金鑰簽章失敗", detail: null };
    const url =
      auth.kind === "apikey"
        ? `${BASE[data.region]}/tasks?task_ids=0`
        : `${BASE[data.region]}/v1/videos/text2video/0`;
    try {
      const { res, json, text } = await klingCall(url, token);
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: localize(json?.message || "金鑰被拒絕"), detail: null };
      }
      const message = json?.message || "";
      const code = json?.code == null ? null : Number(json.code);
      if (
        code === 1001 ||
        code === 1002 ||
        code === 1003 ||
        code === 1004 ||
        /unauthorized|api key|access key|signature|auth/i.test(message)
      ) {
        return { ok: false, error: localize(message || "金鑰被拒絕"), detail: null };
      }
      if (res.status >= 500) return { ok: false, error: explainHttp(res.status, json, text), detail: null };
      return {
        ok: true,
        error: null,
        detail: auth.kind === "apikey" ? "API Key 已被可靈接受" : "Access Key 簽章已被可靈接受",
      };
    } catch (error) {
      return { ok: false, error: networkError(error), detail: null };
    }
  });
