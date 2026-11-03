import React, { useEffect, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Platform, Pressable, StatusBar as RNStatusBar, StyleSheet, Text, View } from "react-native";
import { AsyncStorage } from "./src/store";
import { OpenCodeApi, ServerKind, basicAuthHeader } from "./src/api";
import { events, BusEvent } from "./src/events";
import { initNotifications, notify, onTapped } from "./src/notifications";
import SetupScreen from "./src/screens/SetupScreen";
import HomeScreen from "./src/screens/HomeScreen";
import ChatScreen from "./src/screens/ChatScreen";
import { colors, spacing, fontSize } from "./src/theme";

type Screen = "setup" | "home" | "chat";

const DEFAULT_URL = "http://100.125.84.47:4097";
const DEFAULT_OMNI_URL = "http://100.125.84.47:4099";
const DEFAULT_OMNI_PASSWORD = "KaTvSEPUXxycMPmmL1vz4P2bg5EZRIm9";

export default function App() {
  const [screen, setScreen] = useState<Screen | null>(null); // null = грузимся
  const [tab, setTab] = useState<ServerKind>("opencode");
  const [api, setApi] = useState<OpenCodeApi | null>(null); // сервер OpenCode
  const [omniApi, setOmniApi] = useState<OpenCodeApi | null>(null); // мост Omnirush
  const [currentSession, setCurrentSession] = useState<{ id: string; directory: string } | null>(null);
  const [chatTab, setChatTab] = useState<ServerKind>("opencode");
  const [saved, setSaved] = useState<{ url: string; password: string }>({
    url: "",
    password: "",
  });
  // — статусы сессий для кружков на списке (сервер OpenCode, из SSE-потока) —
  const [unread, setUnread] = useState<Set<string>>(new Set()); // синяя точка: закончилось, пока чат был закрыт
  const unreadRef = useRef<Set<string>>(new Set()); // источник истины (без сайд-эффектов в updater'ах)
  const [errors, setErrors] = useState<Set<string>>(new Set()); // красная точка: была ошибка
  const [titles, setTitles] = useState<Record<string, string>>({}); // свежие имена из session.renamed
  const curSessionRef = useRef<string | null>(null); // id открытого чата (null — на списке)

  const applyUnread = (next: Set<string>) => {
    unreadRef.current = next;
    setUnread(next);
    AsyncStorage.saveUnread("opencode", [...next]);
  };

  useEffect(() => {
    (async () => {
      // мост Omnirush: адрес/пароль по умолчанию, в хранилище — только переопределение
      const omniUrl = (await AsyncStorage.get("omniUrl")) || DEFAULT_OMNI_URL;
      const omniPassword = (await AsyncStorage.get("omniPassword")) || DEFAULT_OMNI_PASSWORD;
      setOmniApi(new OpenCodeApi({ baseURL: omniUrl, password: omniPassword, flavor: "omnirush" }));

      const url = await AsyncStorage.get("url");
      const password = await AsyncStorage.get("password");
      if (url && password) {
        setSaved({ url, password });
        setApi(new OpenCodeApi({ baseURL: url, password }));
        setScreen("home");
      } else {
        setScreen("setup");
      }
    })();
  }, []);

  // живой поток событий OpenCode (SSE): запускаем, пока выбран сервер OpenCode.
  // Для Omnirush-форка события не запускаем — там остаётся поллинг.
  useEffect(() => {
    if (!api) return;
    events.start(api.base, basicAuthHeader(api.cfg.password));
    return () => events.stop();
  }, [api]);

  // синие точки: восстановили сохранённые «непрочитанные» при старте
  useEffect(() => {
    if (!api) return;
    AsyncStorage.getUnread("opencode").then((ids) => {
      const s = new Set(ids);
      unreadRef.current = s;
      setUnread(s);
    });
  }, [api]);

  /** отметить сессию прочитанной (открыли чат / тап по уведомлению) */
  const markRead = (sid: string) => {
    if (!unreadRef.current.has(sid)) {
      setErrors((prev) => (prev.has(sid) ? new Set([...prev].filter((x) => x !== sid)) : prev));
      return;
    }
    const next = new Set(unreadRef.current);
    next.delete(sid);
    applyUnread(next);
    setErrors((prev) => (prev.has(sid) ? new Set([...prev].filter((x) => x !== sid)) : prev));
  };

  /**
   * Де-дуп уведомлений: сервер может прислать завершение дважды за один ран
   * (session.execution.succeeded + session.idle), ошибку — тоже (execution.failed
   * + session.error). В течение 5с на сессию (и тип) баннер только один;
   * два реальных рана подряд (финиш >5с спустя) оба простучат.
   */
  const lastNotifyAt = useRef<Record<string, number>>({});
  const notifyOnce = (key: string): boolean => {
    const now = Date.now();
    if (now - (lastNotifyAt.current[key] ?? 0) < 5_000) return false;
    lastNotifyAt.current[key] = now;
    return true;
  };

  // глобальные события → кружки на списке + уведомления.
  // «Чат открыт» (curSessionRef) — там изменения и так видны, баннерами не шумим.
  useEffect(() => {
    if (!api) return;
    const off = events.subscribe((e: BusEvent) => {
      const sid = (e as { sessionID?: string }).sessionID;
      if (!sid) return;
      const chatOpen = curSessionRef.current === sid;
      switch (e.kind) {
        case "renamed":
          setTitles((prev) => (prev[sid] === e.title ? prev : { ...prev, [sid]: e.title }));
          break;
        case "finished":
          if (e.outcome === "success" && !chatOpen) {
            const next = new Set(unreadRef.current);
            next.add(sid);
            applyUnread(next);
            // название для строки уведомления — догоняем с сервера (best effort);
            // succeeded+idle приходят парой — баннер только с первого
            if (notifyOnce("done:" + sid)) {
              api.sessionInfo(sid)
                .then((s) => notify("✅ Готово", (s?.title ? String(s.title) : "чат") + " — агент закончил", { sessionID: sid }))
                .catch(() => notify("✅ Готово", "агент закончил работу", { sessionID: sid }));
            }
          }
          break;
        case "error":
          setErrors((prev) => {
            const next = new Set(prev);
            next.add(sid);
            return next;
          });
          if (!chatOpen && notifyOnce("err:" + sid)) {
            const body = (e.message ?? "ошибка").slice(0, 140);
            api.sessionInfo(sid)
              .then((s) => notify("⛔ Ошибка", (s?.title ? String(s.title) + " — " : "") + body, { sessionID: sid }))
              .catch(() => notify("⛔ Ошибка", body, { sessionID: sid }));
          }
          break;
        case "permission":
          // агент ждёт разрешения — уведомление важно всегда (пользователь мог уйти в другое приложение)
          const r = e.request;
          const res = r.resources && r.resources[0] ? " " + r.resources[0].slice(0, 80) : "";
          if (notifyOnce("perm:" + r.id)) {
            api.sessionInfo(sid)
              .then((s) => notify("✋ Нужно разрешение", (s?.title ? String(s.title) + " — " : "") + r.action + res, { sessionID: sid }))
              .catch(() => notify("✋ Нужно разрешение", r.action + res, { sessionID: sid }));
          }
          break;
        default:
          break;
      }
    });
    return () => {
      off();
    };
  }, [api]);

  // уведомления включаем один раз при появлении сервера OpenCode
  useEffect(() => {
    if (!api) return;
    initNotifications();
  }, [api]);

  // тап по уведомлению → открыть сессию (hot + cold start)
  useEffect(() => {
    if (!api) return;
    return onTapped((data) => {
      const sid = data.sessionID;
      if (!sid) return;
      (async () => {
        const s = await api.sessionInfo(sid).catch(() => null);
        curSessionRef.current = sid;
        setCurrentSession({ id: sid, directory: s?.directory ? String(s.directory) : "" });
        setChatTab("opencode");
        setTab("opencode");
        setScreen("chat");
        markRead(sid);
      })();
    });
  }, [api]);

  if (screen === null) return null;

  const saveAndUse = (url: string, password: string) => {
    AsyncStorage.set("url", url);
    AsyncStorage.set("password", password);
    setSaved({ url, password });
    setApi(new OpenCodeApi({ baseURL: url, password }));
    setScreen("home");
  };

  if (!api) {
    // первый запуск — настроек ещё нет, назад нет куда идти
    return (
      <Root>
        <SetupScreen initialURL={DEFAULT_URL} initialPassword="" onSave={saveAndUse} />
      </Root>
    );
  }

  if (screen === "setup") {
    // открыт через ⚙ — назад к списку сессий, форма со спасёнными значениями
    return (
      <Root>
        <SetupScreen
          initialURL={saved.url || DEFAULT_URL}
          initialPassword={saved.password}
          onSave={saveAndUse}
          onCancel={() => setScreen("home")}
        />
      </Root>
    );
  }

  const homeApi = tab === "omnirush" ? omniApi : api;
  const chatApi = chatTab === "omnirush" ? omniApi : api;

  // открыть чат: запоминаем «какой открыт» (события не должны дублировать баннерами) и снимаем точки
  const openChat = (sessionID: string, directory: string, kind: ServerKind) => {
    curSessionRef.current = sessionID;
    setCurrentSession({ id: sessionID, directory });
    setChatTab(kind);
    setScreen("chat");
    markRead(sessionID);
  };
  const closeChat = () => {
    curSessionRef.current = null;
    setCurrentSession(null);
    setScreen("home");
  };

  return (
    <Root>
      {screen === "chat" && currentSession && chatApi ? (
        <ChatScreen
          api={chatApi}
          serverKind={chatTab}
          sessionID={currentSession.id}
          directory={currentSession.directory}
          onBack={closeChat}
        />
      ) : homeApi ? (
        <View style={{ flex: 1 }}>
          {/* flexShrink: 0 — список не должен выдавливать таббар за границу экрана */}
          <View style={{ flex: 1, minHeight: 0, flexShrink: 1 }}>
            <HomeScreen
              key={tab}
              api={homeApi}
              serverKind={tab}
              unread={tab === "opencode" ? unread : undefined}
              errors={tab === "opencode" ? errors : undefined}
              titles={tab === "opencode" ? titles : undefined}
              onOpen={(sessionID, directory) => openChat(sessionID, directory, tab)}
              onSettings={tab === "opencode" ? () => setScreen("setup") : undefined}
            />
          </View>
          <TabBar tab={tab} onChange={setTab} />
        </View>
      ) : null}
    </Root>
  );
}

