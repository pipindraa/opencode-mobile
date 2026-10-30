import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Platform,
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
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { OpenCodeApi, RenderMessage, RenderPart, Decision, ServerKind, PromptFile } from "../api";
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
}

interface PermCard {
  requestID: string;
  label: string;
}

const POLL_MS = 1600;

type ModelRow = { id: string; providerID: string; name: string; variants: string[] };

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
  const [sheet, setSheet] = useState<null | "model" | "agent" | "ctx">(null);
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
    const t = setInterval(() => {
      loadMessages();
      pollState();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadMessages, pollState]);

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

  // клавиатура: на Android adjustResize сам уменьшает окно, поэтому панель ввода
  // поднимается над клавиатурой без KeyboardAvoidingView (он давал двойной отступ).
  // iOS требует ручного отступа.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e: KeyboardEvent) =>
      setKbHeight(Platform.OS === "ios" ? e.endCoordinates.height : 0)
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
    setInput("");
    setError(null);
    // мгновенно показать своё сообщение (не ждём сервер)
    const shown: RenderPart[] = [];
    if (text) shown.push({ kind: "text", text });
    for (const a of attachments) shown.push({ kind: "file", label: a.filename, mime: a.mime, url: a.uri });
    setBubbles((prev) => [...prev, { key: `local-${Date.now()}`, role: "user", parts: shown }]);
    const files = attachments.map((a) => ({ url: a.uri, mime: a.mime, filename: a.filename }));
    setSending(true);
    try {
      // если агент чем-то занят — встанет в очередь (OpenCode delivery)
      await api.prompt(sessionID, text, busyRef.current ? "queue" : undefined, files.length > 0 ? files : undefined);
      setAttachments([]);
      await pollState();
      loadMessages();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setInput(text); // вернуть текст, чтобы не потерять
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
  const doRevert = (b: ChatBubble) => {
    if (!b.id) return;
    Alert.alert("Откатить чат?", "Все сообщения начиная с этого уйдут из контекста.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Откатить",
        style: "destructive",
        onPress: async () => {
          try {
            await api.revert(sessionID, b.id as string);
            await loadMessages();
            await pollState();
          } catch (e: any) {
            setError(e?.message ?? String(e));
          }
        },
      },
    ]);
  };

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

  const title = sessionTitle || directory.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "сессия";
  /** сколько секунд уже работает агент — для плашки «работает 12с» */
  const busySec = busy && busySince ? Math.max(1, Math.round((Date.now() - busySince) / 1000)) : 0;
  const statusText = perms.length > 0 ? "✋ ждёт твоего разрешения" : activity || "🧠 думает";

  // инвертированный список: показываем снизу вверх — скролл никогда не дёргается
  const reversed = useMemo(() => [...bubbles].reverse(), [bubbles]);

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

      {/* инфо-строка: модель / агент / статистика */}
      <View style={s.infoRow}>
        <Pressable style={s.chip} onPress={() => { loadModels(); setSheet("model"); }}>
          <Text style={s.chipText} numberOfLines={1}>🤖 {modelLabel} ▾</Text>
        </Pressable>
        <Pressable style={s.chip} onPress={() => { loadAgents(); setSheet("agent"); }}>
          <Text style={s.chipText} numberOfLines={1}>🧩 {agentLabel} ▾</Text>
        </Pressable>
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

      <FlatList
        data={reversed}
        inverted
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ paddingTop: spacing.l, paddingBottom: spacing.s }}
        ItemSeparatorComponent={() => <View style={{ height: spacing.s }} />}
        renderItem={({ item }) => {
          const isUser = item.role === "user";
          return (
            <View style={{ paddingHorizontal: spacing.l, flexDirection: "row", justifyContent: isUser ? "flex-end" : "flex-start" }}>
              <Pressable
                onLongPress={() => doRevert(item)}
                delayLongPress={400}
                style={[s.bubble, isUser ? s.bubbleUser : s.bubbleBot]}
              >
                {item.parts.map((p: RenderPart, i: number) => {
                  if (p.kind === "text") {
                    return (
                      <Text key={i} style={[s.bubbleText, isUser && { color: "#fff" }]}>
                        {p.text}
                      </Text>
                    );
                  }
                  if (p.kind === "tool") {
                    return (
                      <View key={i} style={s.toolLine}>
                        <Text style={s.toolText}>
                          {p.state === "running" ? "⚙ " : p.state === "completed" ? "✓ " : p.state === "error" ? "✗ " : "• "}
                          {p.label}
                          {p.state === "running" ? " …" : ""}
                        </Text>
                      </View>
                    );
                  }
                  if (p.kind === "file") {
                    const isImg = p.mime.startsWith("image/");
                    const src = p.url ?? (p.data ? `data:${p.mime};base64,${p.data}` : undefined);
                    return isImg && src ? (
                      <Image key={i} source={{ uri: src }} style={s.attachImg} resizeMode="cover" />
                    ) : (
                      <Text key={i} style={s.toolText}>
                        📎 {p.label}
                      </Text>
                    );
                  }
                  return (
                    <Text key={i} style={s.toolText}>
                      {p.label}
                    </Text>
                  );
                })}
              </Pressable>
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
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setSheet(null)}>
              <Text style={[s.btnText, { color: colors.text }]}>Закрыть</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

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
        <Pressable
          style={[s.sendBtn, (!input.trim() && attachments.length === 0) || sending ? { opacity: 0.4 } : null]}
          onPress={send}
          disabled={(!input.trim() && attachments.length === 0) || sending}
        >
          {sending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.sendText}>▶</Text>}
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
    </Animated.View>
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
  toolLine: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: 2,
    marginTop: spacing.xs,
    alignSelf: "flex-start",
  },
  toolText: { color: colors.textDim, fontSize: fontSize.s },
  attachImg: { width: 220, height: 165, borderRadius: 10, marginTop: spacing.xs },
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
    maxHeight: 120,
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
