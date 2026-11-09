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
  Switch,
  Modal,
} from "react-native";
import Constants from "expo-constants";
import { Ionicons } from "@expo/vector-icons";
import { OpenCodeApi } from "../api";
import { monitor } from "../monitor";
import { checkLatest, downloadAndInstall, isNewer, UPDATE_REPO } from "../updater";
import { colors, spacing, fontSize } from "../theme";
import { AsyncStorage } from "../store";

interface Props {
  initialURL: string;
  initialPassword: string;
  onSave: (url: string, password: string, repo: string) => void;
  /** указан, когда открыли через кнопку настроек из списка сессий — тогда "назад" возвращает туда */
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
  // — фоновый монитор: нативная WorkManager-цепочка, переживает убийство приложения —
  const [monOn, setMonOn] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  const [monErr, setMonErr] = useState<string | null>(null);
  // — быстрые фразы: общие для обоих серверов, чипы над полем ввода в чате —
  const [phrases, setPhrases] = useState<string[]>([]);
  const [phraseEdit, setPhraseEdit] = useState(false);
  const [phraseDraft, setPhraseDraft] = useState("");

  const DEFAULT_PHRASES = ["что сделал", "продолжай", "проверь ошибки", "подведи итог"];

  // при открытии настроек подгружаем сохранённые фразы (пусто → дефолты)
  useEffect(() => {
    AsyncStorage.getQuickPhrases().then((p) => setPhrases(p.length > 0 ? p : DEFAULT_PHRASES));
  }, []);

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

  // состояние монитора при открытии настроек (работал до рестарта — WorkManager помнит)
  useEffect(() => {
    monitor.isRunning().then(setMonOn);
  }, []);

  const toggleMonitor = async () => {
    setMonErr(null);
    if (!monitor.available()) {
      setMonErr("Монитор недоступен в этой сборке");
      return;
    }
    const on = !monOn;
    setMonBusy(true);
    try {
      if (on) {
        if (!url.trim() || !password.trim()) {
          setMonErr("Сначала введи адрес и пароль сервера");
          return;
        }
        // монитор пока только для сервера OpenCode (у форка свой статусный эндпоинт)
        const ok = await monitor.start(url.trim(), password.trim(), "opencode");
        setMonOn(ok);
        if (!ok) setMonErr("Не удалось запустить монитор — попробуй ещё раз");
      } else {
        const ok = await monitor.stop();
        setMonOn(!ok);
        if (!ok) setMonErr("Не удалось остановить монитор");
      }
    } finally {
      setMonBusy(false);
    }
  };

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
          <View style={s.backRow}>
            <Ionicons name="chevron-back" size={20} color={colors.accent} />
            <Text style={s.backText}>Назад</Text>
          </View>
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
            <View style={s.ghostRow}>
              <Ionicons name="cloud-download-outline" size={18} color={colors.text} />
              <Text style={s.btnGhostText}>Проверить обновления</Text>
            </View>
          )}
        </Pressable>
        {updateState ? <Text style={s.meta}>{updateState}</Text> : null}

        <View style={s.divider} />

        <Text style={s.section}>Фоновый монитор</Text>
        <Text style={s.meta}>
          Когда приложение убито, фоновый сервис раз в минуту спрашивает сервер OpenCode и присылает
          уведомление, когда агент закончил сессию. Пока приложение открыто — баннеры показывает сам чат.
        </Text>
        <View style={s.monRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.monText}>Мониторить сервер OpenCode</Text>
          </View>
          {monBusy ? (
            <ActivityIndicator size="small" color={colors.textDim} />
          ) : (
            <Switch
              value={monOn}
              onValueChange={toggleMonitor}
              trackColor={{ false: colors.surface2, true: colors.accent }}
              thumbColor="#fff"
            />
          )}
        </View>
        {monErr ? <Text style={s.err}>{monErr}</Text> : null}

        <View style={s.divider} />

        <Text style={s.section}>Быстрые фразы</Text>
        <Text style={s.meta}>
          Готовые ответы-чипы над полем ввода в чате (общие для обоих серверов). Тап по чипу
          дописывает фразу к сообщению.
        </Text>
        <View style={s.phraseList}>
          {phrases.length === 0 ? (
            <Text style={s.meta}>Фраз не задано.</Text>
          ) : (
            phrases.map((p, i) => (
              <View key={i} style={s.phraseItem}>
                <Ionicons name="chatbubble-ellipses-outline" size={15} color={colors.textDim} />
                <Text style={s.phraseItemText} numberOfLines={1}>
                  {p}
                </Text>
              </View>
            ))
          )}
        </View>
        <Pressable
          style={({ pressed }) => [s.btnGhost, pressed && { opacity: 0.85 }]}
          onPress={() => {
            setPhraseDraft(phrases.join("\n"));
            setPhraseEdit(true);
          }}
        >
          <View style={s.ghostRow}>
            <Ionicons name="create-outline" size={18} color={colors.text} />
            <Text style={s.btnGhostText}>Редактировать фразы</Text>
          </View>
        </Pressable>
      </ScrollView>

      {/* быстрые фразы: редактор (по одной на строку) */}
      <Modal visible={phraseEdit} transparent animationType="slide" onRequestClose={() => setPhraseEdit(false)}>
        <View style={s.overlay}>
          <View style={s.phraseModal}>
            <Text style={s.sheetTitle}>Быстрые фразы</Text>
            <Text style={s.hint}>
              По одной фразе на строку (до 12). Тап по чипу над полем ввода в чате дописывает фразу
              к сообщению. Чтобы удалить фразу — убери её строку.
            </Text>
            <TextInput
              style={[s.input, { height: 150, textAlignVertical: "top" }]}
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
  backRow: { flexDirection: "row", alignItems: "center", gap: 2 },
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
  ghostRow: { flexDirection: "row", alignItems: "center", gap: spacing.s },
  monRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.m,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.m,
    gap: spacing.m,
  },
  monText: { color: colors.text, fontSize: fontSize.m, fontWeight: "600" },
  phraseList: {
    marginTop: spacing.m,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.xs,
    gap: 2,
  },
  phraseItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s,
    paddingVertical: 8,
  },
  phraseItemText: { color: colors.text, fontSize: fontSize.m, flex: 1 },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  phraseModal: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: spacing.xl,
    gap: spacing.s,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: fontSize.l,
    fontWeight: "700",
  },
  hint: {
    color: colors.textDim,
    fontSize: fontSize.s,
  },
});
