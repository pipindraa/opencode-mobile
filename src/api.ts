/**
 * Клиент HTTP API OpenCode v2.
 * Аутентификация: HTTP Basic, логин "opencode", пароль сервера
 * (печатается при `opencode serve --hostname ... --port ...`).
 * client: @opencode/client/dist/chunks/shared-events-td2fzm91.js → Basic opencode:<password>
 */

import * as FileSystem from "expo-file-system/legacy";
import { EncodingType } from "expo-file-system/legacy";

export type Decision = "once" | "always" | "reject";

/** Какой сервер за API: OpenCode v2 или движок-форк Omnirush (мост на ноуте) */
export type ServerKind = "opencode" | "omnirush";

export interface ApiConfig {
  baseURL: string;
  password: string;
  /** по умолчанию "opencode" — обычный сервер OpenCode v2 */
  flavor?: ServerKind;
}

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// btoa в Hermes может отсутствовать — пишем свою base64 (utf8-safe)
function utf8(str: string): string {
  return str.replace(/[\u0080-\uffff]/g, (c) => {
    throw new Error("non-ascii password not supported");
  });
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) bytes.push(input.charCodeAt(i) & 0xff);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1] ?? 0;
    const b3 = bytes[i + 2] ?? 0;
    out += B64[b1 >> 2];
    out += B64[((b1 & 3) << 4) | (b2 >> 4)];
    out += i + 1 < bytes.length ? B64[((b2 & 15) << 2) | (b3 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[b3 & 63] : "=";
  }
  return out;
}

export function basicAuthHeader(password: string): string {
  return "Basic " + base64(utf8("opencode:" + password));
}

/** Вложение для промпта: картинка уже лежит в файловом API сервера — шлём ссылку */
export interface PromptFile {
  url: string;
  mime: string;
  filename: string;
}

export function extractList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (!data) return [];
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

/** Часть сообщения чата в нормализованном виде */
export type RenderPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string; state: string }
  | { kind: "raw"; label: string }
  /** вложение (картинка): url — если сервер даёт прямую ссылку, data — если это base64 */
  | { kind: "file"; label: string; mime: string; url?: string; data?: string };

export interface RenderMessage {
  /** id сообщения — нужен для отката (revert) */
  id?: string;
  role: string;
  parts: RenderPart[];
  time?: number;
}

/**
 * Вытаскивает сообщение из разных возможных форм записи
 * (прямое / обёрнутое в info / etc.)
 */
/** Служебные системные простыни (промпты, инструкция MCP) прячем */
function looksLikeInternalDump(text: string): boolean {
  if (text.startsWith("<system-reminder>") || text.startsWith("<system-update>")) return true;
  if (text.includes("<system-reminder>") && text.length > 2000) return true;
  if (text.includes("<server name=") && text.includes("tools[\"")) return true;
  if (text.startsWith("Instructions from:")) return true;
  if (text.includes("# codebase-memory-mcp:start") || text.includes("mcp_instructions")) return true;
  if (text.includes("# OmniRush session-quality")) return true;
  if (text.includes("<mcp_instructions>") || text.includes("EGULA OBLIGATORIA")) return true;
  return false;
}

/**
 * v2 формат: { id, type: "user"|"assistant"|..., time, content: [...],
 *  content-элементы: {type:"text",text} | {type:"tool",name,state:{status,input}} }
 */
