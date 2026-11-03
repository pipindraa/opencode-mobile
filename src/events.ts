/**
 * SSE-хаб событий OpenCode-сервера (/api/event).
 *
 * Почему не fetch: глобальный fetch в RN — полифил whatwg-fetch поверх XHR,
 * он буферизует ответ целиком (для живого потока бесполезен). XHR отдаёт
 * данные по кусочкам: readyState=3 (LOADING) + накопленный responseText.
 *
 * Поток ГЛОБАЛЬНЫЙ — события всех сессий, формат (подтверждено живым
 * сервером 2.2.4 и схемой в бинарнике):
 *
 *   data: {"id":"evt_…","type":"…","data":{…}}
 *
 *   : heartbeat
 *
 * Типа `event:` в потоке НЕТ — тип живёт внутри JSON (.type).
 *
 * Подтверждённые типы (live-сэмпл 240с + живая тест-сессия + бинарник 2.2.4):
 *   session.execution.started     {sessionID}                    → ЗАНЯТ
 *   session.execution.succeeded   {sessionID}                    → ГОТОВО
 *   session.execution.failed      {sessionID, error}             → ОШИБКА
 *   session.execution.interrupted {sessionID, reason}            → СТОП
 *   session.status                {sessionID, status:{type}}     (retry и т.п.)
 *   session.idle                  {sessionID}
 *   session.error                 {sessionID, …}
 *   session.updated / session.renamed {sessionID, title?}
 *   session.inbox.enqueued/delivered {sessionID, …}
 *   session.text.started {sessionID, assistantMessageID, ordinal}
 *   session.text.delta   {sessionID, assistantMessageID, ordinal, delta}
 *   session.text.ended   {sessionID, assistantMessageID, ordinal, text}
 *   session.reasoning.*  (там же)
 *   session.step.started/ended {sessionID, assistantMessageID, finish}
 *   session.tool.called  {sessionID, assistantMessageID, id, input}
 *   session.tool.success/error/progress
 *   session.usage.updated {sessionID, cost, tokens}
 *   message.updated / message.part.updated / message.removed / …
 *   permission.asked     {id, sessionID, action, resources[], message?, metadata?}
 *   permission.replied   {sessionID, requestID, reply}
 *   server.connected     {}
 */
import { basicAuthHeader } from "./api";

/** Разрешение, которое просит агент (payload permission.asked) */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  /** что хочет сделать: "edit", "bash", … */
  action: string;
  /** над чем: файлы/команды */
  resources: string[];
  message?: string;
  metadata?: Record<string, any>;
}

/** Нормализованные события для приложения */
export type BusEvent =
  | { kind: "connected" }
  | { kind: "disconnected" }
  /** агент начал/закончил работу (execution.started / succeeded / interrupted / status) */
  | { kind: "status"; sessionID: string; busy: boolean }
  /** завершение: success — «Готово», interrupted — «Стоп» (без точки-уведомления) */
  | { kind: "finished"; sessionID: string; outcome: "success" | "interrupted"; reason?: string }
  | { kind: "text-delta"; sessionID: string; messageID: string; ordinal: number; delta: string }
  | { kind: "text-ended"; sessionID: string; messageID: string; ordinal: number; text: string }
  | { kind: "tool"; sessionID: string; messageID: string; id: string; state: "running" | "completed" | "error"; input?: any }
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "permission-replied"; sessionID: string; requestID: string }
  | { kind: "error"; sessionID: string; message: string }
  | { kind: "renamed"; sessionID: string; title: string }
  /** сообщения/части изменились — запросить свежие (message.updated и всё такое) */
  | { kind: "messages-changed"; sessionID: string };

type Listener = (e: BusEvent) => void;

/** живём не дольше, чем сервер должен шлю heartbeat чаще, чем раз в 20с */
const HEARTBEAT_TIMEOUT_MS = 70_000;
const WATCHDOG_INTERVAL_MS = 20_000;
const MAX_RECONNECT_MS = 30_000;

