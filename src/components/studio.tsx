import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Clapperboard,
  ExternalLink,
  ImagePlus,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import { createKlingVideo, queryKlingTask } from "@/lib/kling";
import {
  accountLabel,
  beginKlingLogin,
  generationIdOf,
  listedModels,
  loadMcpTokens,
  mcpCall,
  mcpTools,
  planMcpVideo,
  pullKlingLogin,
  queryArgs,
  replyText,
  saveMcpTokens,
  taskViewOf,
  uploadKlingImage,
  type McpTool,
} from "@/lib/mcp-client";
import {
  LEGACY_MODELS,
  NEW_MODELS,
  isFlexibleModel,
  isTerminal,
  snapDuration,
  statusLabel,
  type AspectRatio,
  type AuthKind,
  type GenMode,
  type ImageRole,
  type RegionId,
  type Resolution,
} from "@/lib/kling-shared";

const SETTINGS_KEY = "kling-stage-settings";
const HISTORY_KEY = "kling-stage-history";

const EXAMPLES = [
  "夜雨的台北巷口，計程車緩緩停下，霓虹倒映在濕瀝青上，鏡頭慢慢前推",
  "午後窗光裡的咖啡拉花，蒸汽緩緩升起，淺景深，電影感",
  "金黃稻田裡一個小孩奔跑，風吹過稻穗，慢動作，暖色調",
];

type Clip = {
  id: string;
  prompt: string;
  mode: GenMode;
  model: string;
  authKind: AuthKind;
  region: RegionId;
  status: string;
  message: string;
  videoUrl: string | null;
  watermarkUrl: string | null;
  createdAt: number;
  checkedAt: number | null;
  progress: number | null;
  failCount: number;
  aspect: AspectRatio;
  duration: number;
  requestId: string | null;
};

type Settings = {
  remember: boolean;
  authKind: AuthKind;
  apiKey: string;
  accessKey: string;
  secretKey: string;
  region: RegionId;
  modelNew: string;
  modelLegacy: string;
  resolution: Resolution;
  aspect: AspectRatio;
  duration: number;
};

