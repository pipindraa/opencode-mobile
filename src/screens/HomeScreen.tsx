import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
  Linking,
} from "react-native";
import { OpenCodeApi, ServerKind } from "../api";
import { AsyncStorage } from "../store";
import { colors, spacing, fontSize } from "../theme";

/** ID RustDesk на ноутбуке (меняется только при переустановке клиента) */
const RUSTDESK_ID = "28440006";

interface Props {
  api: OpenCodeApi;
  /** какой сервер показываем — влияет на заголовок, избранное и список папок */
  serverKind: ServerKind;
  onOpen: (sessionID: string, directory: string) => void;
  /** ⚙ настройки — только для сервера OpenCode */
  onSettings?: () => void;
}

interface SessionItem {
  id: string;
  title: string;
  directory: string;
  active: boolean;
  timeCreated: number;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function timeLabel(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export default function HomeScreen({ api, serverKind, onOpen, onSettings }: Props) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [projects, setProjects] = useState<{ directory: string; title: string }[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  const [favs, setFavs] = useState<Set<string>>(new Set());

  // избранное чатов этого сервера — живёт только на телефоне
  useEffect(() => {
    (async () => {
      const ids = await AsyncStorage.getChatFavs(serverKind).catch(() => [] as string[]);
      setFavs(new Set(ids));
    })();
  }, [serverKind]);

  const toggleFav = async (id: string) => {
    const next = new Set(favs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavs(next);
    try {
      await AsyncStorage.saveChatFavs(serverKind, [...next]);
    } catch {
      /* ignore */
    }
  };

  const openRustDesk = () => {
    Linking.openURL(`rustdesk://connection/new/${RUSTDESK_ID}`).catch(() => {
      // RustDesk не установлен на телефоне — откроем страницу релиза APK
      Linking.openURL("https://github.com/rustdesk/rustdesk/releases");
    });
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, activeIDs, perms] = await Promise.all([
        api.sessions(),
        api.sessionsActive().catch(() => [] as string[]),
        api.pendingPermissions().catch(() => [] as any[]),
      ]);
      const activeSet = new Set(activeIDs);
      const list: SessionItem[] = s.map((x) => ({
        ...x,
        active: activeSet.has(x.id),
      }));
      // сначала активные, дальше по свежести
      list.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.timeCreated - a.timeCreated;
      });
      setSessions(list);
      setActiveCount(perms.length);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const openCreate = async () => {
    setCreating(true);
    setProjectsLoading(true);
    try {
      const list = await api.projects();
      setProjects(list);
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  };

  const createIn = async (directory: string) => {
    setCreating(false);
    setLoading(true);
    try {
      const s = await api.createSession(directory);
      const id = s?.id;
      if (id) onOpen(String(id), directory);
      else load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setLoading(false);
    }
  };

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Text style={s.title}>{serverKind === "omnirush" ? "Чаты Omnirush" : "Сессии OpenCode"}</Text>
        <View style={s.headerBtns}>
          {activeCount > 0 && (
            <View style={[s.badge, { borderColor: colors.warn }]}>
              <Text style={{ color: colors.warn, fontSize: fontSize.s }}>
                ✋ {activeCount}
              </Text>
            </View>
          )}
          <Pressable style={s.iconBtn} onPress={openRustDesk}>
            <Text style={{ color: colors.text, fontSize: fontSize.l }}>🖥</Text>
          </Pressable>
          <Pressable style={s.iconBtn} onPress={openCreate}>
            <Text style={s.iconBtnText}>＋</Text>
          </Pressable>
          {onSettings && (
            <Pressable style={s.iconBtn} onPress={onSettings}>
              <Text style={{ color: colors.text, fontSize: fontSize.l }}>⚙</Text>
            </Pressable>
          )}
        </View>
      </View>

      {error && (
        <Pressable onPress={load}>
          <Text style={s.err}>⚠ {error} (нажми — повторит)</Text>
        </Pressable>
      )}

      {loading && sessions.length === 0 ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : (
        <FlatList
          data={(() => {
            const rows: ({ kind: "h"; key: string; label: string } | { kind: "s"; key: string; item: SessionItem })[] = [];
            // избранное — закреплено сверху отдельной секцией (как у моделей)
            const favsList = sessions.filter((it) => favs.has(it.id));
            if (favsList.length > 0) {
              rows.push({ kind: "h", key: "h_favs", label: "★ Избранное" });
              for (const it of favsList) rows.push({ kind: "s", key: it.id, item: it });
            }
            let last = "";
            for (const it of sessions) {
              if (favs.has(it.id)) continue;
              const label = dayLabel(it.timeCreated);
              if (label !== last) {
                last = label;
                rows.push({ kind: "h", key: "h_" + label, label });
              }
              rows.push({ kind: "s", key: it.id || String(rows.length), item: it });
            }
            return rows;
          })()}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.accent} />
          }
          contentContainerStyle={{ paddingBottom: spacing.xl }}
          ItemSeparatorComponent={() => <View style={{ height: spacing.s }} />}
          renderItem={({ item }) => {
            if (item.kind === "h") {
              return <Text style={s.dayHdr}>{item.label}</Text>;
            }
            const it = item.item;
            const isFav = favs.has(it.id);
            return (
              <Pressable
                style={[s.card, { flexDirection: "row", alignItems: "center" }]}
                onPress={() => onOpen(it.id, it.directory)}
              >
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.s }}>
                    <Text style={[s.cardTitle, { flex: 1 }]} numberOfLines={1}>
                      {isFav ? "★ " : ""}{it.active ? "🟢 " : ""}
                      {it.title}
                    </Text>
                    <Text style={s.timeTxt}>{timeLabel(it.timeCreated)}</Text>
                  </View>
                  <Text style={s.cardDir} numberOfLines={1}>
                    {it.directory || "(нет пути)"}
                  </Text>
                </View>
                <Pressable hitSlop={10} style={{ paddingLeft: spacing.m }} onPress={() => toggleFav(it.id)}>
                  <Text style={{ color: isFav ? "#f5b73e" : colors.textDim, fontSize: fontSize.xl }}>
                    {isFav ? "★" : "☆"}
                  </Text>
                </Pressable>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={s.empty}>
              {serverKind === "omnirush"
                ? "Чатов пока нет. Нажми ＋ чтобы создать.\n\nЧаты из TUI Omnirush на ноуте появятся здесь автоматически."
                : "Сессий пока нет. Нажми ＋ чтобы создать.\n\nСессии, созданные в TUI на ноуте, тоже появятся здесь после обновления."}
            </Text>
          }
        />
      )}