export function parseMessage(raw: any): RenderMessage | null {
  const m = raw?.info ?? raw;
  const type: string = m?.type ?? m?.role ?? "unknown";

  // системные/synthetic/etc — не показываем, не наш чат
  if (type !== "user" && type !== "assistant") return null;

  // у форка текст может прийти строкой вместо массива частей
  const contentRaw: any = m?.content ?? m?.parts;
  const partsRaw: any[] = typeof contentRaw === "string" ? [{ type: "text", text: contentRaw }] : contentRaw ?? [];
  const parts: RenderPart[] = [];
  for (const p of partsRaw ?? []) {
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
      if (looksLikeInternalDump(p.text)) {
        parts.push({ kind: "raw", label: "⚙ служебный системный текст (скрыт)" });
        continue;
      }
      parts.push({ kind: "text", text: p.text });
    } else if (p?.type === "tool") {
      const tool = p?.tool ?? p?.name ?? "tool";
      const stateRaw = p?.state?.status ?? p?.toolStatus ?? "";
      let state = String(stateRaw);
      if (state.toLowerCase().startsWith("pending") || state === "") state = "running";
      parts.push({ kind: "tool", label: String(tool), state });
    } else if (p?.type === "file" || p?.type === "fileAttachment") {
      // вложение: у v2 файл описывается url/mime, у части сборок — base64 в .data
      const name = String(p?.filename ?? p?.name ?? p?.file ?? "файл");
      const mime = String(p?.mime ?? p?.mediaType ?? "application/octet-stream");
      const url = typeof p?.url === "string" ? p.url : undefined;
      const data = typeof p?.data === "string" ? p.data : undefined;
      if (url || data) parts.push({ kind: "file", label: name, mime, url, data });
      else parts.push({ kind: "raw", label: `📎 ${name}` });
    } else if (p?.type === "reasoning" && typeof p.text === "string" && p.text.trim()) {
      // мысли агента — короткий маркер, полный текст слишком шумный
      if (p.text.length > 120) {
        parts.push({ kind: "raw", label: "💭 размышлял" });
      } else {
        parts.push({ kind: "text", text: `💭 ${p.text}` });
      }
    }
  }
  // user: текст может лежать прямо в m.text
  if (parts.length === 0 && typeof m?.text === "string" && m.text) {
    if (looksLikeInternalDump(m.text)) {
      parts.push({ kind: "raw", label: "⚙ служебный текст (скрыт)" });
    } else {
      parts.push({ kind: "text", text: m.text });
    }
  }
  // v2: файлы сообщения лежат в m.files, в тексте на их месте — плейсхолдеры "[Image N]"
  const filesRaw: any[] = Array.isArray(m?.files) ? m.files : [];
  if (filesRaw.length > 0) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const pp = parts[i];
      if (pp.kind === "text") {
        const cleaned = pp.text.replace(/\[Image \d+\]\s*/g, "").trim();
        if (cleaned) parts[i] = { kind: "text", text: cleaned };
        else parts.splice(i, 1);
      }
    }
    for (const f of filesRaw) {
      const name = String(f?.name ?? f?.filename ?? "файл");
      const mime = String(f?.mime ?? f?.mediaType ?? "application/octet-stream");
      const url =
        typeof f?.url === "string" ? f.url : typeof f?.source?.uri === "string" ? f.source.uri : undefined;
      const data = typeof f?.data === "string" ? f.data : undefined;
      if (url || data) parts.push({ kind: "file", label: name, mime, url, data });
    }
  }
  if (parts.length === 0) return null;
  const t = m?.time?.created ?? m?.time?.start;
  return { id: m?.id ? String(m.id) : undefined, role: type, parts, time: typeof t === "number" ? t : undefined };
}

// функция скрытия служебных простыней (выше)
const MODEL_STATE_PATH = "C:/Users/kiril/.local/state/opencode/model.json";
const PHONE_MARKER = "C:/Users/kiril/.local/state/opencode/phone-prompt.marker";
/** куда складывать картинки с телефона, чтобы сервер мог их открыть */
const UPLOAD_DIR = "C:/Users/kiril/.local/state/opencode/uploads";
const OMNI_UPLOAD_DIR = "C:/Users/kiril/.local/state/opencode/uploads";

