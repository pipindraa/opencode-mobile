import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  BackHandler,
  ScrollView,
  Alert,
} from "react-native";
import Constants from "expo-constants";
import { OpenCodeApi } from "../api";
import { checkLatest, downloadAndInstall, isNewer } from "../updater";
import { colors, spacing, fontSize } from "../theme";

interface Props {
  initialURL: string;
  initialPassword: string;
  /** owner/repo на GitHub — откуда тянуть обновления */
  initialRepo?: string;
  onSave: (url: string, password: string, repo: string) => void;
  /** указан, когда открыли через ⚙ из списка сессий — тогда "назад" возвращает туда */
  onCancel?: () => void;
}

const APP_VERSION = String(Constants.expoConfig?.version ?? "0.0.0");

export default function SetupScreen({ initialURL, initialPassword, initialRepo, onSave, onCancel }: Props) {
  const [url, setURL] = useState(initialURL);
  const [password, setPassword] = useState(initialPassword);
  const [repo, setRepo] = useState(initialRepo ?? "");
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
      setTimeout(() => onSave(url.trim(), password.trim(), repo.trim()), 600);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setChecking(false);
    }
  };

  /** проверка обновлений: GitHub Releases → скачать APK → системный установщик */
  const checkUpdates = async () => {
    setError(null);
    setUpdateState(null);
    if (!repo.trim()) {
      setError("Укажи репозиторий обновлений (owner/repo)");
      return;
    }
    setUpdateBusy(true);
    try {
      const rel = await checkLatest(repo.trim());
      if (!rel) {
        setUpdateState(`Обновлений нет. Установлено ${APP_VERSION}.`);
        return;
      }
      if (!isNewer(rel.version, APP_VERSION)) {
        setUpdateState(`Обновлений нет. Установлено ${APP_VERSION}, последняя ${rel.version}.`);
        return;
      }
      setUpdateBusy(false);
      Alert.alert(
        `Обновление ${rel.version}`,
        (rel.notes || "Что нового — в описании релиза.") + `\n\nУстановлено: ${APP_VERSION}`,
        [
          { text: "Позже", style: "cancel" },
          {
            text: "Скачать",
            onPress: async () => {
              try {
                setUpdateBusy(true);
                setUpdateState("Скачиваю APK…");
                await downloadAndInstall(rel);
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
    <KeyboardAvoidingView style={s.wrap} behavior={Platform.OS === "android" ? undefined : "padding"}>
      {onCancel && (
        <Pressable style={s.back} onPress={onCancel}>
          <Text style={{ color: colors.accent, fontSize: fontSize.l }}>‹ Назад</Text>
        </Pressable>
      )}
      <ScrollView contentContainerStyle={{ paddingBottom: spacing.xl }}>
      <Text style={s.title}>OpenCode Remote</Text>
      <Text style={s.hint}>
        Введи адрес сервера OpenCode (через Tailscale) и пароль, который печатается при
        запуске {'`opencode serve`'}.
      </Text>

      <Text style={s.label}>Адрес сервера</Text>
      <TextInput
        style={s.input}
        value={url}
        onChangeText={setURL}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="http://100.125.84.47:4096"
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
        placeholder="yab22..."
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

      <View style={s.card}>
        <Text style={s.cardTitle}>Обновления</Text>
        <Text style={s.cardText}>Текущая версия: {APP_VERSION}</Text>
        <Text style={s.label}>Репозиторий на GitHub (owner/repo)</Text>
        <TextInput
          style={s.input}
          value={repo}
          onChangeText={setRepo}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="pipindraa/opencode-mobile"
          placeholderTextColor={colors.textDim}
        />
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
        {updateState ? <Text style={s.cardText}>{updateState}</Text> : null}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Подсказки</Text>
        <Text style={s.cardText}>{'• VPN Tailscale на телефоне должен быть включён'}</Text>
        <Text style={s.cardText}>{'• Пароль — из запуска "opencode serve" (строка "server password ...")'}</Text>
        <Text style={s.cardText}>{'• Если сервер перезапустить, пароль сменится — обнови его здесь'}</Text>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
    justifyContent: "center",
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: "700",
    marginBottom: spacing.m,
  },
  back: {
    position: "absolute",
    top: spacing.xl,
    left: spacing.xl,
  },
  hint: {
    color: colors.textDim,
    fontSize: fontSize.m,
    marginBottom: spacing.xl,
  },
  label: {
    color: colors.text,
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
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: spacing.m,
    marginTop: spacing.xl,
  },
  cardTitle: {
    color: colors.text,
    fontSize: fontSize.m,
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  cardText: {
    color: colors.textDim,
    fontSize: fontSize.s,
    marginBottom: spacing.xs,
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
