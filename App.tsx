import React, { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Platform, Pressable, StatusBar as RNStatusBar, StyleSheet, Text, View } from "react-native";
import { AsyncStorage } from "./src/store";
import { OpenCodeApi, ServerKind } from "./src/api";
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
  const [saved, setSaved] = useState<{ url: string; password: string; repo?: string }>({
    url: "",
    password: "",
    repo: "",
  });

  useEffect(() => {
    (async () => {
      // мост Omnirush: адрес/пароль по умолчанию, в хранилище — только переопределение
      const omniUrl = (await AsyncStorage.get("omniUrl")) || DEFAULT_OMNI_URL;
      const omniPassword = (await AsyncStorage.get("omniPassword")) || DEFAULT_OMNI_PASSWORD;
      setOmniApi(new OpenCodeApi({ baseURL: omniUrl, password: omniPassword, flavor: "omnirush" }));

      const url = await AsyncStorage.get("url");
      const password = await AsyncStorage.get("password");
      const repo = await AsyncStorage.get("updateRepo");
      if (url && password) {
        setSaved({ url, password, repo });
        setApi(new OpenCodeApi({ baseURL: url, password }));
        setScreen("home");
      } else {
        setScreen("setup");
      }
    })();
  }, []);

  if (screen === null) return null;

  const saveAndUse = (url: string, password: string, repo = "") => {
    AsyncStorage.set("url", url);
    AsyncStorage.set("password", password);
    AsyncStorage.set("updateRepo", repo);
    setSaved({ url, password, repo });
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
          initialRepo={saved.repo}
          onSave={saveAndUse}
          onCancel={() => setScreen("home")}
        />
      </Root>
    );
  }

  const homeApi = tab === "omnirush" ? omniApi : api;
  const chatApi = chatTab === "omnirush" ? omniApi : api;

  return (
    <Root>
      {screen === "chat" && currentSession && chatApi ? (
        <ChatScreen
          api={chatApi}
          serverKind={chatTab}
          sessionID={currentSession.id}
          directory={currentSession.directory}
          onBack={() => setScreen("home")}
        />
      ) : homeApi ? (
        <View style={{ flex: 1 }}>
          {/* flexShrink: 0 — список не должен выдавливать таббар за границу экрана */}
          <View style={{ flex: 1, minHeight: 0, flexShrink: 1 }}>
            <HomeScreen
              key={tab}
              api={homeApi}
              serverKind={tab}
              onOpen={(sessionID, directory) => {
                setCurrentSession({ id: sessionID, directory });
                setChatTab(tab);
                setScreen("chat");
              }}
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
