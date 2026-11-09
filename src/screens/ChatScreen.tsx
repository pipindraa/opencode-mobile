import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Modal,
  BackHandler,
  Image,
  PanResponder,
  Animated,
  Alert,
  Dimensions,
  Keyboard,
  KeyboardEvent,
  ScrollView,
  Platform,
  PermissionsAndroid,
  Linking,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths, Directory } from "expo-file-system";
import { voiceNative } from "../voice";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import Clipboard from "@react-native-clipboard/clipboard";
import { OpenCodeApi, RenderMessage, RenderPart, Decision, ServerKind, PromptFile, basicAuthHeader } from "../api";
import { subscribeSession, BusEvent, PermissionRequest } from "../events";
import { AsyncStorage } from "../store";
import { colors, spacing, fontSize } from "../theme";
import { Ionicons } from "@expo/vector-icons";

interface Props {
  api: OpenCodeApi;
  /** сервер OpenCode — фэйвориты моделей синкаются с TUI; Omnirush — только телефон */
  serverKind?: ServerKind;
  sessionID: string;
  directory: string;
  onBack: () => void;
  /** сервер на связи (пинг из App): false — баннер; при восстановлении — ресинк */
  conn?: boolean;
}

interface ChatBubble {
  key: string;
  /** id сообщения на сервере (для отката); у локального эха его нет */
  id?: string;
  role: string;
  parts: RenderPart[];
  /** время создания (для времени в пузыре, как в ТГ) */
  time?: number;
}

interface PermCard {
  requestID: string;
  label: string;
}

const POLL_MS = 1600;

/** быстрые фразы по умолчанию (общие для обоих серверов, редактируются в чате) */
const DEFAULT_PHRASES = ["что сделал", "продолжай", "проверь ошибки", "подведи итог"];

/** имя глифа Ionicons (для иконок, приходящих из данных: RenderPart.icon) */
type IconName = React.ComponentProps<typeof Ionicons>["name"];

/**
 * Формат activity-лейбла: "tool:label" / "typing:печатает ответ" /
 * "think:думает" / "perm:…". Вид определяет иконку в статус-баре;
 * сам текст показываем без эмодзи-префиксов.
 */
function parseActivity(a: string): { kind: "tool" | "typing" | "think" | "perm"; text: string } {
  if (a.startsWith("tool:")) return { kind: "tool", text: a.slice(5) };
  if (a.startsWith("typing:")) return { kind: "typing", text: a.slice(7) };
  if (a.startsWith("think:")) return { kind: "think", text: a.slice(6) };
  if (a.startsWith("perm:")) return { kind: "perm", text: a.slice(5) };
  return { kind: "think", text: a };
}

/** Код ошибки распознавателя → человекочитаемо (по SpeechRecognizer.ERROR_*) */
function voiceErrorText(e: string): string {
  const code = String(e).split("/")[0];
  const map: Record<string, string> = {
    "1": "ошибка аудио (микрофон)",
    "3": "внутренняя ошибка распознавания",
    "5": "нет разрешения на микрофон",
    "6": "нет сети — распознаванию нужен интернет",
    "7": "таймаут сети",
    "8": "не расслышал — попробуй ещё раз",
    "9": "распознаватель занят — попробуй ещё раз",
    "10": "ошибка сервера распознавания",
    "11": "молчание — ничего не распознал",
  };
  return map[code] ?? String(e);
}

/**
 * Непрерывная диктовка: пауза от последнего распознанного текста до этого
 * порога (мс) НЕ завершает диктовку — JS перезапускает нативную сессию.
 * Нативная тише-терпимость 3000мс (voice.ts); GRACE < 3000 → финальное
 * решение (текст в поле) — после ПЕРВОЙ «пустой» сессии, ~6с после слова.
 */
const VOICE_SILENCE_GRACE_MS = 2000;

type ModelRow = { id: string; providerID: string; name: string; variants: string[] };

/** кусок стримящегося ответа: текстовые блоки по ordinal + инструменты по id */
interface StreamMsg {
  texts: { [ordinal: string]: string };
  tools: { [id: string]: { label: string; state: string } };
}

/** название инструмента по форме input (в событии имени нет) */
function guessTool(input: any): string {
  if (!input || typeof input !== "object") return "инструмент";
  const k = Object.keys(input);
  if (k.includes("command")) return "shell";
  if (k.includes("path") && (k.includes("content") || k.includes("text"))) return "write file";
  if (k.includes("file_path") && k.includes("old_string")) return "edit";
  if (k.includes("oldString") && k.includes("newString")) return "edit";
  if (k.includes("pattern") || k.includes("glob") || k.includes("query")) return "search";
  if (k.includes("url")) return "fetch";
  if (k.includes("code")) return "execute";
  return "инструмент";
}

function fmtTok(n: any): string {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return Math.round(v / 1e3) + "k";
  return String(v);
}
function fmtCost(c: any): string {
  const v = Number(c) || 0;
  if (v === 0) return "0";
  return v >= 1 ? v.toFixed(2) : v.toFixed(3);
}