/** base64 → байты: atob в Hermes есть, но bytes нужны для бинарного тела */
function base64ToBytes(b64: string): number[] {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = B64.indexOf(clean[i]);
    const c2 = B64.indexOf(clean[i + 1]);
    const c3 = B64.indexOf(clean[i + 2]);
    const c4 = B64.indexOf(clean[i + 3]);
    out.push(((c1 << 2) | (c2 >> 4)) & 0xff);
    if (c3 >= 0) out.push(((c2 << 4) | (c3 >> 2)) & 0xff);
    if (c4 >= 0) out.push(((c3 << 6) | c4) & 0xff);
  }
  return out;
}
/** рабочая папка движка-моста Omnirush (куда создаются новые сессии без папки) */
const OMNI_HOME_DIR = "C:\\Users\\kiril";

class OpenCodeApi {
  cfg: ApiConfig;

  constructor(cfg: ApiConfig) {
    this.cfg = cfg;
    this.memoSessions = null;
    this.memoConfig = null;
  }

  /** кэш списка сессий: его читают при каждом рендере, а фетчить каждый раз накладно */
  private memoSessions: { at: number; data: { id: string; title: string; directory: string; timeCreated: number }[] } | null;
  /** кэш /config — у форка там модели и провайдеры */
  private memoConfig: { at: number; data: any } | null;

  /** true — этот клиент говорит с движком Omnirush (форк opencode v1.18.32) */
  get omni(): boolean {
    return this.cfg.flavor === "omnirush";
  }

  get base(): string {
    return this.cfg.baseURL.replace(/\/+$/, "");
  }