class EventBus {
  private listeners = new Set<Listener>();
  private url = "";
  private auth = "";
  private running = false;
  private stopped = true;
  private xhr: XMLHttpRequest | null = null;
  private reconnectMs = 1000;
  private lastDataAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** последний сданный индекс responseText (XHR отдаёт накопленный текст) */
  private offset = 0;
  /** хвост кадра, не дошедший до "\n\n" */
  private buf = "";

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: BusEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* ошибка одного слушателя не валит остальных */
      }
    }
  }

  /** запустить хаб (идемпотентно); при смене сервера — заново с новым url/auth */
  start(url: string, auth: string): void {
    if (!this.stopped && url === this.url && auth === this.auth) return;
    this.stop();
    this.url = url;
    this.auth = auth;
    this.stopped = false;
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.xhr) {
      this.xhr.onload = null;
      this.xhr.onerror = null;
      this.xhr.onabort = null;
      this.xhr.onreadystatechange = null;
      try {
        this.xhr.abort();
      } catch {
        /* уже закрыт */
      }
      this.xhr = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private loop = (): void => {
    if (this.stopped) return;
    this.connect().catch(() => {
      /* reconnect below */
    }).finally(() => {
      if (this.stopped) return;
      const delay = this.reconnectMs;
      this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
      setTimeout(this.loop, delay);
    });
  };

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      this.offset = 0;
      this.buf = "";
      const xhr = new XMLHttpRequest();
      this.xhr = xhr;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (this.watchdog) {
          clearInterval(this.watchdog);
          this.watchdog = null;
        }
        if (this.xhr === xhr) this.xhr = null;
        if (ok) {
          this.reconnectMs = 1000;
          this.emit({ kind: "disconnected" });
        }
        resolve();
      };

      try {
        xhr.open("GET", this.url + "/api/event", true);
        xhr.setRequestHeader("Authorization", this.auth);
        xhr.setRequestHeader("Accept", "text/event-stream");
        xhr.responseType = "text";
      } catch {
        return resolve();
      }

      this.lastDataAt = Date.now();
      this.watchdog = setInterval(() => {
        // тишина дольше, чем два heartbeat'а — связь мертва, переподключаемся
        if (Date.now() - this.lastDataAt > HEARTBEAT_TIMEOUT_MS) {
          try {
            xhr.abort();
          } catch {
            /* ignore */
          }
        }
      }, WATCHDOG_INTERVAL_MS);

      // готовый кусок ответа: разбираем полные SSE-кадры (разделитель — пустая строка)
      const onData = (): void => {
        this.lastDataAt = Date.now();
        const text: string = xhr.responseText ?? "";
        if (text.length <= this.offset) return;
        const chunk = text.slice(this.offset);
        this.offset = text.length;
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf("\n\n")) >= 0) {
          const frame = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 2);
          this.handleFrame(frame);
        }
        // защита от разрастания, если сервер шлёт без пустых строк
        if (this.buf.length > 1_000_000) this.buf = "";
      };

      xhr.onreadystatechange = (): void => {
        if (xhr.readyState === 2 && xhr.status !== 200) {
          finish(false); // 401 и т.п. — не смыслит reconnect бесконечно быстро
          try {
            xhr.abort();
          } catch {
            /* ignore */
          }
          return;
        }
        if (xhr.readyState === 3 || xhr.readyState === 4) onData();
        if (xhr.readyState === 4) {
          // дожимаем хвост
          if (this.buf.trim()) {
            this.handleFrame(this.buf);
            this.buf = "";
          }
          finish(true); // сервер закрыл поток — reconnect
        }
      };
      xhr.onload = (): void => {
        onData();
        finish(true);
      };
      xhr.onerror = (): void => finish(false);
      xhr.onabort = (): void => finish(false);

      try {
        xhr.send();
      } catch {
        finish(false);
      }
    });
  }

  /** один SSE-кадр: строки "data: …" (heartbeat — ": …" — без data) */
  private handleFrame(frame: string): void {
    const dataParts: string[] = [];
    for (const line of frame.split("\n")) {
      const l = line.replace(/\r$/, "");
      if (l.startsWith("data:")) dataParts.push(l.slice(5).replace(/^ /, ""));
    }
    if (dataParts.length === 0) return; // heartbeat
    let evt: any;
    try {
      evt = JSON.parse(dataParts.join("\n"));
    } catch {
      return;
    }
    this.mapEvent(evt);
  }

  /** raw-событие сервера → нормализованное BusEvent (неизвестные типы игнорируем) */
  private mapEvent(evt: any): void {
    const t: string = evt?.type ?? "";
    const d: any = evt?.data ?? {};
    const sid: string = typeof d?.sessionID === "string" ? d.sessionID : "";
    switch (t) {
      case "server.connected":
        this.emit({ kind: "connected" });
        return;
      // — busy/idle: реальная пара сервера v2.2.4 (проверено живой сессией) —
      case "session.execution.started":
        if (sid) this.emit({ kind: "status", sessionID: sid, busy: true });
        return;
      case "session.execution.succeeded":
        if (sid) this.emit({ kind: "finished", sessionID: sid, outcome: "success" });
        return;
      case "session.execution.interrupted":
        if (sid)
          this.emit({
            kind: "finished",
            sessionID: sid,
            outcome: "interrupted",
            reason: typeof d?.reason === "string" ? d.reason : undefined,
          });
        return;
      case "session.execution.failed": {
        const msg =
          (d?.error?.message ? String(d.error.message) : undefined) ||
          (typeof d?.error === "string" ? d.error : undefined) ||
          "Ошибка агента";
        if (sid) {
          this.emit({ kind: "error", sessionID: sid, message: msg });
          this.emit({ kind: "finished", sessionID: sid, outcome: "interrupted", reason: "error" });
        }
        return;
      }
      // — дубль-источники (другие версии/сценарии: retry и т.п.) —
      case "session.status": {
        const st: any = d?.status ?? {};
        this.emit({ kind: "status", sessionID: sid, busy: st?.type === "busy" });
        return;
      }
      case "session.idle":
        if (sid) this.emit({ kind: "finished", sessionID: sid, outcome: "success" });
        return;
      case "session.text.delta":
        if (sid)
          this.emit({
            kind: "text-delta",
            sessionID: sid,
            messageID: String(d?.assistantMessageID ?? ""),
            ordinal: Number(d?.ordinal ?? 0) || 0,
            delta: typeof d?.delta === "string" ? d.delta : "",
          });
        return;
      case "session.text.ended":
        if (sid)
          this.emit({
            kind: "text-ended",
            sessionID: sid,
            messageID: String(d?.assistantMessageID ?? ""),
            ordinal: Number(d?.ordinal ?? 0) || 0,
            text: typeof d?.text === "string" ? d.text : "",
          });
        return;
      case "session.tool.called":
        if (sid)
          this.emit({
            kind: "tool",
            sessionID: sid,
            messageID: String(d?.assistantMessageID ?? ""),
            id: String(d?.id ?? ""),
            state: "running",
            input: d?.input,
          });
        return;
      case "session.tool.success":
        if (sid)
          this.emit({ kind: "tool", sessionID: sid, messageID: String(d?.assistantMessageID ?? ""), id: String(d?.id ?? ""), state: "completed" });
        return;
      case "session.tool.error":
        if (sid)
          this.emit({ kind: "tool", sessionID: sid, messageID: String(d?.assistantMessageID ?? ""), id: String(d?.id ?? ""), state: "error" });
        return;
      case "session.renamed":
        if (sid && typeof d?.title === "string" && d.title)
          this.emit({ kind: "renamed", sessionID: sid, title: d.title });
        return;
      case "permission.asked": {
        const req: PermissionRequest = {
          id: String(d?.id ?? d?.requestID ?? ""),
          sessionID: sid,
          action: String(d?.action ?? "разрешение"),
          resources: Array.isArray(d?.resources) ? d.resources.map(String) : [],
          message: typeof d?.message === "string" ? d.message : undefined,
          metadata: d?.metadata,
        };
        if (req.id) this.emit({ kind: "permission", request: req });
        return;
      }
      case "permission.replied":
        if (sid && d?.requestID) this.emit({ kind: "permission-replied", sessionID: sid, requestID: String(d.requestID) });
        return;
      case "session.error": {
        const msg =
          (typeof d?.error === "string" && d.error) ||
          (d?.error?.message ? String(d.error.message) : undefined) ||
          (typeof evt?.message === "string" && evt.message) ||
          "Ошибка агента";
        if (sid) this.emit({ kind: "error", sessionID: sid, message: msg });
        return;
      }
      // — транскрипт изменился (в т.ч. промпт, кинутый из TUI/CLI на ноуте) —
      case "message.updated":
      case "message.part.updated":
      case "message.part.delta":
      case "message.removed":
      case "message.part.removed":
      case "session.updated":
      case "session.synthetic":
      case "session.inbox.enqueued":
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        if (sid) this.emit({ kind: "messages-changed", sessionID: sid });
        return;
      default:
        return; // compaction/usage/step/reasoning/project — пока не нужны UI
    }
  }
}

/**
 * Глобальный хаб. Запускается в App (один раз на сервер),
 * экраны подписываются и фильтруют по своей sessionID.
 * Для режима Omnirush (форк v1) не запускается — там остаётся поллинг.
 */
export const events = new EventBus();

/** хелпер-подписка только по своей сессии (connected/disconnected проходят всем) */
export function subscribeSession(
  sessionID: string,
  fn: (e: BusEvent) => void
): () => void {
  return events.subscribe((e) => {
    if (e.kind === "connected" || e.kind === "disconnected") {
      fn(e);
      return;
    }
    const sid = (e as { sessionID?: string }).sessionID;
    const reqSid = e.kind === "permission" ? (e as { request: PermissionRequest }).request.sessionID : undefined;
    if (sid === sessionID || reqSid === sessionID) fn(e);
  });
}

export { basicAuthHeader };