export default function ChatScreen({ api, serverKind = "opencode", sessionID, directory, onBack, conn }: Props) {
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [busy, setBusy] = useState(false);
  const [perms, setPerms] = useState<PermCard[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [sheet, setSheet] = useState<null | "model" | "agent" | "ctx" | "files">(null);
  const [mq, setMq] = useState("");
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [ctxCount, setCtxCount] = useState<number | null>(null);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  /** название чата из сессии — в заголовке вместо имени пользователя */
  const [sessionTitle, setSessionTitle] = useState("");
  /** когда агент начал текущий запрос (мс) — для таймера «работает 12с» */
  const [busySince, setBusySince] = useState<number | null>(null);
  /** что именно делает агент: думает / печатает / вызывает инструмент */
  const [activity, setActivity] = useState<string>("");
  /** «бегущие» точки в индикаторе */
  const [dots, setDots] = useState("");
  const busyRef = useRef(false);
  /** прикреплённые картинки, ещё не отправленные */
  const [attachments, setAttachments] = useState<{ uri: string; mime: string; filename: string }[]>([]);
  /** меню вложений: галерея / камера */
  const [attachMenu, setAttachMenu] = useState(false);
  /** живой стрим ответа: что прилетело по SSE, но ещё не в снимке сервера. key — messageID */
  const [stream, setStream] = useState<{ [messageID: string]: StreamMsg }>({});
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // — черновик: текст переживает выход из чата и перезапуск приложения —
  /** черновик ещё не восстановлен — до этого автосейв не трогает хранилище */
  const draftReady = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef(input);
  // — голосовой ввод: тап по микрофону → дикт → вставляется в поле, без авто-отправки —
  const [voiceOn, setVoiceOn] = useState(false);
  const [dictation, setDictation] = useState("");
  /** listening — ждём речь; processing — пользователь нажал стоп, готовим текст */
  const [voicePhase, setVoicePhase] = useState<"listening" | "processing">("listening");
  const dictRef = useRef("");
  // — быстрые фразы: чипы над полем ввода, тексты редактируются в модалке —
  const [phrases, setPhrases] = useState<string[]>([]);
  const [phraseEdit, setPhraseEdit] = useState(false);
  const [phraseDraft, setPhraseDraft] = useState("");
  // — файлы сессии (что агент изменил/создал) —
  const [files, setFiles] = useState<{ path: string; last: number }[] | null>(null);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  /** превью: data:URI материализуем во временный файл — Image в Modal из data:
   *  на Android капризничает, file:// — самый надёжный путь */
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number } | null>(null);
  // — «вниз»-кнопка: показывается, когда пролистали вверх от последних сообщений —
  const listRef = useRef<any>(null);
  const [away, setAway] = useState(false);
  const awayRef = useRef(false);
  const onListScroll = useCallback((e: any) => {
    // inverted-список: у «дна» (последние сообщения) contentOffset.y ≈ 0,
    // при пролистывании вверх |y| растёт (знак зависит от платформы)
    const isAway = Math.abs(e?.nativeEvent?.contentOffset?.y ?? 0) > 120;
    if (isAway !== awayRef.current) {
      awayRef.current = isAway;
      setAway(isAway);
    }
  }, []);
  const scrollToBottom = useCallback(() => {
    // inverted-список: «дно» (последние сообщения) — это offset 0.
    // scrollToEnd() тут ненадёжен (конец диапазона ≠ визуальный низ),
    // а offset 0 верен в обеих системах знаков.
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const modelKey = (m: ModelRow) => `${m.providerID}/${m.id}`;

  // при старте склеиваем локальные фэйвориты с тем, что на ПК (TUI хранит в model.json);
  // у Omnirush серверного стейта нет — фэйвориты живут только на телефоне
  useEffect(() => {
    (async () => {
      const device = await AsyncStorage.getFavorites().catch(() => [] as string[]);
      if (serverKind === "omnirush") {
        setFavs(new Set(device));
        return;
      }
      const st = await api.modelState().catch(() => ({}) as any);
      const fromServer = Array.isArray(st?.favorite)
        ? st.favorite.map((x: any) => `${x?.providerID}/${x?.modelID}`).filter((k: string) => k && k !== "/")
        : [];
      setFavs(new Set([...device, ...fromServer]));
    })();
  }, [api, serverKind]);

  // — черновик: текст переживает выход из чата и перезапуск приложения —
  // восстановление при открытии сессии
  useEffect(() => {
    let alive = true;
    AsyncStorage.getDraft(serverKind, sessionID)
      .then((d) => {
        if (!alive) return;
        if (d) setInput(d);
        draftReady.current = true;
      })
      .catch(() => {
        draftReady.current = true; // ошибка хранилища — не блокируем ввод
      });
    return () => {
      alive = false;
    };
  }, [serverKind, sessionID]);

  // автосохранение с дебаунсом: непустой текст — сохранить, пустой — удалить черновик
  useEffect(() => {
    inputRef.current = input;
    if (!draftReady.current) return; // ещё не восстановили — не затираем хранилище
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      AsyncStorage.saveDraft(serverKind, sessionID, input);
    }, 400);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [input, serverKind, sessionID]);

  // при выходе из чата — сохранить актуальный текст (дебаунс мог не сработать)
  useEffect(() => {
    return () => {
      if (draftReady.current) AsyncStorage.saveDraft(serverKind, sessionID, inputRef.current);
    };
  }, [serverKind, sessionID]);

  // — быстрые фразы: загрузка, вставка в поле, сохранение редактора —
  useEffect(() => {
    AsyncStorage.getQuickPhrases().then((p) => setPhrases(p.length > 0 ? p : DEFAULT_PHRASES));
  }, []);

  const applyPhrase = (p: string) => {
    setInput((prev) => (prev.trim() ? prev.trimEnd() + " " + p : p));
  };

  const savePhrases = async () => {
    const list = phraseDraft
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 12);
    setPhrases(list);
    setPhraseEdit(false);
    try {
      await AsyncStorage.saveQuickPhrases(list);
    } catch {
      /* ignore */
    }
  };

  const toggleFav = async (m: ModelRow) => {
    const k = modelKey(m);
    const next = new Set(favs);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setFavs(next);
    try {
      await AsyncStorage.saveFavorites([...next]);
    } catch {
      /* ignore */
    }
    // синхронизация с ПК: перечитали state TUI, применили дельту, записали обратно
    if (serverKind === "omnirush") return;
    try {
      const st = await api.modelState();
      const fav = Array.isArray(st?.favorite) ? st.favorite.slice() : [];
      const [p, mid] = k.split("/");
      const idx = fav.findIndex((x: any) => String(x?.providerID) === p && String(x?.modelID) === mid);
      if (next.has(k) && idx < 0) fav.unshift({ providerID: p, modelID: mid });
      if (!next.has(k) && idx >= 0) fav.splice(idx, 1);
      if (idx < 0 || fav.length !== st?.favorite?.length) {
        st.favorite = fav;
        await api.writeModelState(st);
      }
    } catch {
      /* сервер недоступен — телефонный Set уже сохранён */
    }
  };

  const loadModels = async () => {
    try {
      setModels(await api.models());
    } catch {
      /* ignore */
    }
  };
  const loadAgents = async () => {
    try {
      setAgents(await api.agents());
    } catch {
      /* ignore */
    }
  };
  const loadContext = async () => {
    try {
      const ctx = await api.sessionContext(sessionID);
      setCtxCount(ctx.length);
    } catch {
      /* ignore */
    }
  };

  const applyModel = async (model: { id: string; providerID: string; variant?: string }) => {
    try {
      await api.setSessionModel(sessionID, model);
      setSheet(null);
      setExpandedModel(null);
      pollState();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };
  const pressModelRow = (m: ModelRow) => {
    const k = modelKey(m);
    if (m.variants.length > 0 && expandedModel !== k) setExpandedModel(k);
    else applyModel({ id: m.id, providerID: m.providerID });
  };

  // строки листа моделей: заголовки провайдеров + favorites-секция
  const modelRows = (() => {
    const q = mq.trim().toLowerCase();
    const filtered = models.filter((m) => (m.name + " " + m.providerID).toLowerCase().includes(q));
    const favMore = filtered.filter((m) => favs.has(modelKey(m)));
    const byProvider = new Map<string, ModelRow[]>();
    for (const m of filtered) {
      const arr = byProvider.get(m.providerID) ?? [];
      arr.push(m);
      byProvider.set(m.providerID, arr);
    }
    const rows: ({ kind: "hdr"; label: string; fav?: boolean } | { kind: "mdl"; m: ModelRow })[] = [];
    if (favMore.length > 0) {
      rows.push({ kind: "hdr", label: "Избранное", fav: true });
      for (const m of favMore) rows.push({ kind: "mdl", m });
    }
    const provs = [...byProvider.keys()].sort((a, b) => a.localeCompare(b));
    for (const p of provs) {
      rows.push({ kind: "hdr", label: p });
      const arr = (byProvider.get(p) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      for (const m of arr) rows.push({ kind: "mdl", m });
    }
    return rows;
  })();
  const applyAgent = async (agentID: string) => {
    try {
      await api.setSessionAgent(sessionID, agentID);
      setSheet(null);
      pollState();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };
  const doCompact = async () => {
    try {
      setSheet(null);
      await api.compactSession(sessionID);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const loadMessages = useCallback(async () => {
    try {
      const msgs: RenderMessage[] = await api.messages(sessionID);
      // сервер может вернуть любой порядок — сортируем по времени
      msgs.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      const list: ChatBubble[] = msgs.map((m, i) => {
        const role = String(m.role).toLowerCase();
        // у форка бывают сообщения без parts (служебные/удалённые) — не роняем рендер
        return {
          key: `m${m.time ?? i}-${role}-${i}`,
          id: m.id,
          role,
          parts: Array.isArray(m.parts) ? m.parts : [],
          time: m.time,
        };
      });
      // дедупликация локального эха: текст уже пришёл с сервера → убираем
      const serverTexts = new Set(
        list
          .filter((b) => b.role === "user")
          .map((b) => b.parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n"))
      );
      const bubbleText = (b?: ChatBubble) =>
        (b?.parts ?? []).map((p) => (p.kind === "text" ? p.text : p.label)).join("\u0001");
      setBubbles((prev) => {
        const locals = prev.filter((b) => b.key.startsWith("local-"));
        const leftover = locals.filter((b) => {
          const txt = b.parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
          const old = Date.now() - Number(b.key.slice(6)) > 30000;
          return !serverTexts.has(txt) && !old;
        });
        const final = [...list, ...leftover];
        // без изменений — не ререндерим (иначе список дёргается каждые 1.6с)
        // пустой чат: prev[prev.length-1] === undefined — обращаться к .parts нельзя
        const lastSame =
          final.length === 0 || bubbleText(prev[prev.length - 1]) === bubbleText(final[final.length - 1]);
        if (prev.length === final.length && prev.every((b, i) => b.key === final[i].key) && lastSame) {
          return prev;
        }
        return final;
      });
      // показываем, что агент делает прямо сейчас (как строка «чатает…» в мессенджерах)
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last && last.role === "assistant") {
        const running = last.parts.find((p: any) => p.kind === "tool" && p.state === "running");
        const hasText = last.parts.some((p: any) => p.kind === "text" && p.text.trim().length > 0);
        if (running) setActivity(`tool:${(running as any).label}`);
        else if (hasText) setActivity("typing:печатает ответ");
        else setActivity("think:думает");
      } else {
        setActivity("");
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [api, sessionID]);


  /** отложенная синхронизация с сервером (дженгл из событий: много событий за раз — один запрос) */
  const scheduleSync = useCallback(
    (ms: number) => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => {
        loadMessages();
      }, ms);
    },
    [loadMessages]
  );

  const pollState = useCallback(async () => {
    try {
      const [active, pending, sess] = await Promise.all([
        api.sessionsActive().catch(() => [] as string[]),
        api.pendingPermissions().catch(() => [] as any[]),
        api.sessionInfo(sessionID).catch(() => null),
      ]);
      if (sess) {
        setInfo(sess);
        if (sess.title) setSessionTitle(String(sess.title));
      }
      const isActive = active.includes(sessionID);
      busyRef.current = isActive;
      setBusy(isActive);
      // старт таймера — в момент, когда агент стал занятым
      setBusySince((prev) => (isActive ? prev ?? Date.now() : null));
      const mine = pending.filter((p) => p.sessionID === sessionID && p.requestID);
      setPerms(mine);
    } catch {
      /* тихо, ошибка сети отобразится при следующем цикле */
    }
  }, [api, sessionID]);

  useEffect(() => {
    loadMessages();
    pollState();
    // поллинг — только страховка (быстрые изменения приходят по SSE-событиям):
    // занят/разрешения/инфо раз в 5с, транскрипт — раз в 30с на случай пропущенных событий
    const t = setInterval(() => {
      pollState();
    }, 5000);
    const t2 = setInterval(() => {
      loadMessages();
    }, 30000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, [loadMessages, pollState]);

  // связь пропала → вернулась: ресинк (пока оффлайн могли уйти события/сообщения)
  const prevConnRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = conn;
    if (prev === false && conn === true) {
      loadMessages();
      pollState();
    }
  }, [conn, loadMessages, pollState]);

  // живой стрим (SSE): текст по мере генерации, busy/perm/error/renamed — мгновенно
  useEffect(() => {
    if (serverKind === "omnirush") return; // у форка нет /api/event — остаётся поллинг
    const off = subscribeSession(sessionID, (e: BusEvent) => {
      switch (e.kind) {
        case "connected":
          // после (пере)подключения — догоняемся: могли пропустить события
          loadMessages();
          pollState();
          break;
        case "status":
          busyRef.current = e.busy;
          setBusy(e.busy);
          setBusySince((prev) => (e.busy ? prev ?? Date.now() : null));
          if (!e.busy) {
            setActivity("");
            setStream({});
          }
          break;
        case "finished":
          busyRef.current = false;
          setBusy(false);
          setBusySince(null);
          setActivity("");
          setStream({});
          scheduleSync(300); // финальный снимок: завершённое сообщение берём с сервера
          break;
        case "text-delta": {
          if (!e.messageID) break;
          setStream((prev) => {
            const cur = prev[e.messageID] ?? { texts: {}, tools: {} };
            const ord = String(e.ordinal);
            return {
              ...prev,
              [e.messageID]: { ...cur, texts: { ...cur.texts, [ord]: (cur.texts[ord] ?? "") + e.delta } },
            };
          });
          setActivity("typing:печатает ответ");
          break;
        }
        case "text-ended":
          scheduleSync(250);
          break;
        case "tool": {
          if (!e.messageID) break;
          setStream((prev) => {
            const cur = prev[e.messageID] ?? { texts: {}, tools: {} };
            if (e.state === "running") {
              return {
                ...prev,
                [e.messageID]: {
                  ...cur,
                  tools: { ...cur.tools, [e.id]: { label: guessTool(e.input), state: "running" } },
                },
              };
            }
            const ex = cur.tools[e.id];
            if (!ex) return prev; // called не видели (чат открылся позже) — не додумываем
            return {
              ...prev,
              [e.messageID]: { ...cur, tools: { ...cur.tools, [e.id]: { ...ex, state: e.state } } },
            };
          });
          if (e.state === "running") setActivity(`tool:${guessTool(e.input)}`);
          break;
        }
        case "permission": {
          const r: PermissionRequest = e.request;
          const res = r.resources && r.resources[0] ? " " + r.resources[0].slice(0, 60) : "";
          setPerms((prev) =>
            prev.some((p) => p.requestID === r.id)
              ? prev
              : [...prev, { requestID: r.id, label: `${r.action}${res}` }]
          );
          break;
        }
        case "permission-replied":
          setPerms((prev) => prev.filter((p) => p.requestID !== e.requestID));
          break;
        case "error":
          setError(e.message);
          break;
        case "renamed":
          setSessionTitle(e.title);
          break;
        case "messages-changed":
          scheduleSync(300);
          break;
        default:
          break;
      }
    });
    return () => {
      off();
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, [sessionID, serverKind, loadMessages, pollState, scheduleSync]);

  // «бегущие» точки индикатора: обновляем строку раз в 500 мс, только пока агент занят
  useEffect(() => {
    if (!busy && !sending) {
      setDots("");
      return;
    }    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % 4;
      setDots(".".repeat(i));
    }, 500);
    return () => clearInterval(t);
  }, [busy, sending]);

  // экран не гаснет, пока агент работает (автоматически, без тумблера)
  useEffect(() => {
    if (busy || sending) activateKeepAwakeAsync().catch(() => {});
    else deactivateKeepAwake().catch(() => {});
    return () => {
      deactivateKeepAwake().catch(() => {});
    };
  }, [busy, sending]);

  // клавиатура: с Android 15 (targetSdk 36 + edge-to-edge) adjustResize игнорируется,
  // поэтому высоту берём из события и поднимаем панель ввода сами.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e: KeyboardEvent) =>
      setKbHeight(e.endCoordinates.height)
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // свайп от левого края вправо — назад к списку чатов
  const screenW = Dimensions.get("window").width;
  const panX = useRef(new Animated.Value(0)).current;
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => {
        if (g.dx > 0) panX.setValue(Math.min(g.dx, screenW));
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dx > screenW * 0.3 || g.vx > 0.8) {
          Animated.timing(panX, { toValue: screenW, duration: 160, useNativeDriver: true }).start(() => {
            onBack();
          });
        } else {
          Animated.spring(panX, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  // автоскролл не нужен: список инвертирован, низ списка всегда на экране

  // Android "назад" — выход из чата на список сессий
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const send = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending) return;
    const sentFiles = attachments; // захват для восстановления при ошибке
    setInput("");
    setError(null);
    setSending(true); // сразу блокируем повторную отправку (и во время загрузки файла)
    // мгновенно показать своё сообщение (не ждём сервер)
    const shown: RenderPart[] = [];
    if (text) shown.push({ kind: "text", text });
    for (const a of sentFiles) shown.push({ kind: "file", label: a.filename, mime: a.mime, url: a.uri });
    setBubbles((prev) => [...prev, { key: `local-${Date.now()}`, role: "user", parts: shown }]);
    // чип убирается сразу — фото уже в чате, а не «лежит на следующее сообщение»
    setAttachments([]);
    const files: PromptFile[] = [];
    try {
      for (const a of sentFiles) {
        // сервер на ноуте не видит file:// телефона — сначала заливаем файл
        const remote = await api.uploadFile(a.uri, a.filename, a.mime);
        files.push({ url: `file:///${remote}`, mime: a.mime, filename: a.filename });
      }
      // если агент чем-то занят — встанет в очередь (OpenCode delivery)
      await api.prompt(sessionID, text, busyRef.current ? "queue" : undefined, files.length > 0 ? files : undefined);
      await pollState();
      loadMessages();
    } catch (e: any) {
      // «Нет соединения» не вываливаем куском — дружелюбно в error-строку
      const msg = e?.message ?? String(e);
      setError(msg.startsWith("Нет соединения") ? "Нет соединения с сервером — попробуй ещё раз" : msg);
      setInput(text); // вернуть текст, чтобы не потерять
      if (sentFiles.length > 0) setAttachments(sentFiles); // вернуть фото — отправить заново
    } finally {
      setSending(false);
    }
  };

  /** выбор фото из галереи; камеру подключаем отдельной кнопкой */
  const pickImage = async (fromCamera: boolean) => {
    setError(null);
    try {
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError("Нет доступа к " + (fromCamera ? "камере" : "галерее") + " — разреши в настройках Android");
        return;
      }
      const res = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: false })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            quality: 0.7,
            base64: false,
            allowsMultipleSelection: false,
          });
      if (res.canceled || !res.assets || res.assets.length === 0) return;
      const a = res.assets[0];
      setAttachments((prev) => [
        ...prev,
        {
          uri: a.uri,
          mime: a.mimeType ?? "image/jpeg",
          filename: a.fileName ?? `photo-${Date.now()}.jpg`,
        },
      ]);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  /** выбор файла любой природы (документы, архивы, код…): системный пикер документов */
  const pickDocument = async () => {
    setError(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: "*/*",
      });
      if (res.canceled || !res.assets || res.assets.length === 0) return;
      const a = res.assets[0];
      setAttachments((prev) => [
        ...prev,
        {
          uri: a.uri,
          mime: a.mimeType ?? "application/octet-stream",
          filename: a.name ?? `file-${Date.now()}`,
        },
      ]);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  /** откат: убрать из контекста всё, начиная с выбранного сообщения */
  const revertNow = async (b: ChatBubble) => {
    try {
      await api.revert(sessionID, b.id as string);
      await loadMessages();
      await pollState();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };
  const doRevert = (b: ChatBubble) => {
    if (!b.id) return;
    Alert.alert("Откатить чат?", "Все сообщения начиная с этого уйдут из контекста.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Откатить",
        style: "destructive",
        onPress: () => revertNow(b),
      },
    ]);
  };

  /** копировать весь текст пузыря */
  const [copied, setCopied] = useState(false);
  const copyBubble = (b: ChatBubble) => {
    const txt = b.parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("\n\n")
      .trim();
    if (!txt) return;
    Clipboard.setString(txt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /** тап по блоку кода — копировать код */
  const copyCode = (code: string) => {
    if (!code) return;
    Clipboard.setString(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /**
   * Меню сообщения — кнопка «…» рядом с пузырём. Долгое нажатие на пузырь —
   * копировать всё сообщение (нативное выделение отключено — оно мешало).
   */
  const [menuBubble, setMenuBubble] = useState<ChatBubble | null>(null);
  const openMenu = (b: ChatBubble) => setMenuBubble(b);
  const closeMenu = () => setMenuBubble(null);
  const hasText = (b: ChatBubble) => b.parts.some((p) => p.kind === "text" && (p as any).text.trim());

  const decide = async (requestID: string, decision: Decision) => {
    setPerms((prev) => prev.filter((p) => p.requestID !== requestID));
    try {
      await api.replyPermission(sessionID, requestID, decision);
      busyRef.current = true;
      setBusy(true);
      await pollState();
      loadMessages();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const stop = async () => {
    try {
      await api.abort(sessionID);
      setBusy(false);
      busyRef.current = false;
      setBusySince(null);
      loadMessages();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  // ————————————————— голосовой ввод (непрерывный) —————————————————
  // тап по микрофону → диктуем → текст копится и вставляется в поле (без авто-отправки).
  // Паузы НЕ убивают диктовку: нативная сессия кончается на тише 3с
  // (voice.ts), JS добирает её результат, добавляет в накопленное и
  // перезапускает сессию. Текст в поле — на ~6с после последнего слова,
  // раньше — только по ⏹ (второй тап) или по реальной ошибке.
  // RN 0.88 bridgeless: события модуля не доходят, JS опрашивает
  // isRecognizing() + getSpeechResults(). Все нативные вызовы обёрнуты
  // таймаутами (voice.ts) + watchdog — диктовка не зависнет «намертво».
  const stoppingRef = useRef(false);
  const voiceStartRef = useRef(0);

  const toggleVoice = async () => {
    if (voiceOn) {
      stoppingRef.current = true;
      setVoicePhase("processing");
      voiceNative.stop();
      return;
    }
    if (!voiceNative.available()) {
      setError("Голос: модуль недоступен в этой сборке");
      return;
    }
    setError(null);
    if (Platform.OS === "android") {
      try {
        const st = await PermissionsAndroid.request("android.permission.RECORD_AUDIO");
        if (st !== "granted") {
          setError("Нет доступа к микрофону — разреши в настройках Android");
          return;
        }
      } catch (e: any) {
        setError("Микрофон недоступен: " + (e?.message ?? e));
        return;
      }
    }
    stoppingRef.current = false;
    try {
      dictRef.current = "";
      setDictation("");
      setVoicePhase("listening");
      voiceStartRef.current = Date.now();
      console.log("[voice] start " + new Date().toISOString());
      await voiceNative.start("ru-RU");
      setVoiceOn(true);
    } catch (e: any) {
      console.log("[voice] start failed: " + (e?.message ?? e));
      setError("Микрофон не запустился: " + (e?.message ?? e));
    }
  };

  useEffect(() => {
    if (!voiceOn) return;
    let finished = false;
    let busy = false; // onSessionEnd крутится — не входить повторно
    let collectTimer: ReturnType<typeof setTimeout> | null = null;
    let accum = ""; // распознанное по сессиям (нативка сбрасывает его при рестарте)
    let lastTextAt = 0; // когда пришёл последний реальный текст
    let lastStartAt = Date.now(); // старт (ре)сессии — grace-окно
    let emptyStreak = 0; // пустых сессий подряд (страховка от зацикливания)

    // "No match" (пустой результат) и "No speech input" (молчание) — это не
    // ошибка, а тишина: сессию перезапускаем или спокойно завершаем.
    const isSilenceError = (e: string) =>
      e.includes("No match") || e.includes("No speech input");

    /**
     * Финал: накопленный accum → в поле, натив глушим, состояние сбрасываем.
     */
    const finishVoice = (error: string) => {
      if (finished) return;
      finished = true;
      if (collectTimer) clearTimeout(collectTimer);
      const t = accum.trim();
      voiceNative.stop();
      setVoiceOn(false);
      setVoicePhase("listening");
      setDictation("");
      dictRef.current = "";
      console.log("[voice] finish: textLen=" + t.length + " error=" + (error || "<нет>") + " manual=" + stoppingRef.current);
      if (t) {
        setInput((prev) => (prev ? prev.trimEnd() + " " + t : t));
      } else if (error === "watchdog") {
        setError("Голос: зависло — попробуй ещё раз");
      } else if (error) {
        setError("Голос: " + voiceErrorText(error));
      } else {
        setError("Голос: не распознал — попробуй ещё раз");
      }
    };

    /**
     * Нативная сессия закончилась (тишина / ручной стоп / ошибка).
     * onResults приходит ~80мс ПОСЛЕ onEndOfSpeech — опрашиваем до 2.5с,
     * докидываем текст в accum и решаем: рестарт сессии (диктовка идёт
     * дальше) или финал.
     */
    const onSessionEnd = () => {
      if (finished || busy) return;
      busy = true;
      let waited = 0;
      const decide = () => {
        voiceStartRef.current = Date.now(); // watchdog: была активность
        if (stoppingRef.current) return finishVoice("");
        // пауза короче грейса → диктовка продолжается: перезапускаем сессию
        if (Date.now() - lastTextAt <= VOICE_SILENCE_GRACE_MS && emptyStreak < 3) {
          emptyStreak++;
          busy = false;
          lastStartAt = Date.now();
          console.log("[voice] авто-рестарт (пауза, продолжаем)");
          voiceNative
            .start("ru-RU")
            .then(() => console.log("[voice] авто-рестарт ок"))
            .catch((e: any) => {
              // если за время сбоев подтянулась новая сессия — не убиваем её
              voiceNative.isRecognizing().then((r) => {
                if (r) return;
                console.log("[voice] авто-рестарт не удался: " + (e?.message ?? e));
                finishVoice(e?.message ?? String(e));
              });
            });
          return;
        }
        return finishVoice("");
      };
      const collect = async () => {
        if (finished) return;
        const { text, error } = await voiceNative.getSpeechResults();
        if (finished) return;
        const t = text.trim();
        if (t) {
          accum = accum ? accum + " " + t : t;
          lastTextAt = Date.now();
          emptyStreak = 0;
          console.log("[voice] сессия +" + t.length + " симв., accum=" + accum.length);
        }
        const err = error || "";
        const realError = err !== "" && !isSilenceError(err);
        // сессия точно закончилась без текста (ошибка тишины уже стоит) —
        // ждать дольше бессмысленно
        const silenceDone = t === "" && err !== "" && isSilenceError(err);
        if (t || realError || silenceDone || waited >= 2500) {
          if (realError) return finishVoice(err);
          return decide();
        }
        waited += 300;
        collectTimer = setTimeout(collect, 300);
      };
      collect();
    };

    const tick = async () => {
      if (finished || busy) return;
      // watchdog: 45с БЕЗ прогресса (нет текста, сессии не кончаются) —
      // что-то сломалось, вытаскиваем из мёртвого состояния
      if (voiceStartRef.current && Date.now() - voiceStartRef.current > 45000) {
        voiceNative.stop();
        return finishVoice("watchdog");
      }
      // ручной стоп — не ждём isRecognizing, сразу собираем результат
      if (stoppingRef.current) {
        onSessionEnd();
        return;
      }
      const recognizing = await voiceNative.isRecognizing();
      if (finished || busy) return;
      if (recognizing) {
        // живая строка: накопленное + partial текущей сессии
        const { text } = await voiceNative.getSpeechResults();
        if (finished) return;
        const partial = (text || "").trim();
        const live = accum ? accum + (partial ? " " + partial : "") : partial;
        if (live && live !== dictRef.current) {
          dictRef.current = live;
          setDictation(live);
          voiceStartRef.current = Date.now(); // watchdog: есть прогресс
        }
        return;
      }
      // грайс: сразу после (ре)старта isRecognizing может быть false, пока
      // распознаватель поднимается — не считаем сессию «закончившейся»
      if (Date.now() - lastStartAt < 2000) return;
      onSessionEnd();
    };

    const id = setInterval(tick, 400);
    return () => {
      finished = true;
      clearInterval(id);
      if (collectTimer) clearTimeout(collectTimer);
    };
  }, [voiceOn]);

  // при выходе из чата голос глушим (иначе микрофон ждёт в фоне)
  useEffect(
    () => () => {
      voiceNative.stop();
    },
    []
  );

  // полный экран картинки: data: base64 → во временный файл (file:// в Modal
  // надёжнее, чем data:URI длинной в ~150КБ), при закрытии — удаляем
  useEffect(() => {
    let alive = true;
    setPreviewFile(null);
    setPreviewErr(null);
    setPreviewSize(null);
    if (filePreview && filePreview.startsWith("data:")) {
      const comma = filePreview.indexOf(",");
      const meta = filePreview.slice(5, comma);
      const b64 = filePreview.slice(comma + 1);
      const path = Paths.cache + "/preview-" + Date.now() + (meta.includes("png") ? ".png" : ".jpg");
      new File(path)
        .write(b64, { encoding: "base64" })
        .then(() => {
          if (alive) setPreviewFile(path);
        })
        .catch((e: any) => {
          console.log("[img] preview write failed: " + (e?.message ?? e));
        });
    }
    return () => {
      alive = false;
    };
  }, [filePreview]);

  const closePreview = () => {
    setFilePreview(null);
    if (previewFile) {
      try {
        const f = new File(previewFile);
        if (f.exists) f.delete();
      } catch {
        /* не критично */
      }
    }
  };

  /** вписать картинку в экран (не больше 75% высоты, без растяжения) */
  const previewFit = useMemo(() => {
    if (!previewSize) return null;
    const maxW = Dimensions.get("window").width - spacing.l * 2;
    const maxH = Dimensions.get("window").height * 0.75;
    const k = Math.min(1, maxW / previewSize.w, maxH / previewSize.h);
    return { w: Math.round(previewSize.w * k), h: Math.round(previewSize.h * k) };
  }, [previewSize]);

  // ————————————————— файлы сессии (блок E) —————————————————
  // Сервер отдаёт файлы только из своего корня (C:\Users\kiril). Файлы на D:
  // скачаться не могут — для них только «скопировать путь» (⧉).
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  const fsNorm = (p: string) => p.replace(/\\/g, "/");

  const openFiles = async () => {
    setSheet("files");
    setFileErr(null);
    try {
      setFiles(await api.sessionFiles(sessionID));
    } catch (e: any) {
      setFileErr(e?.message ?? String(e));
    }
  };

  /** скачать файл из корня сервера в documents/downloads/ и вернуть локальный File */
  const fetchFile = async (p: string) => {
    const name = p.split(/[\\/]/).pop() ?? "file";
    const dir = new Directory(Paths.document, "downloads");
    if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
    const dest = new File(dir, Date.now() + "-" + name);
    return await File.downloadFileAsync(api.fsReadURL(fsNorm(p)), dest, {
      headers: { Authorization: basicAuthHeader(api.cfg.password) },
    });
  };

  const onFileTap = async (f: { path: string; last: number }) => {
    if (fileBusy) return;
    setFileErr(null);
    setFileBusy(f.path);
    try {
      const file = await fetchFile(f.path);
      if (IMG_RE.test(f.path)) {
        setFilePreview(file.uri); // картинка — превью в приложении
      } else {
        try {
          await file.preview(); // открыть системным приложением (просмотр/сохранить)
        } catch (e: any) {
          setFileErr("Не удалось открыть — файл скачан: " + file.uri);
        }
      }
    } catch (e: any) {
      setFileErr(
        "Не удалось скачать (" + (e?.message ?? e) + "). Сервер отдаёт файлы только из C:\\Users\\kiril — " +
          "если файл на D:, скопируй путь ⧉ и забирай вручную."
      );
    } finally {
      setFileBusy(null);
    }
  };

  const copyPath = async (p: string) => {
    try {
      await Clipboard.setString(p);
      setFileErr(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const title = sessionTitle || directory.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "сессия";
  /** сколько секунд уже работает агент — для плашки «работает 12с» */
  const busySec = busy && busySince ? Math.max(1, Math.round((Date.now() - busySince) / 1000)) : 0;
  const statusText = perms.length > 0 ? "perm:ждёт твоего разрешения" : activity || "think:думает";
  /** вид статуса → иконка: инструмент / печатает / думает / разрешение / отправляю */
  const statusInfo = (() => {
    if (sending && !busy) return { icon: "paper-plane-outline" as const, color: colors.accent, text: "отправляю сообщение" };
    const a = parseActivity(statusText);
    const icon: IconName =
      a.kind === "tool" ? "construct-outline" : a.kind === "typing" ? "create-outline" : a.kind === "perm" ? "alert-circle-outline" : "bulb-outline";
    return { icon, color: a.kind === "perm" ? colors.warn : colors.accent, text: a.text };
  })();

  // пузыри стрима: хвост печатающегося ответа — в чате до того, как дошёл снимок сервера
  const streamBubbles = useMemo(() => {
    const out: ChatBubble[] = [];
    for (const mid of Object.keys(stream)) {
      if (bubbles.some((b) => b.id === mid)) continue; // уже пришёл с сервера
      const sm = stream[mid];
      const parts: RenderPart[] = [];
      for (const ord of Object.keys(sm.texts).sort((a, b) => Number(a) - Number(b))) {
        const t = sm.texts[ord];
        if (t && t.trim()) parts.push({ kind: "text", text: t });
      }
      for (const tid of Object.keys(sm.tools)) {
        const tl = sm.tools[tid];
        parts.push({ kind: "tool", label: tl.label, state: tl.state });
      }
      if (parts.length > 0) out.push({ key: `stream-${mid}`, id: mid, role: "assistant", parts });
    }
    return out;
  }, [bubbles, stream]);

  // инвертированный список: показываем снизу вверх — скролл никогда не дёргается
  const reversed = useMemo(() => [...bubbles, ...streamBubbles].reverse(), [bubbles, streamBubbles]);

  const cur = info?.model;
  const modelName =
    cur && models.length > 0
      ? models.find((m) => m.id === String(cur.id) && m.providerID === String(cur.providerID))?.name ?? String(cur.id)
      : String(cur?.id ?? "модель…");
  const variantLabel = cur?.variant && String(cur.variant) !== "default" ? `·${String(cur.variant)}` : "";
  const modelLabel = `${modelName}${variantLabel}`;
  const agentLabel = String(info?.agent ?? "");
  const t = info?.tokens ?? {};
  const tokLabel = `${fmtTok(t.input)} в · ${fmtTok(t.output)} из · $${fmtCost(info?.cost)}`;

  return (
    <Animated.View
      style={[s.wrap, { paddingBottom: kbHeight, transform: [{ translateX: panX }] }]}
      {...swipe.panHandlers}
    >
      <View style={s.header}>
        <Pressable style={s.back} onPress={onBack} hitSlop={12}>
          <View style={s.backRow}>
            <Ionicons name="chevron-back" size={20} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: fontSize.l }}>Назад</Text>
          </View>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        {busy && (
          <Pressable style={s.stopBtn} onPress={stop}>
            <View style={s.stopRow}>
              <Ionicons name="stop" size={14} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "700" }}>Стоп</Text>
            </View>
          </Pressable>
        )}
      </View>

      {error && (
        <View style={s.errRow}>
          <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
          <Text style={s.err}>{error}</Text>
        </View>
      )}

      {conn === false && (
        <View style={s.connBanner}>
          <Ionicons name="cloud-offline-outline" size={15} color={colors.warn} />
          <Text style={s.connText}>Нет связи с сервером — повторюсь сам</Text>
        </View>
      )}

      {/* инфо-строка: селекторы (модель/агент/файлы) — скроллятся, токены — всегда видны справа */}
      <View style={s.infoRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: spacing.s }}
        >
          <Pressable style={[s.chip, s.chipModel]} onPress={() => { loadModels(); setSheet("model"); }}>
            <View style={s.chipRow}>
              <Ionicons name="hardware-chip-outline" size={14} color={colors.textDim} />
              <Text style={[s.chipText, { flexShrink: 1 }]} numberOfLines={1}>{modelLabel}</Text>
              <Ionicons name="chevron-down" size={12} color={colors.textDim} />
            </View>
          </Pressable>
          <Pressable style={s.chip} onPress={() => { loadAgents(); setSheet("agent"); }}>
            <View style={s.chipRow}>
              <Ionicons name="person-circle-outline" size={14} color={colors.textDim} />
              <Text style={s.chipText} numberOfLines={1}>{agentLabel}</Text>
              <Ionicons name="chevron-down" size={12} color={colors.textDim} />
            </View>
          </Pressable>
          {serverKind === "opencode" && (
            <Pressable style={s.chip} onPress={openFiles}>
              <View style={s.chipRow}>
                <Ionicons name="folder-outline" size={14} color={colors.textDim} />
                <Text style={s.chipText} numberOfLines={1}>Файлы</Text>
              </View>
            </Pressable>
          )}
        </ScrollView>
        <Pressable style={[s.chip, s.chipFixed]} onPress={() => { loadContext(); setSheet("ctx"); }}>
          <View style={s.chipRow}>
            <Ionicons name="stats-chart-outline" size={14} color={colors.textDim} />
            <Text style={s.chipText} numberOfLines={1}>{tokLabel}</Text>
          </View>
        </Pressable>
      </View>

      {/* что делает агент: видно всегда, без «непонятного ожидания» */}
      {(busy || sending) && (
        <View style={s.statusBar}>
          <Ionicons name={statusInfo.icon} size={15} color={statusInfo.color} />
          <Text style={s.statusText} numberOfLines={1}>
            {statusInfo.text}{dots}{busySec > 0 ? ` · ${busySec}с` : ""}
          </Text>
        </View>
      )}

      {copied && (
        <View style={s.copiedBar}>
          <View style={s.copiedRow}>
            <Ionicons name="checkmark-circle" size={14} color={colors.ok} />
            <Text style={{ color: colors.ok, fontWeight: "700" }}>Скопировано</Text>
          </View>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={reversed}
        inverted
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ paddingTop: spacing.l, paddingBottom: spacing.s }}
        ItemSeparatorComponent={() => <View style={{ height: spacing.s }} />}
        onScroll={onListScroll}
        scrollEventThrottle={100}
        renderItem={({ item }) => {
          const isUser = item.role === "user";
          const isStreamBubble = item.key.startsWith("stream-");
          return (
            <View
              style={{
                paddingHorizontal: spacing.l,
                flexDirection: "row",
                justifyContent: isUser ? "flex-end" : "flex-start",
                alignItems: "center",
                gap: spacing.xs,
              }}
            >
              {isUser && <BubbleMenuBtn onOpen={() => openMenu(item)} />}
              <Pressable
                style={[s.bubble, isUser ? s.bubbleUser : s.bubbleBot]}
                onLongPress={() => copyBubble(item)}
              >
                {(() => {
                  // картинки группируем, как в Telegram: одна — большая,
                  // 2+ — сеткой по две; тап по любой — на весь экран
                  const nodes: React.ReactNode[] = [];
                  let imgRun: string[] = [];
                  const imgSrc = (p: RenderPart) =>
                    p.kind === "file" ? p.url ?? (p.data ? `data:${p.mime};base64,${p.data}` : undefined) : undefined;
                  const flushImgs = () => {
                    if (imgRun.length === 0) return;
                    const key = "img" + nodes.length;
                    if (imgRun.length === 1) {
                      nodes.push(
                        <Pressable key={key} onPress={() => setFilePreview(imgRun[0])}>
                          <Image source={{ uri: imgRun[0] }} style={s.imgSingle} resizeMode="cover" />
                        </Pressable>
                      );
                    } else {
                      nodes.push(
                        <View key={key} style={s.imgGrid}>
                          {imgRun.map((u, i) => (
                            <Pressable key={i} onPress={() => setFilePreview(u)}>
                              <Image source={{ uri: u }} style={s.imgCell} resizeMode="cover" />
                            </Pressable>
                          ))}
                        </View>
                      );
                    }
                    imgRun = [];
                  };
                  item.parts.forEach((p: RenderPart, i: number) => {
                    const src = imgSrc(p);
                    if (p.kind === "file" && p.mime.startsWith("image/") && src) {
                      imgRun.push(src);
                      return;
                    }
                    flushImgs();
                    if (p.kind === "text") {
                      // markdown в пузыре (bold/код/блоки/ссылки); курсор
                      // «печатает…» — на хвосте стрим-пузыря, пока агент работает
                      const cursor = isStreamBubble && busy && i === item.parts.length - 1 ? " ▍" : "";
                      renderMdBlocks(p.text, isUser, `b${i}-`, copyCode).forEach((n) => nodes.push(n));
                      if (cursor) {
                        nodes.push(
                          <Text key={i + "-cur"} style={[s.bubbleText, isUser && { color: "#fff" }]}>
                            {cursor}
                          </Text>
                        );
                      }
                    } else if (p.kind === "tool") {
                      const ti =
                        p.state === "running"
                          ? { n: "construct-outline" as const, c: colors.accent }
                          : p.state === "completed"
                          ? { n: "checkmark" as const, c: colors.ok }
                          : p.state === "error"
                          ? { n: "close" as const, c: colors.danger }
                          : { n: "ellipsis-horizontal-outline" as const, c: colors.textDim };
                      nodes.push(
                        <View key={i} style={s.toolLine}>
                          <View style={s.toolLineRow}>
                            <Ionicons name={ti.n} size={13} color={ti.c} />
                            <Text style={s.toolText}>
                              {p.label}
                              {p.state === "running" ? " …" : ""}
                            </Text>
                          </View>
                        </View>
                      );
                    } else if (p.kind === "file") {
                      nodes.push(
                        <View key={i} style={s.toolLineRow}>
                          <Ionicons name="attach-outline" size={13} color={colors.textDim} />
                          <Text style={s.toolText}>{p.label}</Text>
                        </View>
                      );
                    } else {
                      nodes.push(
                        <View key={i} style={s.toolLineRow}>
                          {p.icon ? <Ionicons name={p.icon as IconName} size={13} color={colors.textDim} /> : null}
                          <Text style={s.toolText}>{p.label}</Text>
                        </View>
                      );
                    }
                  });
                  flushImgs();
                  return nodes;
                })()}
                {item.time ? (
                  <Text style={[s.bubbleTime, isUser && { color: "rgba(255,255,255,0.65)" }]}>
                    {new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                ) : null}
              </Pressable>
              {!isUser && <BubbleMenuBtn onOpen={() => openMenu(item)} />}
            </View>
          );
        }}
      />

      {perms.length > 0 && (
        <View style={s.permWrap}>
          {perms.map((p) => (
            <View key={p.requestID} style={s.permCard}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.s }}>
                <Ionicons name="alert-circle-outline" size={15} color={colors.warn} />
                <Text style={{ color: colors.warn, fontWeight: "700" }}>Нужно разрешение: {p.label}</Text>
              </View>
              <View style={s.permRow}>
                <Pressable style={[s.permBtn, { backgroundColor: colors.ok }]} onPress={() => decide(p.requestID, "once")}>
                  <Text style={s.permBtnText}>Разрешить</Text>
                </Pressable>
                <Pressable style={[s.permBtn, { backgroundColor: colors.accentDark }]} onPress={() => decide(p.requestID, "always")}>
                  <Text style={s.permBtnText}>Всегда</Text>
                </Pressable>
                <Pressable style={[s.permBtn, { backgroundColor: colors.danger }]} onPress={() => decide(p.requestID, "reject")}>
                  <Text style={s.permBtnText}>Отклонить</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* модальное окно: модели / агенты / контекст */}
      <Modal visible={sheet != null} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
        <View style={s.overlay}>
          <View style={s.modal}>
            {sheet === "model" && (
              <>
                <Text style={s.sheetTitle}>Модель сессии</Text>
                <TextInput
                  style={s.searchInput}
                  value={mq}
                  onChangeText={setMq}
                  placeholder="Поиск модели…"
                  placeholderTextColor={colors.textDim}
                  autoCapitalize="none"
                />
                <FlatList
                  data={modelRows}
                  keyExtractor={(item, i) => String(i)}
                  style={{ maxHeight: 380 }}
                  ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
                  renderItem={({ item }) => {
                    if (item.kind === "hdr") {
                      return item.fav ? (
                        <View style={s.secHdrRow}>
                          <Ionicons name="star" size={12} color="#f5b73e" />
                          <Text style={s.secHdr}>{item.label}</Text>
                        </View>
                      ) : (
                        <Text style={s.secHdr}>{item.label}</Text>
                      );
                    }
                    const m = item.m;
                    const k = modelKey(m);
                    const activeRow = String(cur?.id) === m.id && String(cur?.providerID) === m.providerID;
                    const activeVariant = activeRow && String(cur?.variant ?? "") !== "";
                    const isFav = favs.has(k);
                    const expanded = expandedModel === k;
                    return (
                      <View>
                        <View style={[s.card, { flexDirection: "row", alignItems: "center", marginHorizontal: 0, paddingVertical: spacing.s }, activeRow && { borderColor: colors.accent }]}>
                          <Pressable style={{ flex: 1 }} onPress={() => pressModelRow(m)}>
                            <View style={s.cardTitleRow}>
                              {activeRow && <Ionicons name="checkmark" size={15} color={colors.ok} />}
                              {!activeRow && m.variants.length > 0 && (
                                <Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={14} color={colors.textDim} />
                              )}
                              <Text style={s.cardTitle} numberOfLines={1}>
                                {m.name}
                              </Text>
                            </View>
                            <Text style={s.cardDir} numberOfLines={1}>
                              {m.providerID}
                              {activeVariant
                                ? ` · режим: ${String(cur?.variant)}`
                                : m.variants.length > 0
                                ? " · режимы: " + m.variants.join(", ")
                                : ""}
                            </Text>
                          </Pressable>
                          <Pressable hitSlop={6} style={{ paddingHorizontal: spacing.m }} onPress={() => toggleFav(m)}>
                            <Ionicons name={isFav ? "star" : "star-outline"} size={20} color={isFav ? "#f5b73e" : colors.textDim} />
                          </Pressable>
                        </View>
                        {expanded && m.variants.length > 0 && (
                          <View style={s.variantRow}>
                            <Pressable style={s.variantChip} onPress={() => applyModel({ id: m.id, providerID: m.providerID })}>
                              <Text style={s.variantText}>default</Text>
                            </Pressable>
                            {m.variants.map((v) => (
                              <Pressable key={v} style={s.variantChip} onPress={() => applyModel({ id: m.id, providerID: m.providerID, variant: v })}>
                                <Text style={s.variantText}>{v}</Text>
                              </Pressable>
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  }}
                  ListEmptyComponent={<Text style={s.empty}>Ничего не нашлось</Text>}
                />
                <Text style={s.hint}>Звезда — добавить модель в избранное, стрелка — раскрыть режимы reasoning.</Text>
              </>
            )}
            {sheet === "agent" && (
              <>
                <Text style={s.sheetTitle}>Агент сессии</Text>
                <FlatList
                  data={agents}
                  keyExtractor={(a) => a.id}
                  style={{ maxHeight: 340 }}
                  ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
                  renderItem={({ item }) => {
                    const activeRow = String(info?.agent) === item.id;
                    return (
                      <Pressable
                        style={[s.card, { marginHorizontal: 0, paddingVertical: spacing.s }, activeRow && { borderColor: colors.accent }]}
                        onPress={() => applyAgent(item.id)}
                      >
                        <View style={s.cardTitleRow}>
                          {activeRow && <Ionicons name="checkmark" size={15} color={colors.ok} />}
                          <Text style={s.cardTitle}>{item.name}</Text>
                        </View>
                        <Text style={s.cardDir}>{item.id}</Text>
                      </Pressable>
                    );
                  }}
                />
                <Text style={s.hint}>Build — обычная работа. Explore — быстрый поиск по коду, не меняет файлы.</Text>
              </>
            )}
            {sheet === "ctx" && (
              <>
                <Text style={s.sheetTitle}>Контекст сессии</Text>
                <View style={[s.card, { marginHorizontal: 0 }]}>
                  <View style={s.cardTitleRow}>
                    <Ionicons name="stats-chart-outline" size={15} color={colors.textDim} />
                    <Text style={s.cardTitle}>Токены</Text>
                  </View>
                  <Text style={s.cardDir}>
                    вход {fmtTok(t.input)} · выход {fmtTok(t.output)} · размышление {fmtTok(t.reasoning)} · кэш {fmtTok(t.cache?.read)}
                  </Text>
                  <View style={[s.cardTitleRow, { marginTop: spacing.m }]}>
                    <Ionicons name="cash-outline" size={15} color={colors.textDim} />
                    <Text style={s.cardTitle}>Стоимость</Text>
                  </View>
                  <Text style={s.cardDir}>${fmtCost(info?.cost)} за сессию</Text>
                  <Text style={[s.cardDir, { marginTop: spacing.s }]}>
                    {ctxCount == null ? "Собираю…" : `В контексте сейчас ~${ctxCount} записей.`}
                  </Text>
                </View>
                {serverKind !== "omnirush" && (
                  <Pressable style={[s.btn, { marginTop: spacing.m }]} onPress={doCompact}>
                    <View style={s.btnRow}>
                      <Ionicons name="contract-outline" size={16} color="#fff" />
                      <Text style={s.btnText}>Сжать контекст</Text>
                    </View>
                  </Pressable>
                )}
              </>
            )}
            {sheet === "files" && (
              <>
                <View style={s.sheetTitleRow}>
                  <Ionicons name="folder-outline" size={18} color={colors.text} />
                  <Text style={s.sheetTitle}>Файлы сессии</Text>
                </View>
                {fileErr && (
                  <View style={s.errRow}>
                    <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
                    <Text style={s.err}>{fileErr}</Text>
                  </View>
                )}
                <FlatList
                  data={files ?? []}
                  keyExtractor={(f) => f.path}
                  style={{ maxHeight: 420 }}
                  ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
                  ListEmptyComponent={
                    <Text style={s.empty}>Агент ещё не трогал файлы в этой сессии (или сессия короткая).</Text>
                  }
                  renderItem={({ item }) => (
                    <View style={[s.card, { marginHorizontal: 0, flexDirection: "row", alignItems: "center" }]}>
                      <Pressable style={{ flex: 1 }} onPress={() => onFileTap(item)} disabled={fileBusy != null}>
                        <View style={s.fileRow}>
                          <Ionicons
                            name={fileBusy === item.path ? "time-outline" : IMG_RE.test(item.path) ? "image-outline" : "document-outline"}
                            size={15}
                            color={fileBusy === item.path ? colors.warn : colors.textDim}
                          />
                          <Text style={s.cardTitle} numberOfLines={1}>
                            {item.path.split(/[\\/]/).pop()}
                          </Text>
                        </View>
                        <Text style={s.cardDir} numberOfLines={1}>
                          {item.path}
                        </Text>
                      </Pressable>
                      <Pressable hitSlop={8} style={{ paddingLeft: spacing.m }} onPress={() => copyPath(item.path)}>
                        <Ionicons name="copy-outline" size={18} color={colors.textDim} />
                      </Pressable>
                    </View>
                  )}
                />
                <Text style={s.hint}>
                  Картинка — тапай для превью, остальное — скачать (chooser «поделиться»). Сервер отдаёт файлы
                  только из C:\Users\kiril: файлы на D: не скачаются — копируй путь (иконка справа).
                </Text>
              </>
            )}
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setSheet(null)}>
              <Text style={[s.btnText, { color: colors.text }]}>Закрыть</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* строка диктовки: живой текст; единственный стоп — ⏹ на кнопке отправки */}
      {voiceOn && (
        <View style={s.selBar}>
          <ActivityIndicator size="small" color={colors.accent} style={{ marginRight: spacing.s }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
            <Ionicons name="mic" size={14} color={colors.accent} />
            <Text style={s.selBarText} numberOfLines={1}>
              {voicePhase === "processing" ? "Готовлю текст…" : dictation || "Слушаю — говори…"}
            </Text>
          </View>
        </View>
      )}

      {/* «вниз» — когда пролистали вверх от последних сообщений */}
      {away && (
        <View style={{ alignItems: "flex-end", paddingHorizontal: spacing.l, paddingBottom: spacing.xs }}>
          <Pressable style={s.bottomBtn} onPress={scrollToBottom} hitSlop={6}>
            <Ionicons name="arrow-down" size={22} color={colors.text} />
          </Pressable>
        </View>
      )}

      {/* чипы быстрых фраз над полем ввода (редактируются карандашом) */}
      {phrases.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.phraseRow}
          contentContainerStyle={{ gap: spacing.s, paddingHorizontal: spacing.l, alignItems: "center" }}
        >
          {phrases.map((p, i) => (
            <Pressable key={i} style={s.phraseChip} onPress={() => applyPhrase(p)}>
              <Ionicons name="chatbubble-ellipses-outline" size={13} color={colors.textDim} />
              <Text style={s.phraseText} numberOfLines={1}>{p}</Text>
            </Pressable>
          ))}
          <Pressable
            style={s.phraseChip}
            onPress={() => {
              setPhraseDraft(phrases.join("\n"));
              setPhraseEdit(true);
            }}
          >
            <Ionicons name="pencil-outline" size={13} color={colors.textDim} />
            <Text style={s.phraseText}>Фразы</Text>
          </Pressable>
        </ScrollView>
      )}

      <View style={s.inputRow}>
        <Pressable style={s.attachBtn} onPress={() => setAttachMenu(true)}>
          <Ionicons name="attach-outline" size={22} color={colors.textDim} />
        </Pressable>
        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder={busy ? "Агент работает — сообщение встанет в очередь" : "Написать агенту…"}
          placeholderTextColor={colors.textDim}
          multiline
        />
        {/* как в Telegram: на месте «отправить» — микрофон; кнопка отправки
            появляется, только когда есть текст/вложения; при диктовке — стоп */}
        <Pressable
          style={[s.sendBtn, sending ? { opacity: 0.6 } : null]}
          onPress={() => {
            if (sending) return;
            if (voiceOn) {
              toggleVoice();
              return;
            }
            if (input.trim().length > 0 || attachments.length > 0) {
              send();
              return;
            }
            toggleVoice();
          }}
          disabled={sending}
        >
          {sending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : voiceOn ? (
            <Ionicons name="stop" size={20} color="#fff" />
          ) : input.trim().length > 0 || attachments.length > 0 ? (
            <Ionicons name="arrow-forward" size={22} color="#fff" />
          ) : (
            <Ionicons name="mic" size={24} color="#fff" />
          )}
        </Pressable>
      </View>

      {attachments.length > 0 && (
        <ScrollView horizontal style={s.attachRow} contentContainerStyle={{ gap: spacing.s }}>
          {attachments.map((a, i) =>
            a.mime.startsWith("image/") ? (
              <View key={a.uri + i} style={s.attachThumbWrap}>
                <Image source={{ uri: a.uri }} style={s.attachThumb} />
                <Pressable
                  style={s.attachDel}
                  hitSlop={8}
                  onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Ionicons name="close" size={12} color="#fff" />
                </Pressable>
              </View>
            ) : (
              <View key={a.uri + i} style={s.fileChipWrap}>
                <View style={s.fileChip}>
                  <Ionicons name="document-text-outline" size={18} color={colors.accent} />
                  <Text style={s.fileChipName} numberOfLines={1}>
                    {a.filename}
                  </Text>
                </View>
                <Pressable
                  style={s.attachDel}
                  hitSlop={8}
                  onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Ionicons name="close" size={12} color="#fff" />
                </Pressable>
              </View>
            )
          )}
        </ScrollView>
      )}

      <Modal visible={attachMenu} transparent animationType="fade" onRequestClose={() => setAttachMenu(false)}>
        <Pressable style={s.overlay} onPress={() => setAttachMenu(false)}>
          <View style={s.modal}>
            <Text style={s.sheetTitle}>Прикрепить файл</Text>
            <Pressable
              style={[s.card, { marginHorizontal: 0 }]}
              onPress={() => {
                setAttachMenu(false);
                pickDocument();
              }}
            >
              <View style={s.attachMenuRow}>
                <Ionicons name="document-text-outline" size={20} color={colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Файл</Text>
                  <Text style={s.cardDir}>Документ, архив, код — любой файл с телефона</Text>
                </View>
              </View>
            </Pressable>
            <Pressable
              style={[s.card, { marginHorizontal: 0, marginTop: spacing.s }]}
              onPress={() => {
                setAttachMenu(false);
                pickImage(false);
              }}
            >
              <View style={s.attachMenuRow}>
                <Ionicons name="images-outline" size={20} color={colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Галерея</Text>
                  <Text style={s.cardDir}>Выбрать фото или скриншот</Text>
                </View>
              </View>
            </Pressable>
            <Pressable
              style={[s.card, { marginHorizontal: 0, marginTop: spacing.s }]}
              onPress={() => {
                setAttachMenu(false);
                pickImage(true);
              }}
            >
              <View style={s.attachMenuRow}>
                <Ionicons name="camera-outline" size={20} color={colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Камера</Text>
                  <Text style={s.cardDir}>Сфотографировать прямо сейчас</Text>
                </View>
              </View>
            </Pressable>
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setAttachMenu(false)}>
              <Text style={[s.btnText, { color: colors.text }]}>Отмена</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* быстрые фразы: редактор (по одной на строку) */}
      <Modal visible={phraseEdit} transparent animationType="slide" onRequestClose={() => setPhraseEdit(false)}>
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={s.sheetTitle}>Быстрые фразы</Text>
            <Text style={s.hint}>
              По одной фразе на строку. Тап по чипу над полем ввода дописывает фразу к сообщению.
            </Text>
            <TextInput
              style={[s.searchInput, { height: 150, textAlignVertical: "top" }]}
              value={phraseDraft}
              onChangeText={setPhraseDraft}
              multiline
              placeholder={"что сделал\nпродолжай\nпроверь ошибки"}
              placeholderTextColor={colors.textDim}
            />
            <Pressable style={s.btn} onPress={savePhrases}>
              <Text style={s.btnText}>Сохранить</Text>
            </Pressable>
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setPhraseEdit(false)}>
              <Text style={[s.btnText, { color: colors.text }]}>Отмена</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* меню сообщения: «…» рядом с пузырём */}
      <Modal visible={menuBubble !== null} transparent animationType="fade" onRequestClose={closeMenu}>
        <Pressable style={s.overlay} onPress={closeMenu}>
          <View style={s.modal}>
            <Text style={s.sheetTitle}>{menuBubble?.role === "user" ? "Твоё сообщение" : "Ответ агента"}</Text>
            {menuBubble && hasText(menuBubble) ? (
              <Pressable style={s.menuRow} onPress={() => { copyBubble(menuBubble); closeMenu(); }}>
                <View style={s.menuRowIcon}>
                  <Ionicons name="copy-outline" size={17} color={colors.text} />
                  <Text style={s.menuRowText}>Копировать всё</Text>
                </View>
              </Pressable>
            ) : null}
            {menuBubble?.id ? (
              <Pressable
                style={s.menuRow}
                onPress={() => {
                  const b = menuBubble;
                  closeMenu();
                  doRevert(b);
                }}
              >
                <View style={s.menuRowIcon}>
                  <Ionicons name="arrow-undo-outline" size={17} color={colors.danger} />
                  <Text style={[s.menuRowText, { color: colors.danger }]}>Откатить с этого</Text>
                </View>
              </Pressable>
            ) : null}
            <Pressable style={[s.btn, s.btnGhost]} onPress={closeMenu}>
              <Text style={[s.btnText, { color: colors.text }]}>Отмена</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* превью картинки на весь экран: тап — закрыть */}
      <Modal visible={filePreview != null} transparent animationType="fade" onRequestClose={closePreview}>
        <View style={s.overlay}>
          <Pressable
            style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.l }}
            onPress={closePreview}
          >
            {filePreview && !previewErr ? (
              <Image
                source={{ uri: previewFile ?? filePreview }}
                style={
                  previewFit
                    ? { width: previewFit.w, height: previewFit.h }
                    : { width: "92%", maxHeight: Math.round(Dimensions.get("window").height * 0.7) }
                }
                resizeMode="contain"
                onLoad={(e) => {
                  const sw = e.nativeEvent.source?.width;
                  const sh = e.nativeEvent.source?.height;
                  if (sw && sh) setPreviewSize({ w: sw, h: sh });
                }}
                onError={(e) => {
                  console.log("[img] preview load failed: " + (e.nativeEvent?.error ?? "?"));
                  setPreviewErr(String(e.nativeEvent?.error ?? "не удалось загрузить"));
                }}
              />
            ) : null}
            {filePreview && previewErr ? (
              <Text style={{ color: colors.danger, textAlign: "center" }}>
                Картинка не загрузилась
                {"\n"}
                {previewErr}
              </Text>
            ) : null}
            <Text style={{ color: colors.textDim, marginTop: spacing.m }}>тап по экрану — закрыть</Text>
          </Pressable>
        </View>
      </Modal>
    </Animated.View>
  );
}

/** ————— мини-markdown для пузырей —————
 * Инлайн: **жирный**, *курсив*, `код`, [ссылка](url).
 * Блоки: ``` код (с языком), заголовки #..####.
 * Весь инлайн — вложенные <Text> внутри одного selectable-Text: на Android
 * это ОДИН TextView → нативное выделение зажатием продолжает работать.
 */
const MD_INLINE =
  /(\*\*(?:[^*]|\*(?!\*))+?\*\*|__(?:[^_])+?__|\*(?:[^*\n])+?\*|(?<![A-Za-z0-9_])_(?:[^_\n])+?_(?![A-Za-z0-9])|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

function renderMdInline(text: string, isUser: boolean, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  MD_INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = keyBase + k++;
    if ((tok.startsWith("**") || tok.startsWith("__")) && tok.endsWith(tok.slice(0, 2)) && tok.length > 4) {
      out.push(<Text key={key} style={{ fontWeight: "700" }}>{tok.slice(2, -2)}</Text>);
    } else if ((tok.startsWith("*") || tok.startsWith("_")) && tok.endsWith(tok[0]) && tok.length > 2) {
      out.push(<Text key={key} style={{ fontStyle: "italic" }}>{tok.slice(1, -1)}</Text>);
    } else if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
      out.push(
        <Text key={key} style={[s.mdCode, isUser && { backgroundColor: "rgba(255,255,255,0.22)" }]}>
          {tok.slice(1, -1)}
        </Text>
      );
    } else if (tok.startsWith("[") && tok.includes("](")) {
      const mm = tok.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)$/);
      if (mm && /^https?:\/\//i.test(mm[2])) {
        out.push(
          <Text
            key={key}
            style={{ color: isUser ? "#cfe0ff" : colors.accent, textDecorationLine: "underline" }}
            onPress={() => Linking.openURL(mm[2]).catch(() => {})}
          >
            {mm[1]}
          </Text>
        );
      } else {
        out.push(tok);
      }
    } else {
      out.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** текстовый фрагмент: заголовки (#..####) — жирные, остальное — инлайн-markdown */
function renderMdText(part: string, isUser: boolean, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = part.split("\n");
  let plain: string[] = [];
  const flush = (suffix: string) => {
    if (plain.length === 0) return;
    const txt = plain.join("\n");
    plain = [];
    if (!txt.trim()) return;
    nodes.push(
      <Text key={keyBase + suffix} style={[s.bubbleText, isUser && { color: "#fff" }]}>
        {renderMdInline(txt, isUser, keyBase + suffix + "-")}
      </Text>
    );
  };
  lines.forEach((line, li) => {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush("p" + li);
      const size = Math.max(14, 18 - h[1].length);
      nodes.push(
        <Text
          key={keyBase + "h" + li}
          style={[s.bubbleText, { fontWeight: "700", fontSize: size, marginTop: spacing.xs }, isUser && { color: "#fff" }]}
        >
          {renderMdInline(h[2], isUser, keyBase + "h" + li + "-")}
        </Text>
      );
    } else {
      plain.push(line);
    }
  });
  flush("end");
  return nodes;
}

/** весь текст: режем на блоки по ```, кодовые блоки — отдельным View;
 *  тап по кодовому блоку — копировать код (onCopyCode) */
function renderMdBlocks(text: string, isUser: boolean, keyBase: string, onCopyCode?: (code: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const parts = text.split("```");
  parts.forEach((part, idx) => {
    if (idx % 2 === 0) {
      nodes.push(...renderMdText(part, isUser, keyBase + "t" + idx + "-"));
    } else {
      let code = part;
      let lang = "";
      const nl = part.indexOf("\n");
      const firstLine = (nl >= 0 ? part.slice(0, nl) : part).trim();
      if (/^[a-zA-Z0-9+#.:-]{0,20}$/.test(firstLine)) {
        lang = firstLine;
        code = nl >= 0 ? part.slice(nl + 1) : "";
      }
      const codeText = code.replace(/\n$/, "");
      const block = (
        <View style={[s.mdCodeBlock, isUser && { backgroundColor: "rgba(0,0,0,0.28)" }]}>
          {lang ? <Text style={[s.mdCodeLang, isUser && { color: "rgba(255,255,255,0.6)" }]}>{lang}</Text> : null}
          <Text style={[s.mdCodeText, isUser && { color: "#eef2fa" }]}>{codeText}</Text>
        </View>
      );
      nodes.push(
        onCopyCode ? (
          <Pressable key={keyBase + "c" + idx} onPress={() => onCopyCode(codeText)}>
            {block}
          </Pressable>
        ) : (
          <View key={keyBase + "c" + idx}>{block}</View>
        )
      );
    }
  });
  return nodes;
}

/** «…» рядом с пузырём: меню сообщения (копировать всё / откатить).
 *  Долгое нажатие на пузырь — копировать всё (onLongPress), сюда не уходит. */
function BubbleMenuBtn({ onOpen }: { onOpen: () => void }) {
  return (
    <Pressable
      onPress={onOpen}
      hitSlop={6}
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: colors.surface2,
        borderColor: colors.border,
        borderWidth: 1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons name="ellipsis-horizontal" size={16} color={colors.textDim} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, paddingTop: spacing.l },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.l,
    paddingBottom: spacing.s,
  },
  back: { width: 90 },
  title: { color: colors.text, fontSize: fontSize.l, fontWeight: "700", flex: 1, textAlign: "center" },
  bubble: {
    maxWidth: "85%",
    borderRadius: 14,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
  },
  bubbleUser: { backgroundColor: colors.userBubble },
  bubbleBot: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1 },
  bubbleText: { color: colors.text, fontSize: fontSize.m },
  mdCode: {
    fontFamily: "monospace",
    fontSize: fontSize.s,
    backgroundColor: colors.bg,
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 1,
    overflow: "hidden",
  },
  mdCodeBlock: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.s,
    paddingVertical: spacing.s,
    marginTop: spacing.xs,
    overflow: "hidden",
  },
  mdCodeLang: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  mdCodeText: {
    fontFamily: "monospace",
    fontSize: fontSize.s,
    color: colors.text,
  },
  toolLine: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: 2,
    marginTop: spacing.xs,
    alignSelf: "flex-start",
  },
  toolText: { color: colors.textDim, fontSize: fontSize.s },
  imgSingle: { width: 260, height: 195, borderRadius: 10, marginTop: spacing.xs },
  imgGrid: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: spacing.xs },
  imgCell: { width: 146, height: 110, borderRadius: 8 },
  bubbleTime: {
    color: colors.textDim,
    fontSize: fontSize.s,
    alignSelf: "flex-end",
    marginTop: 3,
    textAlign: "right",
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s,
    marginHorizontal: spacing.l,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.m,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  statusText: { color: colors.text, fontSize: fontSize.s, flex: 1 },
  stopBtn: {
    backgroundColor: colors.danger,
    borderRadius: 8,
    paddingHorizontal: spacing.m,
    paddingVertical: 6,
  },
  selBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s,
    marginHorizontal: spacing.l,
    marginBottom: spacing.s,
    padding: spacing.s,
    borderRadius: 10,
    backgroundColor: colors.surface2,
  },
  menuRow: {
    backgroundColor: colors.surface2,
    borderRadius: 12,
    paddingHorizontal: spacing.m,
    paddingVertical: 14,
    marginBottom: spacing.xs,
  },
  menuRowText: { color: colors.text, fontSize: fontSize.m, fontWeight: "600" },
  selBarText: { color: colors.textDim, fontSize: fontSize.s, flex: 1 },
  copiedBar: {
    alignItems: "center",
    paddingVertical: 2,
  },
  bottomBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface2,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  attachBtn: { paddingHorizontal: spacing.s, paddingBottom: 8 },
  attachRow: { maxHeight: 76, paddingHorizontal: spacing.l, paddingBottom: spacing.s },
  attachThumbWrap: { position: "relative" },
  fileChipWrap: { position: "relative", alignSelf: "center" },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.surface2,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.s,
    paddingVertical: 8,
    maxWidth: 200,
  },
  fileChipName: { color: colors.text, fontSize: fontSize.s, flexShrink: 1 },
  attachThumb: { width: 64, height: 64, borderRadius: 8 },
  attachDel: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  permWrap: { paddingHorizontal: spacing.l, paddingTop: spacing.xs },
  permCard: {
    backgroundColor: colors.surface,
    borderColor: colors.warn,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginBottom: spacing.s,
  },
  permRow: { flexDirection: "row", gap: spacing.s },
  permBtn: {
    flex: 1,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
  },
  permBtnText: { color: "#fff", fontWeight: "600", fontSize: fontSize.s },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing.l,
    paddingTop: spacing.s,
    paddingBottom: spacing.m,
    gap: spacing.s,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.l,
    paddingBottom: spacing.xs,
    gap: spacing.s,
  },
  chip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: 6,
  },
  chipText: { color: colors.textDim, fontSize: fontSize.s },
  searchInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.m,
    paddingVertical: 10,
    color: colors.text,
    fontSize: fontSize.m,
    marginBottom: spacing.m,
  },
  variantRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingHorizontal: spacing.m,
    paddingBottom: spacing.s,
  },
  variantChip: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: 4,
  },
  variantText: { color: colors.textDim, fontSize: fontSize.s },
  btnGhost: { backgroundColor: colors.surface2, marginTop: spacing.m },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  modal: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.l,
    maxHeight: "88%",
  },
  sheetTitle: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: "700",
    marginBottom: spacing.m,
  },
  secHdr: {
    color: colors.textDim,
    fontSize: fontSize.s,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: spacing.s,
    marginBottom: spacing.xs,
  },
  secHdrRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: spacing.s, marginBottom: spacing.xs },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginHorizontal: spacing.l,
  },
  cardTitle: { color: colors.text, fontSize: fontSize.m, fontWeight: "600" },
  cardDir: { color: colors.textDim, fontSize: fontSize.s, marginTop: spacing.xs },
  hint: { color: colors.textDim, fontSize: fontSize.s, marginTop: spacing.s },
  empty: {
    color: colors.textDim,
    fontSize: fontSize.m,
    textAlign: "center",
    marginTop: spacing.l,
  },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    alignItems: "center",
    paddingVertical: 14,
  },
  btnText: { color: "#fff", fontSize: fontSize.l, fontWeight: "600" },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: spacing.m,
    paddingTop: 10,
    paddingBottom: 10,
    color: colors.text,
    fontSize: fontSize.m,
    textAlignVertical: "top",
    maxHeight: 240,
  },
  sendBtn: {
    backgroundColor: colors.accent,
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  err: {
    color: colors.danger,
    fontSize: fontSize.s,
    flex: 1,
  },
  errRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginHorizontal: spacing.l,
    marginBottom: spacing.xs,
  },
  backRow: { flexDirection: "row", alignItems: "center", gap: 2 },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  chipModel: { maxWidth: 160 },
  chipFixed: { flexShrink: 0 },
  toolLineRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  copiedRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  connBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: spacing.l,
    marginTop: spacing.xs,
    backgroundColor: colors.surface,
    borderColor: colors.warn,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.m,
    paddingVertical: 8,
  },
  connText: { color: colors.warn, fontSize: fontSize.s, flex: 1 },
  // строка чипов — авто-высота по контенту. Старый maxHeight: 48 резал чипы
  // снизу на телефонах с крупным системным шрифтом (высота чипа зависит от
  // font_scale и превышаетла 48 → нижняя часть текста срезалась).
  phraseRow: { paddingBottom: spacing.xs },
  phraseChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: 6,
    maxWidth: 200,
  },
  phraseText: { color: colors.textDim, fontSize: fontSize.s, fontWeight: "600" },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  btnRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  attachMenuRow: { flexDirection: "row", alignItems: "center", gap: spacing.m },
  menuRowIcon: { flexDirection: "row", alignItems: "center", gap: 10 },
  sheetTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
});