const DEFAULT_SETTINGS: Settings = {
  remember: true,
  authKind: "mcp",
  apiKey: "",
  accessKey: "",
  secretKey: "",
  region: "singapore",
  modelNew: "kling-3.0-turbo",
  modelLegacy: "kling-v2-5-turbo",
  resolution: "720p",
  aspect: "16:9",
  duration: 5,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadHistory(): Clip[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Clip[];
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

async function compressImage(file: File, budget: { edge: number; chars: number } = { edge: 1280, chars: 1_500_000 }) {
  if (!file.type.startsWith("image/")) throw new Error("請上傳 jpg 或 png");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, budget.edge / Math.max(bitmap.width, bitmap.height));
  let width = Math.max(1, Math.round(bitmap.width * scale));
  let height = Math.max(1, Math.round(bitmap.height * scale));
  const shortSide = Math.min(width, height);
  if (shortSide < 300) {
    const up = 300 / shortSide;
    width = Math.round(width * up);
    height = Math.round(height * up);
  }
  const ratio = width / height;
  if (ratio > 2.5 || ratio < 1 / 2.5) {
    bitmap.close();
    throw new Error("圖片太窄或太長，可靈大約只收 1:2.5 到 2.5:1");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("這台瀏覽器無法處理圖片");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  let quality = 0.86;
  let preview = canvas.toDataURL("image/jpeg", quality);
  while (preview.length > budget.chars && quality > 0.45) {
    quality -= 0.08;
    preview = canvas.toDataURL("image/jpeg", quality);
  }
  if (preview.length > budget.chars + 300_000) throw new Error("圖片還是太大，請換一張較小的");
  return { base64: preview.slice(preview.indexOf(",") + 1), preview };
}

type RefShot = { key: string; url: string; base64: string; preview: string };

const REF_LIMIT = 7;

function aspectClass(aspect: AspectRatio) {
  if (aspect === "9:16") return "aspect-poster w-full max-w-xs";
  if (aspect === "1:1") return "aspect-frame w-full max-w-md";
  return "aspect-wide w-full";
}

function mentionAt(value: string, caret: number) {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (!/^[A-Za-z0-9_]*$/.test(query)) return null;
  return { start: at, query: query.toLowerCase() };
}

function heardLabel(checkedAt: number | null, now: number) {
  if (!checkedAt) return "還沒問到可靈";
  const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
  if (seconds < 5) return "剛剛問到可靈";
  return `${seconds} 秒前問到可靈`;
}

function waitedLabel(createdAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `已等 ${rest} 秒`;
  return `已等 ${minutes} 分 ${rest} 秒`;
}

function modelLabel(id: string) {
  return (
    NEW_MODELS.find((model) => model.id === id)?.label ??
    LEGACY_MODELS.find((model) => model.id === id)?.label ??
    (id === "mcp" ? "可靈帳號" : id)
  );
}

export function Studio() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<GenMode>("text");
  const [imageRole, setImageRole] = useState<ImageRole>("first");
  const [prompt, setPrompt] = useState(EXAMPLES[0]);
  const [imageBase64, setImageBase64] = useState("");
  const [preview, setPreview] = useState("");
  const [refs, setRefs] = useState<RefShot[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [mcpAccount, setMcpAccount] = useState<string | null>(null);
  const [mcpReady, setMcpReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pendingLogin, setPendingLogin] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [mcpEpoch, setMcpEpoch] = useState(0);
  const toolsRef = useRef<McpTool[]>([]);
  const modelsRef = useRef<string[]>([]);
  const specRef = useRef<unknown>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const settingsRef = useRef(settings);
  const clipsRef = useRef(clips);
  settingsRef.current = settings;
  clipsRef.current = clips;

  useEffect(() => {
    const stored = loadSettings();
    if (stored.authKind !== "mcp") stored.authKind = "mcp";
    setSettings(stored);
    const history = loadHistory().map((clip) =>
      clip.status === "failed" && /問不到進度|查進度失敗|拒絕了這次生成/.test(clip.message || "")
        ? { ...clip, status: "processing", message: "" }
        : clip,
    );
    setClips(history);
    setFocusId(history[0]?.id ?? null);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const toStore = settings.remember
      ? settings
      : { ...settings, apiKey: "", accessKey: "", secretKey: "" };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(toStore));
  }, [settings, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(clips.slice(0, 20)));
  }, [clips, hydrated]);

  const pendingKey = clips
    .filter((clip) => !isTerminal(clip.status))
    .map((clip) => `${clip.id}:${clip.authKind}:${clip.region}:${clip.mode}`)
    .join("|");

  useEffect(() => {
    if (!hydrated || !pendingKey) return;
    let stop = false;
    let timer = 0;
    const run = async () => {
      const current = settingsRef.current;
      const queue = clipsRef.current.filter((clip) => !isTerminal(clip.status)).slice(0, 3);
      for (const clip of queue) {
        if (stop) return;
        if (clip.authKind === "mcp") {
          const queryTool = toolsRef.current.find((tool) => tool.name === "query_tasks");
          const polled = await mcpCall("query_tasks", queryArgs(queryTool?.schema, clip.id));
          if (stop) return;
          if (!polled.ok) {
            const error = polled.error || "查進度失敗";
            setClips((prev) =>
              prev.map((item) =>
                item.id === clip.id
                  ? { ...item, message: `暫時問不到進度：${error}`, checkedAt: Date.now() }
                  : item,
              ),
            );
            setFormError(`暫時問不到進度：${error}。片子不一定失敗，還會再問。`);
            continue;
          }
          const view = taskViewOf(polled.data, clip.id);
          setClips((prev) =>
            prev.map((item) =>
              item.id === clip.id
                ? {
                    ...item,
                    status: view.status,
                    message:
                      view.status === "missing"
                        ? "可靈沒有這支片子。網站上看不到是對的，之前只是有問到伺服器。"
                        : view.status === "failed"
                          ? view.message || "生成失敗"
                          : view.message || "",
                    videoUrl: view.videoUrl,
                    checkedAt: Date.now(),
                    progress: view.progress,
                    failCount: view.status === "failed" ? item.failCount : 0,
                  }
                : item,
            ),
          );
          if (view.status === "failed") setFormError(view.message || "生成失敗");
          if (view.status === "missing") setFormError("可靈沒有這支片子。網站上看不到是對的。");
          continue;
        }
        if (clip.authKind !== "apikey" && clip.authKind !== "legacy") continue;
        const auth =
          clip.authKind === "apikey"
            ? { kind: "apikey" as const, apiKey: current.apiKey }
            : { kind: "legacy" as const, accessKey: current.accessKey, secretKey: current.secretKey };
        if (clip.authKind === "apikey" && current.apiKey.trim().length < 8) continue;
        if (clip.authKind === "legacy" && current.secretKey.trim().length < 4) continue;
        const result = await queryKlingTask({
          data: {
            auth,
            region: clip.region,
            taskId: clip.id,
            authKind: clip.authKind,
            mode: clip.mode,
          },
        });
        if (stop) return;
        if (!result.ok || !result.task) {
          const error = result.error || "查進度失敗";
          setClips((prev) =>
            prev.map((item) =>
              item.id === clip.id
                ? { ...item, message: `暫時問不到進度：${error}`, checkedAt: Date.now() }
                : item,
            ),
          );
          setFormError(`暫時問不到進度：${error}。片子不一定失敗，還會再問。`);
          continue;
        }
        const task = result.task;
        setClips((prev) =>
          prev.map((item) =>
            item.id === clip.id
              ? {
                  ...item,
                  status: task.status,
                  message: task.message || (task.status === "failed" ? "生成失敗" : ""),
                  videoUrl: task.videoUrl,
                  watermarkUrl: task.watermarkUrl,
                  requestId: result.requestId || item.requestId,
                  checkedAt: Date.now(),
                  failCount: task.status === "failed" ? item.failCount : 0,
                }
              : item,
          ),
        );
        if (task.status === "failed") setFormError(task.message || "生成失敗");
      }
      if (!stop) timer = window.setTimeout(run, 5000);
    };
    timer = window.setTimeout(run, 2000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [hydrated, pendingKey]);

  const focus = clips.find((clip) => clip.id === focusId) ?? clips[0] ?? null;
  const waiting = Boolean(focus && !focus.videoUrl && !isTerminal(focus.status) && focus.status !== "missing");
  const waitedMs = focus ? now - focus.createdAt : 0;
  const late = Boolean(waiting && waitedMs > 10 * 60 * 1000);
  const deaf = Boolean(
    waiting &&
      waitedMs > 45_000 &&
      (!focus?.checkedAt || now - (focus?.checkedAt ?? now) > 25_000),
  );

  useEffect(() => {
    if (!focus || focus.videoUrl || isTerminal(focus.status) || focus.message) return;
    const notice = late
      ? "這支已超過 10 分鐘還沒完成。這不是失敗，可靈還沒回錯誤。請到官網看，不要重送。"
      : deaf
        ? "這頁暫時問不到進度。片子不一定失敗，還會再問。"
        : null;
    if (notice) setFormError((prev) => (prev === notice ? prev : notice));
  }, [focus, late, deaf]);

  useEffect(() => {
    if (!focus || focus.videoUrl || isTerminal(focus.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [focus]);
  const model = settings.authKind === "legacy" ? settings.modelLegacy : settings.modelNew;
  const omni = model === "kling-3.0-omni";
  const flexible = isFlexibleModel(model);
  const modelNote = NEW_MODELS.find((item) => item.id === model)?.note;
  const resolution: Resolution = !omni && settings.resolution === "4k" ? "1080p" : settings.resolution;

  const authPayload = useMemo(() => {
    if (settings.authKind === "apikey") return { kind: "apikey" as const, apiKey: settings.apiKey.trim() };
    return {
      kind: "legacy" as const,
      accessKey: settings.accessKey.trim(),
      secretKey: settings.secretKey.trim(),
    };
  }, [settings]);

  useEffect(() => {
    if (!hydrated) return;
    let stop = false;
    const refresh = async () => {
      const tokens = loadMcpTokens();
      if (!tokens) {
        if (!stop) {
          setMcpReady(false);
          setMcpAccount(null);
          toolsRef.current = [];
          modelsRef.current = [];
          specRef.current = null;
        }
        return;
      }
      const listed = await mcpTools();
      if (stop) return;
      if (listed.error && !loadMcpTokens()) {
        setMcpReady(false);
        setMcpAccount(null);
        toolsRef.current = [];
        modelsRef.current = [];
        specRef.current = null;
        return;
      }
      toolsRef.current = listed.tools;
      setMcpReady(true);
      setConnecting(false);
      const who = listed.tools.some((tool) => tool.name === "who_am_i") ? await mcpCall("who_am_i", {}) : null;
      if (stop) return;
      modelsRef.current = who?.ok ? listedModels(who.data) : [];
      specRef.current = who?.ok ? who.data : null;
      setMcpAccount(who?.ok ? accountLabel(who.data) : listed.error);
    };
    void refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === "kling-mcp-tokens") void refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      stop = true;
      window.removeEventListener("storage", onStorage);
    };
  }, [hydrated, mcpEpoch]);

  useEffect(() => {
    if (!pendingLogin) return;
    let stop = false;
    let misses = 0;
    const timer = window.setInterval(() => {
      void pullKlingLogin(pendingLogin).then((result) => {
        if (stop || result.status === "pending") return;
        if (result.status === "missing") {
          misses += 1;
          if (misses < 5) return;
        }
        setPendingLogin(null);
        setLoginUrl(null);
        setConnecting(false);
        if (result.status === "ok") {
          saveMcpTokens(result.tokens);
          setMcpEpoch((value) => value + 1);
          setFormError(null);
          return;
        }
        setFormError(result.status === "error" ? result.error : "這次登入已失效，請再連一次");
      });
    }, 1000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [pendingLogin]);

  function insertMention(index: number) {
    if (!mention) return;
    const token = `@image_${index + 1}`;
    const caret = promptRef.current?.selectionStart ?? prompt.length;
    const next = `${prompt.slice(0, mention.start)}${token} ${prompt.slice(caret)}`.slice(0, 2500);
    const place = Math.min(mention.start + token.length + 1, next.length);
    setPrompt(next);
    setMention(null);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(place, place);
    });
  }

  async function onConnect() {
    const tab = window.open("about:blank", "_blank");
    setConnecting(true);
    setFormError(null);
    setLoginUrl(null);
    try {
      const started = await beginKlingLogin();
      setPendingLogin(started.loginId);
      if (tab && !tab.closed) tab.location.href = started.url;
      else {
        tab?.close();
        setLoginUrl(started.url);
      }
    } catch (error) {
      tab?.close();
      setConnecting(false);
      setPendingLogin(null);
      setFormError(error instanceof Error ? error.message : "無法開啟可靈登入");
    }
  }
  function patch(partial: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      if (partial.modelNew || partial.modelLegacy || partial.authKind) {
        const nextModel = next.authKind === "legacy" ? next.modelLegacy : next.modelNew;
        next.duration = snapDuration(nextModel, next.authKind, next.duration);
        if (nextModel !== "kling-3.0-omni" && next.resolution === "4k") next.resolution = "1080p";
      }
      return next;
    });
  }

  async function onPickRefs(list: File[]) {
    if (!list.length) return;
    setImageError(null);
    const room = REF_LIMIT - refs.length;
    if (room <= 0) {
      setImageError("參考圖最多 7 張");
      return;
    }
    try {
      const next: RefShot[] = [];
      for (const file of list.slice(0, room)) {
        const image = await compressImage(file, { edge: 960, chars: 420_000 });
        next.push({ key: crypto.randomUUID(), url: "", base64: image.base64, preview: image.preview });
      }
      setRefs((prev) => [...prev, ...next].slice(0, REF_LIMIT));
      if (list.length > room) setImageError("參考圖最多 7 張，多的沒有加進去");
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "圖片讀取失敗");
    }
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setImageError(null);
    try {
      const image = await compressImage(file);
      setImageBase64(image.base64);
      setPreview(image.preview);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "圖片讀取失敗");
    }
  }

  async function onGenerate() {
    setFormError(null);
    if (settings.authKind === "apikey" && settings.apiKey.trim().length < 8) {
      setFormError("請貼上可靈 API Key");
      return;
    }
    if (settings.authKind === "legacy" && (settings.accessKey.trim().length < 4 || settings.secretKey.trim().length < 4)) {
      setFormError("請填 Access Key 和 Secret Key");
      return;
    }
    if (settings.authKind === "mcp" && !loadMcpTokens()) {
      setFormError("請先連接可靈帳號");
      return;
    }
    const usingRefer = omni && mode === "image" && imageRole === "refer";
    if (prompt.trim().length < 2) {
      setFormError(usingRefer ? "參考圖請寫鏡頭描述，可用 @image_1 指這張圖" : "請寫一段鏡頭描述。可靈一定要有 prompt。");
      return;
    }
    if (usingRefer && refs.length === 0) {
      setFormError("請至少放一張參考圖");
      return;
    }
    if (!usingRefer && mode === "image" && !imageBase64) {
      setFormError("請上傳圖片");
      return;
    }
    setSubmitting(true);
    try {
      if (settings.authKind === "mcp") {
        const sources = usingRefer
          ? refs.map((shot) => (shot.base64 ? `data:image/jpeg;base64,${shot.base64}` : "")).filter(Boolean)
          : imageBase64
            ? [`data:image/jpeg;base64,${imageBase64}`]
            : [];
        const hosted: string[] = [];
        for (const source of sources) {
          const uploaded = source.startsWith("data:") ? await uploadKlingImage(source, toolsRef.current) : { ok: true as const, url: source };
          if (!uploaded.ok) {
            setFormError(uploaded.error);
            return;
          }
          hosted.push(uploaded.url);
        }
        const role: ImageRole = omni && mode === "image" ? imageRole : "first";
        const built = planMcpVideo(toolsRef.current, {
          prompt: prompt.trim(),
          duration: snapDuration(model, settings.authKind, settings.duration),
          aspect: settings.aspect,
          resolution,
          image: hosted[0] ?? "",
          images: hosted,
          model,
          imageRole: role,
          allowedModels: modelsRef.current,
          spec: specRef.current,
        });
        if (built.error) {
          setFormError(built.error);
          return;
        }
        const called = await mcpCall(built.tool, built.args);
        if (!called.ok) {
          setFormError(called.error || "沒有送出");
          return;
        }
        const id = generationIdOf(called.data);
        if (!id) {
          setFormError(`可靈沒有建立這支片。它回：${replyText(called.data) || "沒有任務編號"}`);
          return;
        }
        const clip: Clip = {
          id,
          prompt: prompt.trim() || "圖片生成",
          mode,
          model,
          authKind: "mcp",
          region: settings.region,
          status: "submitted",
          message: "",
          videoUrl: null,
          watermarkUrl: null,
          createdAt: Date.now(),
          checkedAt: null,
          progress: null,
          failCount: 0,
          aspect: settings.aspect,
          duration: snapDuration(model, settings.authKind, settings.duration),
          requestId: null,
        };
        setClips((prev) => [clip, ...prev.filter((item) => item.id !== clip.id)].slice(0, 20));
        setFocusId(clip.id);
        setConnecting(false);
        return;
      }
      const result = await createKlingVideo({
        data: {
          auth: authPayload,
          region: settings.region,
          mode,
          model,
          prompt: prompt.trim(),
          duration: snapDuration(model, settings.authKind, settings.duration),
          aspectRatio: settings.aspect,
          resolution,
          imageRole: omni && mode === "image" ? imageRole : "first",
          imageUrl: "",
          imageBase64: mode === "image" && !usingRefer ? imageBase64 : "",
          images: usingRefer ? refs.map((shot) => ({ url: shot.url, base64: shot.base64 })) : [],
        },
      });
      if (!result.ok || !result.task) {
        setFormError(result.error || "沒有送出");
        return;
      }
      const clip: Clip = {
        id: result.task.id,
        prompt: prompt.trim() || "圖片生成",
        mode,
        model,
        authKind: settings.authKind,
        region: settings.region,
        status: result.task.status,
        message: result.task.message,
        videoUrl: result.task.videoUrl,
        watermarkUrl: result.task.watermarkUrl,
        createdAt: Date.now(),
        checkedAt: null,
        progress: null,
        failCount: 0,
        aspect: settings.aspect,
        duration: snapDuration(model, settings.authKind, settings.duration),
        requestId: result.requestId,
      };
      setClips((prev) => [clip, ...prev.filter((item) => item.id !== clip.id)].slice(0, 20));
      setFocusId(clip.id);
    } catch {
      setFormError("送出失敗，請再試一次");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting;
  const frameAspect = focus?.aspect ?? settings.aspect;

  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold tracking-widest text-brass">
              <Clapperboard className="size-4" aria-hidden="true" />
              KLING STAGE
            </p>
            <h1 className="mt-1 font-display text-4xl leading-none text-fg">可靈片場</h1>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted">
              用可靈帳號連上 MCP 生短片。授權只留在這台瀏覽器，生成會計入你的可靈點數。
            </p>
          </div>
          <p className="rounded-card bg-surface px-4 py-3 text-sm text-muted">帳號登入 · kling.ai/mcp</p>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-4 sm:p-5">
          <h2 className="font-display text-2xl text-fg">鏡頭單</h2>

          <div className="mt-4 grid gap-3">
            <div className="grid gap-3">
              <p className="text-sm leading-6 text-muted">
                會開一個新分頁到可靈登入。請用 kling.ai 國際站帳號（不是中國站 klingai.com）。登入完回到這個分頁即可。
              </p>
              {mcpReady ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-fg">{mcpAccount || "已連接可靈帳號"}</p>
                  <button
                    type="button"
                    onClick={() => {
                      saveMcpTokens(null);
                      setMcpReady(false);
                      setMcpAccount(null);
                      toolsRef.current = [];
                      modelsRef.current = [];
                      specRef.current = null;
                    }}
                    className="min-h-11 rounded-xl border border-line px-4 text-sm text-fg"
                  >
                    斷開
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void onConnect()}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brass px-4 text-sm font-semibold text-ink"
                >
                  {connecting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {connecting ? "正在等可靈登入…" : "連接可靈帳號"}
                </button>
              )}
              {loginUrl ? (
                <a href={loginUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-brass">
                  沒有跳出分頁的話，按這裡登入
                </a>
              ) : null}
              {connecting ? (
                <button
                  type="button"
                  onClick={() => {
                    setConnecting(false);
                    setPendingLogin(null);
                    setLoginUrl(null);
                  }}
                  className="min-h-11 justify-self-start rounded-xl border border-line px-4 text-sm text-fg"
                >
                  取消
                </button>
              ) : null}
              <a
                href="https://kling.ai/app/mcp"
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-1 text-sm text-brass"
              >
                可靈 MCP 說明
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="mt-5 flex rounded-card bg-bg p-1" role="group" aria-label="生成方式">
            {(
              [
                ["text", "文字生影片"],
                ["image", "圖片生影片"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={mode === id}
                onClick={() => setMode(id)}
                className={
                  mode === id
                    ? "min-h-11 flex-1 rounded-xl bg-raise text-sm font-semibold text-fg"
                    : "min-h-11 flex-1 rounded-xl text-sm text-muted"
                }
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4">
            <p className="mb-2 text-sm font-medium text-fg">模型</p>
            <div className="flex flex-wrap gap-2">
              {(settings.authKind === "legacy" ? LEGACY_MODELS : NEW_MODELS).map((item) => {
                const selected = model === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      settings.authKind === "legacy" ? patch({ modelLegacy: item.id }) : patch({ modelNew: item.id })
                    }
                    className={
                      selected
                        ? "min-h-11 rounded-xl border border-brass bg-raise px-4 text-sm font-semibold text-fg"
                        : "min-h-11 rounded-xl border border-line bg-bg px-4 text-sm text-fg"
                    }
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
            {modelNote ? <p className="mt-2 text-xs text-muted">{modelNote}</p> : null}
          </div>

          <label className="relative mt-4 block">
            <span className="mb-2 flex items-center justify-between text-sm font-medium text-fg">
              鏡頭描述
              <span className="font-normal text-muted">{prompt.trim().length}/2500</span>
            </span>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => {
                const next = event.target.value.slice(0, 2500);
                setPrompt(next);
                const found = omni && imageRole === "refer" ? mentionAt(next, event.target.selectionStart ?? next.length) : null;
                setMention(found);
                setMentionIndex(0);
              }}
              onClick={(event) => {
                const found =
                  omni && imageRole === "refer"
                    ? mentionAt(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)
                    : null;
                setMention(found);
              }}
              onKeyUp={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
                  const found =
                    omni && imageRole === "refer"
                      ? mentionAt(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)
                      : null;
                  setMention(found);
                }
              }}
              onKeyDown={(event) => {
                if (mention && omni && imageRole === "refer") {
                  const items = refs
                    .map((shot, index) => ({ shot, index, tag: `image_${index + 1}` }))
                    .filter((item) => !mention.query || item.tag.includes(mention.query));
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setMention(null);
                    return;
                  }
                  if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                    event.preventDefault();
                    setMentionIndex((current) =>
                      event.key === "ArrowDown" ? (current + 1) % items.length : (current + items.length - 1) % items.length,
                    );
                    return;
                  }
                  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    if (items.length) insertMention(items[Math.min(mentionIndex, items.length - 1)].index);
                    else setMention(null);
                    return;
                  }
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  if (!busy) void onGenerate();
                }
              }}
              rows={5}
              placeholder={omni && imageRole === "refer" ? "打 @ 選參考圖，例如 @image_1 走進雨裡" : "誰、在哪裡、做什麼、鏡頭怎麼動"}
              className="w-full resize-y rounded-xl border border-line bg-bg px-3 py-3 text-base leading-6 text-fg outline-none placeholder:text-muted focus-visible:border-brass"
            />
            {mention && omni && imageRole === "refer" ? (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
                {refs.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted">下面先加上參考圖，這裡才選得到。</p>
                ) : (
                  <ul className="max-h-64 overflow-y-auto p-1" role="listbox" aria-label="參考圖">
                    {refs
                      .map((shot, index) => ({ shot, index, tag: `image_${index + 1}` }))
                      .filter((item) => !mention.query || item.tag.includes(mention.query))
                      .map((item, listIndex) => (
                        <li key={item.shot.key} role="presentation">
                          <button
                            type="button"
                            role="option"
                            aria-selected={listIndex === mentionIndex}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              insertMention(item.index);
                            }}
                            className={
                              listIndex === mentionIndex
                                ? "flex min-h-11 w-full items-center gap-3 rounded-lg bg-raise px-2 py-1.5 text-left"
                                : "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left"
                            }
                          >
                            <img src={item.shot.preview} alt="" className="size-10 rounded-lg object-cover" />
                            <span className="text-sm font-medium text-fg">@{item.tag}</span>
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            ) : null}
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-full border border-line px-3 py-2 text-left text-xs leading-5 text-muted"
              >
                {example.slice(0, 18)}…
              </button>
            ))}
          </div>

          {mode === "image" ? (
            <div className="mt-4">
              {omni ? (
                <div className="mb-3 flex rounded-card bg-bg p-1" role="group" aria-label="圖片用途">
                  {(
                    [
                      ["first", "首幀"],
                      ["refer", "參考圖"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={imageRole === id}
                      onClick={() => setImageRole(id)}
                      className={
                        imageRole === id
                          ? "min-h-11 flex-1 rounded-xl bg-raise text-sm font-semibold text-fg"
                          : "min-h-11 flex-1 rounded-xl text-sm text-muted"
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mb-2 text-sm font-medium text-fg">第一幀</p>
              )}
              {omni && imageRole === "refer" ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {refs.map((shot, index) => (
                      <div key={shot.key} className="relative overflow-hidden rounded-xl border border-line bg-bg">
                        <img src={shot.preview} alt="" className="aspect-square w-full object-cover" />
                        <span className="absolute left-1.5 top-1.5 rounded-full bg-ink/80 px-2 py-0.5 text-xs text-fg">
                          @image_{index + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => setRefs((prev) => prev.filter((item) => item.key !== shot.key))}
                          className="absolute right-1.5 top-1.5 rounded-full bg-ink/80 px-2 py-0.5 text-xs text-fg"
                        >
                          移除
                        </button>
                      </div>
                    ))}
                    {refs.length < REF_LIMIT ? (
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          void onPickRefs([...event.dataTransfer.files]);
                        }}
                        className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line text-xs text-muted"
                      >
                        <ImagePlus className="size-5 text-brass" aria-hidden="true" />
                        加參考圖
                      </button>
                    ) : null}
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      void onPickRefs([...(event.target.files ?? [])]);
                      event.target.value = "";
                    }}
                  />
                  <p className="mt-2 text-xs leading-5 text-muted">
                    最多 7 張，不會當開頭。在上面的鏡頭描述打 @，就會跳出縮圖可選。沒寫到的會自動補上。
                  </p>
                </>
              ) : (
                <>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void onPickFile(event.dataTransfer.files[0]);
                }}
                className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-bg px-4 py-4 text-sm text-muted"
              >
                {preview ? (
                  <img src={preview} alt="即將送出的第一幀" className="max-h-40 rounded-lg object-contain" />
                ) : (
                  <>
                    <ImagePlus className="size-5 text-brass" aria-hidden="true" />
                    點選或拖入 jpg / png
                  </>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(event) => {
                  void onPickFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
                </>
              )}
              {imageError ? <p className="mt-2 text-sm text-brass">{imageError}</p> : null}
            </div>
          ) : null}

          {mode === "text" || omni ? (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium text-fg">畫幅</p>
              <div className="flex gap-2" role="group" aria-label="畫幅">
                {(
                  [
                    ["16:9", "橫"],
                    ["9:16", "直"],
                    ["1:1", "方"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={settings.aspect === id}
                    onClick={() => patch({ aspect: id })}
                    className={
                      settings.aspect === id
                        ? "min-h-11 flex-1 rounded-xl bg-raise text-sm font-semibold text-fg"
                        : "min-h-11 flex-1 rounded-xl border border-line text-sm text-muted"
                    }
                  >
                    {label}
                    <span className="ml-1 text-xs">{id}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 flex items-center justify-between text-sm font-medium text-fg">
                時長
                <span className="text-brass">{snapDuration(model, settings.authKind, settings.duration)} 秒</span>
              </p>
              {flexible ? (
                <input
                  type="range"
                  min={3}
                  max={15}
                  step={1}
                  value={snapDuration(model, settings.authKind, settings.duration)}
                  onChange={(event) => patch({ duration: Number(event.target.value) })}
                  className="w-full accent-brass"
                  aria-label="時長秒數"
                />
              ) : (
                <div className="flex gap-2">
                  {[5, 10].map((seconds) => (
                    <button
                      key={seconds}
                      type="button"
                      aria-pressed={settings.duration === seconds}
                      onClick={() => patch({ duration: seconds })}
                      className={
                        snapDuration(model, settings.authKind, settings.duration) === seconds
                          ? "min-h-11 flex-1 rounded-xl bg-raise text-sm font-semibold text-fg"
                          : "min-h-11 flex-1 rounded-xl border border-line text-sm text-muted"
                      }
                    >
                      {seconds} 秒
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-fg">
                {settings.authKind === "legacy" ? "品質" : "解析度"}
              </p>
              <div className="flex gap-2">
                {(
                  [
                    ["720p", settings.authKind === "legacy" ? "標準" : "720p"],
                    ["1080p", settings.authKind === "legacy" ? "專業" : "1080p"],
                    ...(omni ? ([["4k", "4K"]] as const) : []),
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={settings.resolution === id}
                    onClick={() => patch({ resolution: id })}
                    className={
                      resolution === id
                        ? "min-h-11 flex-1 rounded-xl bg-raise text-sm font-semibold text-fg"
                        : "min-h-11 flex-1 rounded-xl border border-line text-sm text-muted"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {formError ? (
            <p className="mt-4 flex items-start gap-2 text-sm text-brass">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {formError}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={busy}
            className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brass px-4 py-3 text-base font-semibold text-ink disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy ? "送出中…" : "生成短片"}
          </button>
          <p className="mt-3 text-xs leading-5 text-muted">
            {settings.authKind === "mcp"
              ? "扣的是可靈帳號點數。贈點目前不能用在 MCP。成片連結大約 24 小時後失效。"
              : "會直接扣你的可靈額度。720p、5 秒比較省。Ctrl 或 ⌘ + Enter 也能送出。成片連結大約 30 天後失效。"}
          </p>
        </section>

        <section className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-card border border-line bg-surface p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="font-display text-2xl text-fg">放映</h2>
              {focus ? (
                <span className="rounded-full bg-bg px-3 py-1 text-xs text-muted">
                  {statusLabel(focus.status)}
                </span>
              ) : null}
            </div>
            <div
              className={`mx-auto overflow-hidden rounded-xl border border-line bg-bg ${focus?.videoUrl ? `flex max-h-stage items-center justify-center ${aspectClass(frameAspect)}` : ""}`}
            >
              {focus?.videoUrl ? (
                <video
                  key={focus.videoUrl}
                  src={focus.videoUrl}
                  controls
                  playsInline
                  className="h-full w-full bg-bg object-contain"
                />
              ) : focus?.status === "failed" ? (
                <div className="px-4 py-4">
                  <p className="flex items-start gap-2 text-sm font-semibold text-brass">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    生成失敗，已停止
                  </p>
                  <p className="mt-2 text-sm leading-6 text-fg">{focus.message || "可靈沒有說明原因"}</p>
                </div>
              ) : focus?.status === "missing" ? (
                <div className="px-4 py-4">
                  <p className="flex items-start gap-2 text-sm font-semibold text-brass">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    可靈沒有這支片
                  </p>
                  <p className="mt-2 text-sm leading-6 text-fg">
                    有問到可靈，但回覆裡沒有這個任務。網站上看不到是對的，它並沒有在生成。
                  </p>
                  <p className="mt-2 break-all text-xs leading-5 text-muted">任務編號 {focus.id}</p>
                </div>
              ) : focus && !isTerminal(focus.status) ? (
                <div className="px-4 py-4">
                  <p className="text-sm text-fg">{statusLabel(focus.status)} · {waitedLabel(focus.createdAt, now)}</p>
                  <p className="mt-1 text-sm text-brass">{heardLabel(focus.checkedAt ?? null, now)}</p>
                  {late ? (
                    <p className="mt-3 flex items-start gap-2 text-sm leading-6 text-brass">
                      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      已超過 10 分鐘還沒完成。這不是失敗，只是可靈還沒回影片。請到官網看這支片，不要重送。
                    </p>
                  ) : deaf ? (
                    <p className="mt-3 flex items-start gap-2 text-sm leading-6 text-brass">
                      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      已經一陣子沒問到可靈，進度可能停了。
                    </p>
                  ) : typeof focus.progress === "number" ? (
                    <p className="mt-2 text-sm text-fg">可靈回報 {Math.round(focus.progress)}%</p>
                  ) : (
                    <p className="mt-2 text-xs leading-5 text-muted">可靈沒有百分比。這裡每 5 秒問一次，有錯誤會立刻停。</p>
                  )}
                  {focus.message ? (
                    <p className="mt-3 flex items-start gap-2 text-sm leading-6 text-brass">
                      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      {focus.message}
                    </p>
                  ) : null}
                  <a
                    href="https://kling.ai/app"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brass"
                  >
                    到可靈網站看作品
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                </div>
              ) : (
                <div className="px-6 py-10 text-center">
                  <p className="text-sm text-muted">寫一段鏡頭，按生成。片子會出現在這裡。</p>
                </div>
              )}
            </div>
            {focus ? (
              <div className="mt-4">
                <p className="text-sm leading-6 text-fg">{focus.prompt}</p>
                <p className="mt-1 text-xs text-muted">
                  {modelLabel(focus.model)} · {focus.duration} 秒 · {focus.region === "beijing" ? "北京" : "新加坡"}
                  {focus.message ? ` · ${focus.message}` : ""}
                </p>
                <p className="mt-1 break-all text-xs text-muted">任務編號 {focus.id}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {focus.videoUrl ? (
                    <a
                      href={focus.videoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brass px-4 text-sm font-semibold text-ink"
                    >
                      開新分頁下載
                      <ExternalLink className="size-4" aria-hidden="true" />
                    </a>
                  ) : null}
                  {focus.watermarkUrl ? (
                    <a
                      href={focus.watermarkUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center rounded-xl border border-line px-4 text-sm text-fg"
                    >
                      浮水印版
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-card border border-line bg-surface p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-fg">這台裝置上的片子</h2>
              {clips.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setClips([]);
                    setFocusId(null);
                  }}
                  className="inline-flex min-h-11 items-center gap-1 text-xs text-muted"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  清除列表
                </button>
              ) : (
                <span className="text-xs text-muted">還沒有紀錄</span>
              )}
            </div>
            <ul className="grid gap-2">
              {clips.map((clip) => (
                <li key={clip.id}>
                  <button
                    type="button"
                    onClick={() => setFocusId(clip.id)}
                    className={
                      focus?.id === clip.id
                        ? "flex w-full min-h-11 items-center justify-between gap-3 rounded-xl bg-raise px-3 py-2 text-left"
                        : "flex w-full min-h-11 items-center justify-between gap-3 rounded-xl px-3 py-2 text-left"
                    }
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-fg">{clip.prompt}</span>
                      <span className="block text-xs text-muted">
                        {new Date(clip.createdAt).toLocaleString("zh-TW", {
                          month: "numeric",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {" · "}
                        {modelLabel(clip.model)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-brass">{statusLabel(clip.status)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}
