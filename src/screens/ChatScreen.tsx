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
import { File, Paths, Directory } from "expo-file-system";
import { voiceNative } from "../voice";
import Clipboard from "@react-native-clipboard/clipboard";
import { OpenCodeApi, RenderMessage, RenderPart, Decision, ServerKind, PromptFile, basicAuthHeader } from "../api";
import { subscribeSession, BusEvent, PermissionRequest } from "../events";
import { AsyncStorage } from "../store";
import { colors, spacing, fontSize } from "../theme";

interface Props {
  api: OpenCodeApi;
  /** сервер OpenCode — фэйвориты моделей синкаются с TUI; Omnirush — только телефон */
  serverKind?: ServerKind;
  sessionID: string;
  directory: string;
  onBack: () => void;
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

/** Код ошибки распознавателя → человекочитаемо (по SpeechRecognizer.ERROR_*) */
function voiceErrorText(e: string): string {
  const code = String(e).split("/")[0];
  const map: Record<string, string> = {
    "1": "ошибка аудио (микрофон)",
    "3": "остановлено — слов не распознал",
    "6": "нет разрешения на микрофон",
    "7": "сетевая ошибка (распознаванию нужен интернет)",
    "8": "таймаут сети",
    "9": "не расслышал — попробуй ещё раз",
    "10": "распознаватель занят — попробуй ещё раз",
    "11": "таймаут речи (молчание)",
  };
  return map[code] ?? String(e);
}

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

export default function ChatScreen({ api, serverKind = "opencode", sessionID, directory, onBack }: Props) {
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
  // — голосовой ввод: тап 🎤 → дикт → вставляется в поле, без авто-отправки —
  const [voiceOn, setVoiceOn] = useState(false);
  const [dictation, setDictation] = useState("");
  /** listening — ждём речь; processing — пользователь нажал стоп, готовим текст */
  const [voicePhase, setVoicePhase] = useState<"listening" | "processing">("listening");
  const dictRef = useRef("");
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
    const rows: ({ kind: "hdr"; label: string } | { kind: "mdl"; m: ModelRow })[] = [];
    if (favMore.length > 0) {
      rows.push({ kind: "hdr", label: "★ Избранное" });
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
        if (running) setActivity(`⚙ ${(running as any).label}`);
        else if (hasText) setActivity("✍️ печатает ответ");
        else setActivity("🧠 думает");
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
          setActivity("✍️ печатает ответ");
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
          if (e.state === "running") setActivity(`⚙ ${guessTool(e.input)}`);
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
      setError(e?.message ?? String(e));
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

  /**
   * Меню сообщения — кнопка «⋯» рядом с пузырём. Долгое нажатие на сам текст —
   * нативное выделение Android (selectable): зажал на слове → ручки → копировать.
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

  // ————————————————— голосовой ввод —————————————————
  // тап 🎤 → диктуем → текст вставляется в поле (без авто-отправки).
  // Второй тап по той же кнопке (⏹) — стоп. RN 0.88 bridgeless: события
  // модуля не доходят, JS опрашивает isRecognizing() + getSpeechResults().
  // Все нативные вызовы обёрнуты таймаутами (voice.ts) + watchdog ниже —
  // режим диктовки не должен зависнуть «намертво».
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
    let collectTimer: ReturnType<typeof setTimeout> | null = null;
    let voiceEndAt = 0;

    /**
     * Финал: текст → в поле; пусто + ошибка → показываем причину.
     */
    const finishVoice = (text: string, error: string) => {
      if (finished) return;
      finished = true;
      if (collectTimer) clearTimeout(collectTimer);
      const t = text.trim();
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
     * Android шлёт onResults ПОСЛЕ onEndOfSpeech — опрашиваем getSpeechResults
     * каждые 400мс. Ручной стоп (пользователь ждёт) — окно короче: 2.5с.
     */
    const collect = async () => {
      if (finished) return;
      const { text, error } = await voiceNative.getSpeechResults();
      if (finished) return;
      if (text.trim()) return finishVoice(text, "");
      // спонтанный конец с ошибкой — завершаем сразу, не ждём финал
      if (error && !stoppingRef.current) return finishVoice("", error);
      const window = stoppingRef.current ? 2500 : 4000;
      if (Date.now() - voiceEndAt > window) return finishVoice("", error || "");
      collectTimer = setTimeout(collect, 400);
    };

    const tick = async () => {
      if (finished) return;
      // watchdog: диктовка висит больше 45с — что-то сломалось,
      // вытаскиваем из мёртвого состояния (stop + ошибка)
      if (voiceStartRef.current && Date.now() - voiceStartRef.current > 45000) {
        voiceNative.stop();
        return finishVoice("", "watchdog");
      }
      // после ручного стопа не ждём isRecognizing — сразу собираем результат
      if (stoppingRef.current && !voiceEndAt) {
        voiceEndAt = Date.now();
        collectTimer = setTimeout(collect, 400);
        return;
      }
      const recognizing = await voiceNative.isRecognizing();
      if (finished) return;
      if (recognizing) {
        // живая строка: последний partial с опозданием ~0.5-0.7с
        const { text } = await voiceNative.getSpeechResults();
        if (text && text !== dictRef.current) {
          dictRef.current = text;
          setDictation(text);
        }
        return;
      }
      // речь кончилась (тишина / ошибка / ручной стоп)
      voiceEndAt = Date.now();
      collectTimer = setTimeout(collect, 400);
    };

    const id = setInterval(tick, 700);
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
  const statusText = perms.length > 0 ? "✋ ждёт твоего разрешения" : activity || "🧠 думает";

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
  const tokLabel = `↑${fmtTok(t.input)} ↓${fmtTok(t.output)} $${fmtCost(info?.cost)}`;

  return (
    <Animated.View
      style={[s.wrap, { paddingBottom: kbHeight, transform: [{ translateX: panX }] }]}
      {...swipe.panHandlers}
    >
      <View style={s.header}>
        <Pressable style={s.back} onPress={onBack}>
          <Text style={{ color: colors.accent, fontSize: fontSize.l }}>‹ Назад</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        {busy && (
          <Pressable style={s.stopBtn} onPress={stop}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>■ Стоп</Text>
          </Pressable>
        )}
      </View>

      {error && <Text style={s.err}>⚠ {error}</Text>}

      {/* инфо-строка: модель / агент / статистика / файлы */}
      <View style={s.infoRow}>
        <Pressable style={s.chip} onPress={() => { loadModels(); setSheet("model"); }}>
          <Text style={s.chipText} numberOfLines={1}>🤖 {modelLabel} ▾</Text>
        </Pressable>
        <Pressable style={s.chip} onPress={() => { loadAgents(); setSheet("agent"); }}>
          <Text style={s.chipText} numberOfLines={1}>🧩 {agentLabel} ▾</Text>
        </Pressable>
        {serverKind === "opencode" && (
          <Pressable style={s.chip} onPress={openFiles}>
            <Text style={s.chipText} numberOfLines={1}>📁 Файлы</Text>
          </Pressable>
        )}
        <Pressable style={[s.chip, { marginLeft: "auto" }]} onPress={() => { loadContext(); setSheet("ctx"); }}>
          <Text style={s.chipText} numberOfLines={1}>📊 {tokLabel}</Text>
        </Pressable>
      </View>

      {/* что делает агент: видно всегда, без «непонятного ожидания» */}
      {(busy || sending) && (
        <View style={s.statusBar}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={s.statusText} numberOfLines={1}>
            {sending && !busy ? "📤 отправляю сообщение" : statusText}{dots} {busySec > 0 ? ` · ${busySec}с` : ""}
          </Text>
          <Pressable style={s.stopSmall} onPress={stop}>
            <Text style={{ color: "#fff", fontSize: fontSize.s, fontWeight: "700" }}>Стоп</Text>
          </Pressable>
        </View>
      )}

      {copied && (
        <View style={s.copiedBar}>
          <Text style={{ color: "#0a2", fontWeight: "700" }}>✓ Скопировано</Text>
        </View>
      )}

      <FlatList
        data={reversed}
        inverted
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ paddingTop: spacing.l, paddingBottom: spacing.s }}
        ItemSeparatorComponent={() => <View style={{ height: spacing.s }} />}
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
              <View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleBot]}>
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
                      renderMdBlocks(p.text, isUser, `b${i}-`).forEach((n) => nodes.push(n));
                      if (cursor) {
                        nodes.push(
                          <Text key={i + "-cur"} style={[s.bubbleText, isUser && { color: "#fff" }]}>
                            {cursor}
                          </Text>
                        );
                      }
                    } else if (p.kind === "tool") {
                      nodes.push(
                        <View key={i} style={s.toolLine}>
                          <Text style={s.toolText}>
                            {p.state === "running" ? "⚙ " : p.state === "completed" ? "✓ " : p.state === "error" ? "✗ " : "• "}
                            {p.label}
                            {p.state === "running" ? " …" : ""}
                          </Text>
                        </View>
                      );
                    } else if (p.kind === "file") {
                      nodes.push(
                        <Text key={i} style={s.toolText}>
                          📎 {p.label}
                        </Text>
                      );
                    } else {
                      nodes.push(
                        <Text key={i} style={s.toolText}>
                          {p.label}
                        </Text>
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
              </View>
              {!isUser && <BubbleMenuBtn onOpen={() => openMenu(item)} />}
            </View>
          );
        }}
      />

      {perms.length > 0 && (
        <View style={s.permWrap}>
          {perms.map((p) => (
            <View key={p.requestID} style={s.permCard}>
              <Text style={{ color: colors.warn, fontWeight: "700", marginBottom: spacing.s }}>
                ✋ Нужно разрешение: {p.label}
              </Text>
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
                      return <Text style={s.secHdr}>{item.label}</Text>;
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
                            <Text style={s.cardTitle} numberOfLines={1}>
                              {activeRow ? (activeVariant ? "✓⏳ " : "✓ ") : expanded && m.variants.length > 0 ? "▾ " : m.variants.length > 0 ? "▸ " : ""}
                              {m.name}
                            </Text>
                            <Text style={s.cardDir} numberOfLines={1}>
                              {m.providerID}
                              {m.variants.length > 0 ? " · режимы: " + m.variants.join(", ") : ""}
                            </Text>
                          </Pressable>
                          <Pressable hitSlop={6} style={{ paddingHorizontal: spacing.m }} onPress={() => toggleFav(m)}>
                            <Text style={{ color: isFav ? "#f5b73e" : colors.textDim, fontSize: fontSize.xl }}>
                              {isFav ? "★" : "☆"}
                            </Text>
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
                <Text style={s.hint}>Тапай ☆ чтобы добавить модель в избранное, ▸ раскрывает режимы reasoning.</Text>
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
                        <Text style={s.cardTitle}>{activeRow ? "✓ " : ""}{item.name}</Text>
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
                  <Text style={s.cardTitle}>📊 Токены</Text>
                  <Text style={s.cardDir}>
                    ↑ вход {fmtTok(t.input)} · ↓ выход {fmtTok(t.output)} · 💭 {fmtTok(t.reasoning)} · кэш {fmtTok(t.cache?.read)}
                  </Text>
                  <Text style={[s.cardTitle, { marginTop: spacing.m }]}>💵 Стоимость</Text>
                  <Text style={s.cardDir}>${fmtCost(info?.cost)} за сессию</Text>
                  <Text style={[s.cardDir, { marginTop: spacing.s }]}>
                    {ctxCount == null ? "Собираю…" : `В контексте сейчас ~${ctxCount} записей.`}
                  </Text>
                </View>
                {serverKind !== "omnirush" && (
                  <Pressable style={[s.btn, { marginTop: spacing.m }]} onPress={doCompact}>
                    <Text style={s.btnText}>🗜 Сжать контекст</Text>
                  </Pressable>
                )}
              </>
            )}
            {sheet === "files" && (
              <>
                <Text style={s.sheetTitle}>📁 Файлы сессии</Text>
                {fileErr && <Text style={s.err}>{fileErr}</Text>}
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
                        <Text style={s.cardTitle} numberOfLines={1}>
                          {fileBusy === item.path ? "⏳ " : IMG_RE.test(item.path) ? "🖼 " : "📄 "}
                          {item.path.split(/[\\/]/).pop()}
                        </Text>
                        <Text style={s.cardDir} numberOfLines={1}>
                          {item.path}
                        </Text>
                      </Pressable>
                      <Pressable hitSlop={8} style={{ paddingLeft: spacing.m }} onPress={() => copyPath(item.path)}>
                        <Text style={{ color: colors.textDim, fontSize: fontSize.l }}>⧉</Text>
                      </Pressable>
                    </View>
                  )}
                />
                <Text style={s.hint}>
                  Картинка — тапай для превью, остальное — скачать (chooser «поделиться»). Сервер отдаёт файлы
                  только из C:\Users\kiril: файлы на D: не скачаются — копируй путь ⧉.
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
          <Text style={s.selBarText} numberOfLines={1}>
            {voicePhase === "processing" ? "Готовлю текст…" : "🎤 " + (dictation || "Слушаю — говори…")}
          </Text>
        </View>
      )}

      <View style={s.inputRow}>
        <Pressable style={s.attachBtn} onPress={() => setAttachMenu(true)}>
          <Text style={{ color: colors.textDim, fontSize: fontSize.xl }}>📎</Text>
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
            <Text style={{ color: "#fff", fontSize: fontSize.l, fontWeight: "700" }}>⏹</Text>
          ) : input.trim().length > 0 || attachments.length > 0 ? (
            <Text style={s.sendText}>▶</Text>
          ) : (
            <Text style={{ fontSize: fontSize.xl }}>🎤</Text>
          )}
        </Pressable>
      </View>

      {attachments.length > 0 && (
        <ScrollView horizontal style={s.attachRow} contentContainerStyle={{ gap: spacing.s }}>
          {attachments.map((a, i) => (
            <View key={a.uri + i} style={s.attachThumbWrap}>
              <Image source={{ uri: a.uri }} style={s.attachThumb} />
              <Pressable
                style={s.attachDel}
                hitSlop={8}
                onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                <Text style={{ color: "#fff", fontSize: fontSize.s, fontWeight: "700" }}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={attachMenu} transparent animationType="fade" onRequestClose={() => setAttachMenu(false)}>
        <Pressable style={s.overlay} onPress={() => setAttachMenu(false)}>
          <View style={s.modal}>
            <Text style={s.sheetTitle}>Вложение</Text>
            <Pressable
              style={[s.card, { marginHorizontal: 0 }]}
              onPress={() => {
                setAttachMenu(false);
                pickImage(false);
              }}
            >
              <Text style={s.cardTitle}>🖼 Галерея</Text>
              <Text style={s.cardDir}>Выбрать фото или скриншот</Text>
            </Pressable>
            <Pressable
              style={[s.card, { marginHorizontal: 0, marginTop: spacing.s }]}
              onPress={() => {
                setAttachMenu(false);
                pickImage(true);
              }}
            >
              <Text style={s.cardTitle}>📷 Камера</Text>
              <Text style={s.cardDir}>Сфотографировать прямо сейчас</Text>
            </Pressable>
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setAttachMenu(false)}>
              <Text style={[s.btnText, { color: colors.text }]}>Отмена</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* меню сообщения: «⋯» рядом с пузырём (выделение текста — нативное, зажатием) */}
      <Modal visible={menuBubble !== null} transparent animationType="fade" onRequestClose={closeMenu}>
        <Pressable style={s.overlay} onPress={closeMenu}>
          <View style={s.modal}>
            <Text style={s.sheetTitle}>{menuBubble?.role === "user" ? "Твоё сообщение" : "Ответ агента"}</Text>
            {menuBubble && hasText(menuBubble) ? (
              <Pressable style={s.menuRow} onPress={() => { copyBubble(menuBubble); closeMenu(); }}>
                <Text style={s.menuRowText}>📋 Копировать всё</Text>
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
                <Text style={[s.menuRowText, { color: colors.danger }]}>⟲ Откатить с этого</Text>
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
      <Text key={keyBase + suffix} selectable style={[s.bubbleText, isUser && { color: "#fff" }]}>
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
          selectable
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

/** весь текст: режем на блоки по ```, кодовые блоки — отдельным View */
function renderMdBlocks(text: string, isUser: boolean, keyBase: string): React.ReactNode[] {
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
      nodes.push(
        <View key={keyBase + "c" + idx} style={[s.mdCodeBlock, isUser && { backgroundColor: "rgba(0,0,0,0.28)" }]}>
          {lang ? <Text style={[s.mdCodeLang, isUser && { color: "rgba(255,255,255,0.6)" }]}>{lang}</Text> : null}
          <Text style={[s.mdCodeText, isUser && { color: "#eef2fa" }]}>{code.replace(/\n$/, "")}</Text>
        </View>
      );
    }
  });
  return nodes;
}

/** «⋯» рядом с пузырём: меню сообщения (копировать всё / откатить).
 *  Долгое нажатие на текст — нативное выделение, оно не уходит сюда. */
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
      <Text style={{ color: colors.textDim, fontSize: fontSize.m, fontWeight: "700", lineHeight: 14 }}>⋯</Text>
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
  stopSmall: {
    backgroundColor: colors.danger,
    borderRadius: 8,
    paddingHorizontal: spacing.m,
    paddingVertical: 4,
  },
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
  attachBtn: { paddingHorizontal: spacing.s, paddingBottom: 8 },
  attachRow: { maxHeight: 76, paddingHorizontal: spacing.l, paddingBottom: spacing.s },
  attachThumbWrap: { position: "relative" },
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
  sendText: { color: "#fff", fontSize: fontSize.xl },
  err: {
    color: colors.danger,
    fontSize: fontSize.s,
    marginHorizontal: spacing.l,
    marginBottom: spacing.xs,
  },
});