      <Modal visible={creating} transparent animationType="slide">
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={s.title}>Новая сессия в папке…</Text>
            {projectsLoading ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <>
                <FlatList
                  data={projects}
                  keyExtractor={(item) => item.directory}
                  style={{ maxHeight: 300 }}
                  ItemSeparatorComponent={() => <View style={{ height: spacing.s }} />}
                  renderItem={({ item }) => (
                    <Pressable style={s.card} onPress={() => createIn(item.directory)}>
                      <Text style={s.cardTitle}>{item.title}</Text>
                      <Text style={s.cardDir} numberOfLines={1}>{item.directory}</Text>
                    </Pressable>
                  )}
                  ListEmptyComponent={<Text style={s.empty}>Проектов не найдено — создай их в TUI</Text>}
                />
                <Text style={s.cardDir}>
                  {serverKind === "omnirush"
                    ? "Папки берутся из твоих чатов Omnirush на ноуте."
                    : "Список папок берётся из проектов, открытых в OpenCode на ноуте."}
                </Text>
              </>
            )}
            <Pressable style={[s.btn, s.btnRow]} onPress={() => setCreating(false)}>
              <Text style={s.btnText}>Отмена</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, paddingTop: spacing.xl },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.l,
    marginBottom: spacing.m,
  },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: "700", flex: 1 },
  headerBtns: { flexDirection: "row", alignItems: "center", gap: spacing.s },
  badge: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: spacing.xs,
  },
  iconBtn: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtnText: { color: colors.text, fontSize: fontSize.xl },
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
  dayHdr: {
    color: colors.accent,
    fontSize: fontSize.s,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginHorizontal: spacing.l,
    marginTop: spacing.m,
    marginBottom: spacing.xs,
  },
  timeTxt: { color: colors.textDim, fontSize: fontSize.s },
  empty: {
    color: colors.textDim,
    fontSize: fontSize.m,
    textAlign: "center",
    marginTop: spacing.xl * 2,
    marginHorizontal: spacing.xl,
  },
  err: {
    color: colors.danger,
    fontSize: fontSize.s,
    marginHorizontal: spacing.l,
    marginBottom: spacing.s,
  },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    alignItems: "center",
    paddingVertical: 14,
  },
  btnRow: { marginTop: spacing.l },
  btnText: { color: "#fff", fontSize: fontSize.l, fontWeight: "600" },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modal: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.l,
    maxHeight: "85%",
  },
});
