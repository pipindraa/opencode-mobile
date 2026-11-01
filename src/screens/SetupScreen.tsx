import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  BackHandler,
  ScrollView,
  Alert,
} from "react-native";
import Constants from "expo-constants";
import { OpenCodeApi } from "../api";
import { checkLatest, downloadAndInstall, isNewer, UPDATE_REPO } from "../updater";
import { colors, spacing, fontSize } from "../theme";

interface Props {
  initialURL: string;
  initialPassword: string;
  onSave: (url: string, password: string, repo: string) => void;
  /** указан, когда открыли через ⚙ из списка сессий — тогда "назад" возвращает туда */
  onCancel?: () => void;
}

const APP_VERSION = String(Constants.expoConfig?.version ?? "0.0.0");

export default function SetupScreen({ initialURL, initialPassword, onSave, onCancel }: Props) {
  const [url, setURL] = useState(initialURL);
  const [password, setPassword] = useState(initialPassword);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  // Android "назад" — назад к списку сессий, а не выход из приложения
  useEffect(() => {
    if (!onCancel) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onCancel();
      return true;
    });
    return () => sub.remove();
  }, [onCancel]);

  // проверяем обновления сами при открытии настроек — нажимать ничего не нужно
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rel = await checkLatest(UPDATE_REPO);
        if (!alive) return;
        if (rel && isNewer(rel.version, APP_VERSION)) {
          setUpdateState(`Доступна версия ${rel.version} — нажми «Обновить»`);
        }
      } catch {
        /* нет сети — молчим, кнопка проверит вручную */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const connect = async () => {
    setError(null);
    setOk(null);
    if (!url.trim() || !password.trim()) {
      setError("Заполни адрес и пароль");
      return;
    }
    setChecking(true);
    try {
      const api = new OpenCodeApi({ baseURL: url.trim(), password: password.trim() });
      const info = await api.info();
      setOk(`Подключено: OpenCode v${info?.version ?? "?"}`);
      setTimeout(() => onSave(url.trim(), password.trim(), UPDATE_REPO), 600);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setChecking(false);
    }
  };

  /** обновление: GitHub Releases → скачать APK → системный установщик */
  const checkUpdates = async () => {
    setError(null);
    setUpdateState(null);
    setUpdateBusy(true);
    try {
      const rel = await checkLatest(UPDATE_REPO);
      if (!rel || !isNewer(rel.version, APP_VERSION)) {
        setUpdateState(
          rel
            ? `Установлена последняя версия ${APP_VERSION}`
            : `Установлена версия ${APP_VERSION}`
        );
        return;
      }
      setUpdateBusy(false);
      Alert.alert(
        `Доступна версия ${rel.version}`,
        `${rel.notes || "Что нового — в описании релиза."}\n\nУ вас установлена ${APP_VERSION}`,
        [
          { text: "Позже", style: "cancel" },
          {
            text: "Обновить",
            onPress: async () => {
              try {
                setUpdateBusy(true);
                setUpdateState("Скачиваю 0%");
                await downloadAndInstall(rel, (p) =>
                  setUpdateState(p < 0 ? "Скачиваю…" : `Скачиваю ${Math.round(p * 100)}%`)
                );
                setUpdateState("Открыл установщик — подтверди установку");
              } catch (e: any) {
                setError(e?.message ?? String(e));
              } finally {
                setUpdateBusy(false);
              }
            },
          },
        ]
      );
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setUpdateBusy(false);
    }
  };

  return (
    <View style={s.wrap}>
      {onCancel && (
        <Pressable style={s.back} onPress={onCancel} hitSlop={12}>
          <Text style={s.backText}>‹ Назад</Text>
        </Pressable>
      )}
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.title}>Настройки</Text>

        <Text style={s.label}>Адрес сервера</Text>
        <TextInput
          style={s.input}
          value={url}
          onChangeText={setURL}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://100.125.84.47:4097"
          placeholderTextColor={colors.textDim}
        />

        <Text style={s.label}>Пароль сервера</Text>
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="пароль из opencode serve"
          placeholderTextColor={colors.textDim}
        />

        <Pressable
          style={({ pressed }) => [s.btn, pressed && { opacity: 0.85 }]}
          onPress={connect}
          disabled={checking}
        >
          {checking ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.btnText}>Подключиться</Text>
          )}
        </Pressable>

        {ok ? <Text style={s.ok}>{ok}</Text> : null}
        {error ? <Text style={s.err}>{error}</Text> : null}

        <View style={s.divider} />

        <Text style={s.section}>Обновления</Text>
        <Text style={s.meta}>Установлена версия {APP_VERSION}</Text>
        <Pressable
          style={({ pressed }) => [s.btnGhost, pressed && { opacity: 0.85 }]}
          onPress={checkUpdates}
          disabled={updateBusy}
        >
          {updateBusy ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={s.btnGhostText}>Проверить обновления</Text>
          )}
        </Pressable>
        {updateState ? <Text style={s.meta}>{updateState}</Text> : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl * 2,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: "700",
    marginBottom: spacing.l,
  },
  back: {
    position: "absolute",
    top: spacing.m,
    left: spacing.m,
    zIndex: 10,
  },
  backText: { color: colors.accent, fontSize: fontSize.l },
  label: {
    color: colors.textDim,
    fontSize: fontSize.s,
    marginBottom: spacing.xs,
    marginTop: spacing.m,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.m,
    paddingVertical: 12,
    color: colors.text,
    fontSize: fontSize.m,
  },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    marginTop: spacing.xl,
  },
  btnText: {
    color: "#fff",
    fontSize: fontSize.l,
    fontWeight: "600",
  },
  ok: {
    color: colors.ok,
    marginTop: spacing.m,
    textAlign: "center",
  },
  err: {
    color: colors.danger,
    marginTop: spacing.m,
    textAlign: "center",
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginTop: spacing.xl,
    marginBottom: spacing.l,
  },
  section: {
    color: colors.text,
    fontSize: fontSize.l,
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  meta: {
    color: colors.textDim,
    fontSize: fontSize.s,
    marginTop: spacing.s,
  },
  btnGhost: {
    backgroundColor: colors.surface2,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 12,
    marginTop: spacing.m,
  },
  btnGhostText: { color: colors.text, fontSize: fontSize.m, fontWeight: "600" },
});