function TabBar({ tab, onChange }: { tab: ServerKind; onChange: (t: ServerKind) => void }) {
  const tabs: { id: ServerKind; label: string }[] = [
    { id: "opencode", label: "OpenCode" },
    { id: "omnirush", label: "Omnirush" },
  ];
  return (
    <View style={t.wrap}>
      {tabs.map((x) => (
        <Pressable key={x.id} style={[t.btn, tab === x.id && t.btnOn]} onPress={() => onChange(x.id)}>
          <Text style={[t.txt, tab === x.id && t.txtOn]}>{x.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const t = StyleSheet.create({
  // высота фиксированным числом: minHeight+fleXShrink в Yoga не всегда считает размер,
  // и таббар схлопывается в 0 (виден в дампе как [0,0][0,0])
  wrap: {
    flexDirection: "row",
    height: 64,
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  btn: { flex: 1, alignItems: "center", justifyContent: "center" },
  btnOn: { backgroundColor: colors.surface2 },
  txt: { color: colors.textDim, fontSize: fontSize.m, fontWeight: "600" },
  txtOn: { color: colors.text, fontWeight: "700" },
});

function Root({ children }: { children: React.ReactNode }) {
  // приложение рисуется edge-to-edge (на телефоне header уходил под часы и инпут под
  // навбар), поэтому сами отступаем от системных панелей
  const top = Platform.OS === "android" ? RNStatusBar.currentHeight ?? 0 : 44;
  return (
    <>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: top, paddingBottom: Platform.OS === "android" ? 24 : 0 }}>
        {children}
      </View>
    </>
  );
}