  private headers(json: boolean, octet = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: basicAuthHeader(this.cfg.password) };
    if (octet) h["Content-Type"] = "application/octet-stream";
    else if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async req<T = any>(
    path: string,
    init: { method?: string; json?: any; raw?: string } = {}
  ): Promise<T> {
    const { json, raw, method } = init;
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method: method ?? (json !== undefined || raw !== undefined ? "POST" : "GET"),
        headers: this.headers(json !== undefined, raw !== undefined),
        body: json !== undefined ? JSON.stringify(json) : raw,
      });
    } catch (e: any) {
      throw new ApiError(`Нет соединения с сервером: ${e?.message ?? e}`);
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        msg = j?.message ?? j?._tag ?? msg;
      } catch {
        /* no body */
      }
      throw new ApiError(msg, res.status);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    return data as T;
  }

  // ---- доменные методы ----

  info() {
    // у форка нет /api/info — /config всегда отвечает 200
    return this.req(this.omni ? "/config" : "/api/info");
  }

  /** список проектов (для выбора директории новой сессии). Путь в `canonical` */
  async projects(): Promise<{ directory: string; title: string }[]> {
    if (this.omni) {
      // у форка нет эндпоинта проектов — папки берём из существующих чатов + дом движка
      const sessions = await this.sessions();
      const dirs = [OMNI_HOME_DIR, ...sessions.map((x) => x.directory)];
      const seen = new Set<string>();
      const out: { directory: string; title: string }[] = [];
      for (const dir of dirs) {
        const d = String(dir ?? "").trim();
        if (!d || seen.has(d)) continue;
        seen.add(d);
        const title = d.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? d;
        out.push({ directory: d, title });
      }
      return out;
    }
    const data = await this.req("/api/project");
    const seen = new Set<string>();
    const out: { directory: string; title: string }[] = [];
    for (const p of extractList(data)) {
      const dir = String(p?.canonical ?? p?.directory ?? "").trim();
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      const title = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? dir;
      out.push({ directory: dir, title });
    }
    return out;
  }

  async sessions(): Promise<{ id: string; title: string; directory: string; timeCreated: number }[]> {
    const data = await this.req("/api/session");
    return extractList(data).map((s: any) => ({
      id: String(s?.id ?? s?.sessionID ?? ""),
      title: String(s?.title ?? s?.name ?? "без названия"),
      directory: String(s?.directory ?? s?.location?.directory ?? ""),
      timeCreated: Number(s?.time?.created ?? 0),
    }));
  }

  async sessionsActive(): Promise<string[]> {
    if (this.omni) {
      // форк: { sesId: { type: "busy" } }, пустой объект когда всё idle
      const data: any = await this.req("/session/status");
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return Object.keys(data);
      }
      return [];
    }
    // v2: {data: {ses_id: {type: "running"}}} — ОБЪЕКТ, не массив
    // (был баг: ждали массив → [] → busy=false → кнопка Стоп исчезала)
    const data: any = await this.req("/api/session/active");
    const map = data?.data ?? data;
    if (map && typeof map === "object" && !Array.isArray(map)) {
      return Object.keys(map);
    }
    return extractList(data)
      .map((s: any) => String(s?.id ?? s?.sessionID ?? ""))
      .filter(Boolean);
  }

  async createSession(directory: string): Promise<{ id: string }> {
    const res: any = await this.req("/api/session", {
      method: "POST",
      json: { location: { directory } },
    });
    const s = res?.data ?? res; // сервер оборачивает в {data}
    return { id: String(s?.id ?? s?.sessionID ?? "") };
  }

  async messages(sessionID: string, limit = 80): Promise<RenderMessage[]> {
    // форк: сообщения только через v1-путь; limit отдаёт ПОСЛЕДНИЕ N (формат {info,parts})
    const path = this.omni
      ? `/session/${sessionID}/message?limit=${limit}`
      : `/api/session/${sessionID}/message?limit=${limit}`;
    const data = await this.req(path);
    return extractList(data)
      .map(parseMessage)
      .filter((x: any): x is RenderMessage => !!x);
  }

  /**
   * Какие файлы агент тронул в этой сессии — из tool-частей транскрипта
   * (у edit/write read в state.metadata.files лежит путь). Пути уникальные,
   * order — время появления в чате.
   */
  async sessionFiles(sessionID: string, limit = 200): Promise<{ path: string; last: number }[]> {
    if (this.omni) return [];
    const data: any = await this.req(`/api/session/${sessionID}/message?limit=${limit}`);
    const msgs = extractList(data);
    const seen = new Map<string, number>();
    /** путь (абсолютный или относительный корню сервера) → время последнего касания */
    const addPath = (raw: any, ts: number) => {
      if (typeof raw === "string" && raw) seen.set(raw, Math.max(seen.get(raw) ?? 0, ts || 0));
    };
    for (const m of msgs) {
      const info = m?.info ?? m;
      const parts: any[] = Array.isArray(info?.parts) ? info.parts : Array.isArray(info?.content) ? info.content : [];
      const ts = Number(info?.time?.created ?? 0) || 0;
      for (const p of parts) {
        // edit: state.metadata.files — [{file, patch, status, additions, deletions}]
        const files = p?.state?.metadata?.files;
        if (Array.isArray(files)) {
          for (const f of files) addPath(typeof f?.file === "string" ? f.file : f?.path, ts);
        }
        // read / edit / write: state.input.path (в сборке 2.2.4 у write/read его в metadata нет)
        addPath(p?.state?.input?.path, ts);
      }
    }
    return [...seen.entries()]
      .map(([path, last]) => ({ path, last }))
      .sort((a, b) => b.last - a.last);
  }

  /** URL, по которому сервер отдаёт файл из своей файловой системы (для скачивания/превью) */
  fsReadURL(path: string): string {
    return `${this.base}/api/fs/read/${encodeURI(path)}`;
  }

  /** залить картинку на ноутбук и вернуть путь, который видит сервер */
  async uploadFile(uri: string, filename: string, mime: string): Promise<string> {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: EncodingType.Base64 });
    // сервер пишет файл к себе: file:// телефона ему недоступен
    const dir = this.omni ? OMNI_UPLOAD_DIR : UPLOAD_DIR;
    const path = `${dir}/${Date.now()}-${filename.replace(/[^\w.-]/g, "_")}`;
    const res = await fetch(`${this.base}/api/experimental/fs/write?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { ...this.headers(false, true) },
      body: new Uint8Array(base64ToBytes(b64)),
    } as any);
    if (!res.ok) throw new ApiError(`Не удалось загрузить файл: ${res.status}`, res.status);
    return path;
  }

  async prompt(sessionID: string, text: string, delivery?: "steer" | "queue", files?: PromptFile[]): Promise<void> {
    const fileParts = (files ?? []).map((f) => ({ type: "file" as const, mime: f.mime, filename: f.filename, url: f.url }));
    // форк: prompt_async c PromptInput {parts}; очередей/steer нет, маркер не нужен
    if (this.omni) {
      const parts: any[] = [];
      if (text) parts.push({ type: "text", text });
      parts.push(...fileParts);
      await this.req(`/session/${sessionID}/prompt_async`, { method: "POST", json: { parts } });
      return;
    }
    // маркер для рестартера на ноуте: "только что было сообщение с телефона"
    try {
      await this.req(`/api/experimental/fs/write?path=${encodeURIComponent(PHONE_MARKER)}`, {
        method: "POST",
        raw: String(Date.now()),
      });
    } catch {
      /* маркер — best effort */
    }
    // схема prompt (OpenAPI): text + files[{uri,name}]; поле parts сервер игнорирует
    const fileAtt = (files ?? []).map((f) => ({ uri: f.url, name: f.filename }));
    const body: Record<string, unknown> = { text };
    if (delivery) body.delivery = delivery;
    if (fileAtt.length > 0) body.files = fileAtt;
    await this.req(`/api/session/${sessionID}/prompt`, { method: "POST", json: body });
  }

  /** остановить текущий запрос агента (аналог Esc Esc в TUI) */
  async abort(sessionID: string): Promise<void> {
    // форк: /session/{id}/abort (проверено — 200); v2: /api/session/{id}/interrupt
    const path = this.omni ? `/session/${sessionID}/abort` : `/api/session/${sessionID}/interrupt`;
    await this.req(path, { method: "POST", json: {} });
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.abort(sessionID);
  }

  /** откатить чат до сообщения messageID (всё после него убирается из контекста) */
  async revert(sessionID: string, messageID: string): Promise<void> {
    // форк: один эндпоинт; v2: две ступени — stage, потом commit
    if (this.omni) {
      await this.req(`/session/${sessionID}/revert`, { method: "POST", json: { messageID } });
      return;
    }
    const stage = () =>
      this.req(`/api/session/${sessionID}/revert/stage`, { method: "POST", json: { messageID } });
    try {
      await stage();
    } catch (e: any) {
      // сессия занята агентом — останавливаем и повторяем один раз
      if (e instanceof ApiError && e.status === 409) {
        await this.abort(sessionID);
        await new Promise((r) => setTimeout(r, 1000));
        await stage();
      } else {
        throw e;
      }
    }
    await this.req(`/api/session/${sessionID}/revert/commit`, { method: "POST", json: {} });
  }

  /** отменить сделанный откат (кнопка «Вернуть») */
  async unrevert(sessionID: string): Promise<void> {
    const path = this.omni ? `/session/${sessionID}/unrevert` : `/api/session/${sessionID}/unrevert`;
    await this.req(path, { method: "POST", json: {} });
  }

  /** сведения о сессии для заголовка чата — без тяжёлых полей */
  async sessionTitle(sessionID: string): Promise<string> {
    const s = await this.sessionInfo(sessionID);
    return String(s?.title ?? s?.name ?? "");
  }

  /** инфо сессии: model, agent, cost, tokens */
  async sessionInfo(sessionID: string): Promise<any> {
    const res: any = await this.req(`/api/session/${sessionID}`);
    return res?.data ?? res;
  }

  /** доступные модели: {id, providerID, name, variants} */
  async models(): Promise<{ id: string; providerID: string; name: string; variants: string[] }[]> {
    if (this.omni) {
      // /api/model у форка не знает собственного провайдера — берём из /config
      const cfg: any = await this.req("/config");
      const models = cfg?.provider?.omnirush?.models ?? {};
      const out: { id: string; providerID: string; name: string; variants: string[] }[] = [];
      for (const [id, raw] of Object.entries(models)) {
        const m: any = raw ?? {};
        const variants =
          m.variants && typeof m.variants === "object" && !Array.isArray(m.variants)
            ? Object.entries(m.variants)
                .filter(([, v]) => !(v as any)?.disabled)
                .map(([k]) => k)
            : [];
        out.push({ id, providerID: "omnirush", name: String(m.name ?? id), variants });
      }
      return out;
    }
    const data = await this.req("/api/model");
    return extractList(data).map((m: any) => ({
      id: String(m?.modelID ?? m?.id ?? ""),
      providerID: String(m?.providerID ?? ""),
      name: String(m?.name ?? m?.modelID ?? "?"),
      variants: Array.isArray(m?.variants)
        ? m.variants.map((v: any) => String(v?.id ?? v)).filter(Boolean)
        : [],
    }));
  }

  /** агенты (внутренние — compaction/title — спрятаны) */
  async agents(): Promise<{ id: string; name: string }[]> {
    const data = await this.req("/api/agent");
    const inner = ["compaction", "title"];
    return extractList(data)
      .filter((a: any) => !inner.includes(String(a?.id)))
      .filter((a: any) => a?.hidden !== true) // у форка есть скрытые субагенты
      .map((a: any) => ({ id: String(a?.id), name: String(a?.name ?? a?.id) }));
  }

  async setSessionModel(
    sessionID: string,
    model: { id: string; providerID: string; variant?: string }
  ): Promise<void> {
    await this.req(`/api/session/${sessionID}/model`, { method: "POST", json: { model } });
  }

  async setSessionAgent(sessionID: string, agentID: string): Promise<void> {
    await this.req(`/api/session/${sessionID}/agent`, { method: "POST", json: { agent: agentID } });
  }

  /** что сейчас в контекстном окне сессии */
  async sessionContext(sessionID: string): Promise<any[]> {
    const data = await this.req(`/api/session/${sessionID}/context`);
    return extractList(data);
  }

  /** сжать контекст сессии */
  async compactSession(sessionID: string): Promise<void> {
    await this.req(`/api/session/${sessionID}/compact`, { method: "POST", json: {} });
  }

  /** ---- состояние моделей TUI (фэйвориты/recent/variant) ---- */

  async modelState(): Promise<any> {
    try {
      const data = await this.req(`/api/fs/read/${MODEL_STATE_PATH}`);
      if (typeof data === "string" && data.trim()) return JSON.parse(data);
      if (typeof data === "object") return data;
    } catch {
      /* файла может не быть */
    }
    return {};
  }

  async writeModelState(state: any): Promise<void> {
    await this.req(`/api/experimental/fs/write?path=${encodeURIComponent(MODEL_STATE_PATH)}`, {
      method: "POST",
      raw: JSON.stringify(state),
    });
  }

  /** ждёт, пока сессия уйдёт в idle (после промпта/одобрения); без таймаута */
  async waitIdle(sessionID: string): Promise<void> {
    await this.req(`/api/experimental/session/${sessionID}/wait`, { method: "POST" });
  }

  /** список любых ожидающих одобрений (на сервере) */
  async pendingPermissions(): Promise<{ sessionID: string; requestID: string; label: string }[]> {
    const data = await this.req("/api/permission/request");
    return extractList(data).map((p: any) => ({
      sessionID: String(p?.sessionID ?? p?.session ?? ""),
      requestID: String(p?.id ?? p?.requestID ?? ""),
      label: String(p?.type ?? p?.title ?? "разрешение"),
    }));
  }

  async replyPermission(sessionID: string, requestID: string, decision: Decision): Promise<void> {
    await this.req(`/api/session/${sessionID}/permission/${requestID}/reply`, {
      method: "POST",
      json: { decision },
    });
  }
}

export { OpenCodeApi };
