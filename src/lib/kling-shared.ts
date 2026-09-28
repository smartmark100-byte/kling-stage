export const REGIONS = [
  { id: "singapore", label: "新加坡", hint: "海外帳號" },
  { id: "beijing", label: "北京", hint: "中國站帳號" },
] as const;

export type RegionId = (typeof REGIONS)[number]["id"];

export const NEW_MODELS = [
  {
    id: "kling-3.0-omni",
    label: "3.0 Omni",
    note: "首幀或參考圖，3–15 秒，可到 4K",
    durations: "range" as const,
  },
  {
    id: "kling-3.0-turbo",
    label: "3.0 Turbo",
    note: "3–15 秒，帶原生聲音",
    durations: "range" as const,
  },
  {
    id: "kling-2.6",
    label: "2.6",
    note: "5 或 10 秒，帶原生聲音",
    durations: "pair" as const,
  },
  {
    id: "kling-2.5-turbo",
    label: "2.5 Turbo",
    note: "5 或 10 秒，速度優先",
    durations: "pair" as const,
  },
] as const;

export const LEGACY_MODELS = [
  { id: "kling-v2-6", label: "2.6" },
  { id: "kling-v2-5-turbo", label: "2.5 Turbo" },
  { id: "kling-v1-6", label: "1.6" },
] as const;

export type NewModelId = (typeof NEW_MODELS)[number]["id"];
export type LegacyModelId = (typeof LEGACY_MODELS)[number]["id"];
export type AspectRatio = "16:9" | "9:16" | "1:1";
export type Resolution = "720p" | "1080p" | "4k";
export type GenMode = "text" | "image";
export type ImageRole = "first" | "refer";
export type AuthKind = "mcp" | "apikey" | "legacy";

export type JobView = {
  id: string;
  status: string;
  message: string;
  videoUrl: string | null;
  watermarkUrl: string | null;
  duration: string | null;
};

export type ApiResult = {
  ok: boolean;
  error: string | null;
  requestId: string | null;
  task: JobView | null;
};

export type ProbeResult = {
  ok: boolean;
  error: string | null;
  detail: string | null;
};

export function isTerminal(status: string) {
  return status === "succeeded" || status === "failed";
}

export function statusLabel(status: string) {
  switch (status) {
    case "submitted":
      return "已送出";
    case "processing":
      return "生成中";
    case "succeeded":
      return "完成";
    case "failed":
      return "失敗";
    case "missing":
      return "沒有這支片";
    default:
      return status || "等待中";
  }
}

export function isFlexibleModel(model: string) {
  return model === "kling-3.0-turbo" || model === "kling-3.0-omni" || model === "mcp";
}

export function snapDuration(model: string, authKind: AuthKind, value: number) {
  if (authKind === "legacy" || !isFlexibleModel(model)) {
    return value >= 8 ? 10 : 5;
  }
  const n = Math.round(value);
  return Math.min(15, Math.max(3, Number.isFinite(n) ? n : 5));
}
