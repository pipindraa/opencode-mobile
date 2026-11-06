import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Alert,
  PanResponder,
  Animated,
} from "react-native";
import { OpenCodeApi, ServerKind } from "../api";
import { AsyncStorage } from "../store";
import { colors, spacing, fontSize } from "../theme";
import { Ionicons } from "@expo/vector-icons";

/** ID RustDesk на ноутбуке (меняется только при переустановке клиента) */
const RUSTDESK_ID = "28440006";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

type Filter = "all" | "active" | "closed" | "archived";

interface Props {
  api: OpenCodeApi;
  /** какой сервер показываем — влияет на заголовок, избранное и список папок */
  serverKind: ServerKind;
  /** сервер на связи? false — показываем индикатор (пинг из App) */
  conn?: boolean;
  onOpen: (sessionID: string, directory: string) => void;
  /** настройки — только для сервера OpenCode */
  onSettings?: () => void;
  /** экран «Расходы» (статистика токенов) */
  onOpenStats?: () => void;
  /** синие точки: закончилось, пока чат был закрыт (сервер OpenCode, из SSE) */
  unread?: Set<string>;
  /** красные точки: была ошибка */
  errors?: Set<string>;
  /** свежие названия из session.renamed (пока поллинг не обновило) */
  titles?: Record<string, string>;
}

interface SessionItem {
  id: string;
  title: string;
  directory: string;
  active: boolean;
  timeCreated: number;
  timeUpdated: number;
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

/**
 * Карточка с свайпом влево: слева… нет, справа (куда ушла карточка)
 * открывается фоновое действие «В архив» / «Вернуть». Долгий тап по карточке
 * — меню (переименовать/архив/удалить). Тап по открытой карточке — закрыть свайп.
 */
interface SwipeAction {
  label: string;
  icon: IconName;
  color: string;
}

const ACTION_W = 120;
const SWIPE_THRESH = 60;

function SwipeRow({
  apiRef,
  action,
  onAction,
  children,
}: {
  apiRef: React.MutableRefObject<{ open: () => boolean; close: () => void } | null>;
  action: SwipeAction;
  onAction: () => void;
  children: React.ReactNode;
}) {
  const openRef = useRef(false);
  const offRef = useRef(0);
  const dx = useRef(new Animated.Value(0)).current;

  const close = useCallback(() => {
    openRef.current = false;
    offRef.current = 0;
    Animated.spring(dx, { toValue: 0, useNativeDriver: true }).start();
  }, [dx]);

  useEffect(() => {
    apiRef.current = { open: () => openRef.current, close };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, close]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // горизонтальный жест побеждает вертикальный скролл списка
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) < 30 && Math.abs(g.dx) > 8,
        onPanResponderMove: (_e, g) => {
          const base = openRef.current ? -ACTION_W : 0;
          const v = Math.max(-ACTION_W, Math.min(0, base + g.dx));
          offRef.current = v;
          dx.setValue(v);
        },
        onPanResponderRelease: (_e, g) => {
          if (offRef.current < -SWIPE_THRESH || g.dx < -SWIPE_THRESH || g.vx < -0.5) {
            openRef.current = true;
            offRef.current = -ACTION_W;
            Animated.spring(dx, { toValue: -ACTION_W, useNativeDriver: true }).start();
            onAction();
          } else {
            close();
          }
        },
      }),
    [close, dx, onAction]
  );

  return (
    <View>
      {/* фоновое действие: за карточкой, справа (туда уходит карточка при свайпе влево) */}
      <Pressable
        style={{
          position: "absolute",
          right: spacing.l,
          top: 0,
          bottom: 0,
          width: ACTION_W,
          backgroundColor: action.color,
          borderRadius: 12,
          justifyContent: "center",
          alignItems: "center",
        }}
        onPress={() => {
          close();
          onAction();
        }}
      >
        <Ionicons name={action.icon} size={20} color="#fff" />
        <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600", marginTop: 2 }}>{action.label}</Text>
      </Pressable>
      {/* карточка поверх: сдвигается влево, открывая действие */}
      <Animated.View style={{ transform: [{ translateX: dx }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

function SessionRow({
  it,
  title,
  status,
  isFav,
  swipeAction,
  onOpen,
  onLongPress,
  onFav,
  onAction,
}: {
  it: SessionItem;
  title: string;
  status: React.ReactNode;
  isFav: boolean;
  swipeAction: SwipeAction | null;
  onOpen: () => void;
  onLongPress?: () => void;
  onFav: () => void;
  onAction: () => void;
}) {
  const swipeApi = useRef<{ open: () => boolean; close: () => void } | null>(null);
  const card = (
    <Pressable
      style={[s.card, { flexDirection: "row", alignItems: "center" }]}
      onPress={() => {
        // открыт свайп — первый тап закрывает его, не уводит в чат
        if (swipeApi.current?.open()) {
          swipeApi.current.close();
          return;
        }
        onOpen();
      }}
      onLongPress={onLongPress}
    >
      {status}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <Text style={[s.cardTitle, { flex: 1 }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={s.timeTxt}>{timeLabel(it.timeCreated)}</Text>
        </View>
        <Text style={s.cardDir} numberOfLines={1}>
          {it.directory || "(нет пути)"}
        </Text>
      </View>
      <Pressable hitSlop={10} style={{ paddingLeft: spacing.m }} onPress={onFav}>
        <Ionicons name={isFav ? "star" : "star-outline"} size={22} color={isFav ? "#f5b73e" : colors.textDim} />
      </Pressable>
    </Pressable>
  );
  if (!swipeAction) return card;
  return (
    <SwipeRow apiRef={swipeApi} action={swipeAction} onAction={onAction}>
      {card}
    </SwipeRow>
  );
}

export default function HomeScreen({ api, serverKind, conn, onOpen, onSettings, onOpenStats, unread, errors, titles }: Props) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [projects, setProjects] = useState<{ directory: string; title: string }[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  /** поиск по названию и папке */
  const [q, setQ] = useState("");
  /** фильтр списка: все / активные / закрытые / архив (архив — только OpenCode) */
  const [filter, setFilter] = useState<Filter>("all");
  /** «только что закончилось» по поллингу (для Omnirush, где нет SSE; для OpenCode — страховка) */
  const [justDone, setJustDone] = useState<Set<string>>(new Set());
  const prevActiveRef = useRef<Set<string> | null>(null);
  // — меню карточки (долгий тап): переименовать / архив / удалить —
  const [menuFor, setMenuFor] = useState<SessionItem | null>(null);
  const [renaming, setRenaming] = useState<SessionItem | null>(null);
  const [renameText, setRenameText] = useState("");
  const [busyAction, setBusyAction] = useState(false);

  const isUnread = (id: string) => (unread?.has(id) ?? false) || justDone.has(id);

  const filtered = useMemo(() => {
    let list = sessions;
    if (filter === "active") list = list.filter((x) => x.active);
    else if (filter === "closed") list = list.filter((x) => !x.active);
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((x) => (x.title + " " + x.directory).toLowerCase().includes(needle));
    return list;
  }, [sessions, q, filter]);

  // при смене сервера сбрасываем фильтр (архив у Omnirush не существует)
  useEffect(() => {
    setFilter("all");
  }, [serverKind]);

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
      const archived = serverKind === "opencode" && filter === "archived";
      const [s, activeIDs, perms] = await Promise.all([
        api.sessions(archived),
        api.sessionsActive().catch(() => [] as string[]),
        api.pendingPermissions().catch(() => [] as any[]),
      ]);
      const activeSet = new Set(activeIDs);
      // смена active → finished: отмечаем «только что закончилось» (синяя точка)
      if (prevActiveRef.current && !archived) {
        for (const id of prevActiveRef.current) {
          if (!activeSet.has(id)) setJustDone((prev) => new Set(prev).add(id));
        }
      }
      if (!archived) prevActiveRef.current = activeSet;
      const list: SessionItem[] = s.map((x) => ({
        ...x,
        active: activeSet.has(x.id),
      }));
      if (archived) {
        // в архиве свежие (по дате последнего изменения) сверху
        list.sort((a, b) => b.timeUpdated - a.timeUpdated);
      } else {
        // сначала активные, дальше по свежести
        list.sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          return b.timeCreated - a.timeCreated;
        });
      }
      setSessions(list);
      setActiveCount(perms.length);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, serverKind, filter]);

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

  // ————— действия карточки (только сервер OpenCode — у форка их нет) —————

  const toggleArchive = async (it: SessionItem, archived: boolean) => {
    setBusyAction(true);
    try {
      await api.setArchived(it.id, archived);
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusyAction(false);
    }
  };

  const doRename = async () => {
    if (!renaming) return;
    const t = renameText.trim();
    if (!t) return;
    setBusyAction(true);
    try {
      await api.renameSession(renaming.id, t);
      setRenaming(null);
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusyAction(false);
    }
  };

  const askDelete = (it: SessionItem) => {
    Alert.alert("Удалить сессию?", `«${it.title}» и вся её история будут удалены. Вернуть не получится.`, [
      { text: "Отмена", style: "cancel" },
      {
        text: "Удалить",
        style: "destructive",
        onPress: async () => {
          setMenuFor(null);
          setBusyAction(true);
          try {
            await api.deleteSession(it.id);
            await load();
          } catch (e: any) {
            setError(e?.message ?? String(e));
          } finally {
            setBusyAction(false);
          }
        },
      },
    ]);
  };

  const swipeAction: SwipeAction | null =
    serverKind === "opencode"
      ? filter === "archived"
        ? { label: "Вернуть", icon: "archive-outline", color: colors.accentDark }
        : { label: "В архив", icon: "archive-outline", color: colors.danger }
      : null;

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Text style={s.title}>{serverKind === "omnirush" ? "Чаты Omnirush" : "Сессии OpenCode"}</Text>
        <View style={s.headerBtns}>
          {conn === false && (
            <View style={[s.badge, { borderColor: colors.danger }]}>
              <Ionicons name="cloud-offline-outline" size={14} color={colors.danger} />
              <Text style={[s.badgeText, { color: colors.danger }]}>нет связи</Text>
            </View>
          )}
          {activeCount > 0 && (
            <View style={[s.badge, { borderColor: colors.warn }]}>
              <Ionicons name="alert-circle-outline" size={14} color={colors.warn} />
              <Text style={[s.badgeText, { color: colors.warn }]}>{activeCount}</Text>
            </View>
          )}
          {onOpenStats && (
            <Pressable style={s.iconBtn} onPress={onOpenStats}>
              <Ionicons name="stats-chart-outline" size={20} color={colors.text} />
            </Pressable>
          )}
          <Pressable style={s.iconBtn} onPress={openRustDesk}>
            <Ionicons name="desktop-outline" size={22} color={colors.text} />
          </Pressable>
          <Pressable style={s.iconBtn} onPress={openCreate}>
            <Ionicons name="add" size={24} color={colors.text} />
          </Pressable>
          {onSettings && (
            <Pressable style={s.iconBtn} onPress={onSettings}>
              <Ionicons name="settings-outline" size={22} color={colors.text} />
            </Pressable>
          )}
        </View>
      </View>

      {error && (
        <Pressable onPress={load} style={s.errRow}>
          <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
          <Text style={s.err}>{error} (нажми — повторит)</Text>
        </Pressable>
      )}

      {/* фильтр: Все / Активные / Закрытые / Архив (архив — только OpenCode) */}
      <View style={s.filterRow}>
        {(
          [
            ["all", "Все"],
            ["active", "Активные"],
            ["closed", "Закрытые"],
            ...(serverKind === "opencode" ? ([["archived", "Архив"]] as [Filter, string][]) : []),
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <Pressable key={f} style={[s.filterChip, filter === f && s.filterChipOn]} onPress={() => setFilter(f)}>
            <Text style={[s.filterText, filter === f && s.filterTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {/* поиск по названию и папке сессии */}
      <View style={s.searchWrap}>
        <Ionicons name="search-outline" size={16} color={colors.textDim} />
        <TextInput
          style={s.searchInput}
          value={q}
          onChangeText={setQ}
          placeholder="Поиск по сессиям…"
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {q.length > 0 && (
          <Pressable hitSlop={10} onPress={() => setQ("")}>
            <Ionicons name="close" size={15} color={colors.textDim} />
          </Pressable>
        )}
      </View>

      {loading && sessions.length === 0 ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : (
        <FlatList
          data={(() => {
            const rows: ({ kind: "h"; key: string; label: string; fav?: boolean } | { kind: "s"; key: string; item: SessionItem })[] = [];
            // избранное — закреплено сверху отдельной секцией (как у моделей)
            const favsList = filtered.filter((it) => favs.has(it.id));
            if (favsList.length > 0) {
              rows.push({ kind: "h", key: "h_favs", label: "Избранное", fav: true });
              for (const it of favsList) rows.push({ kind: "s", key: it.id, item: it });
            }
            let last = "";
            for (const it of filtered) {
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
              return item.fav ? (
                <View style={s.favHdrRow}>
                  <Ionicons name="star" size={13} color="#f5b73e" />
                  <Text style={s.dayHdr}>{item.label}</Text>
                </View>
              ) : (
                <Text style={s.dayHdr}>{item.label}</Text>
              );
            }
            const it = item.item;
            const isFav = favs.has(it.id);
            // статус-кружок: работает (спиннер) > ошибка (красная) > непрочитано (синяя)
            const status = it.active ? (
              <ActivityIndicator size="small" color={colors.accent} style={s.statusDot} />
            ) : errors?.has(it.id) ? (
              <View style={[s.statusDot, { backgroundColor: colors.danger }]} />
            ) : isUnread(it.id) ? (
              <View style={[s.statusDot, { backgroundColor: colors.accent }]} />
            ) : null;
            return (
              <SessionRow
                it={it}
                title={titles?.[it.id] ?? it.title}
                status={status}
                isFav={isFav}
                swipeAction={swipeAction}
                onOpen={() => {
                  setJustDone((prev) => (prev.has(it.id) ? new Set([...prev].filter((x) => x !== it.id)) : prev));
                  onOpen(it.id, it.directory);
                }}
                onLongPress={serverKind === "opencode" ? () => setMenuFor(it) : undefined}
                onFav={() => toggleFav(it.id)}
                onAction={() => toggleArchive(it, filter !== "archived")}
              />
            );
          }}
          ListEmptyComponent={
            <Text style={s.empty}>
              {filter === "archived"
                ? "Архив пуст. Свайпни карточку влево — сессия уйдёт сюда."
                : serverKind === "omnirush"
                ? "Чатов пока нет. Нажми «+» вверху, чтобы создать.\n\nЧаты из TUI Omnirush на ноуте появятся здесь автоматически."
                : "Сессий пока нет. Нажми «+» вверху, чтобы создать.\n\nСессии, созданные в TUI на ноуте, тоже появятся здесь после обновления."}
            </Text>
          }
        />
      )}

      {/* меню карточки: долгий тап (только OpenCode — у форка нет архива/переименования/удаления) */}
      <Modal visible={menuFor !== null} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
        <Pressable style={s.overlay} onPress={() => setMenuFor(null)}>
          <View style={s.modal}>
            <Text style={s.title} numberOfLines={2}>{menuFor ? (titles?.[menuFor.id] ?? menuFor.title) : ""}</Text>
            {menuFor && (
              <>
                <Pressable
                  style={s.menuRow}
                  onPress={() => {
                    const it = menuFor;
                    setMenuFor(null);
                    setRenameText(titles?.[it.id] ?? it.title);
                    setRenaming(it);
                  }}
                >
                  <View style={s.menuRowIcon}>
                    <Ionicons name="pencil-outline" size={17} color={colors.text} />
                    <Text style={s.menuRowText}>Переименовать</Text>
                  </View>
                </Pressable>
                <Pressable
                  style={s.menuRow}
                  disabled={busyAction}
                  onPress={() => {
                    const it = menuFor;
                    setMenuFor(null);
                    toggleArchive(it, filter !== "archived");
                  }}
                >
                  <View style={s.menuRowIcon}>
                    <Ionicons name="archive-outline" size={17} color={colors.text} />
                    <Text style={s.menuRowText}>{filter === "archived" ? "Вернуть из архива" : "В архив"}</Text>
                  </View>
                </Pressable>
                <Pressable
                  style={s.menuRow}
                  disabled={busyAction}
                  onPress={() => {
                    const it = menuFor;
                    askDelete(it);
                  }}
                >
                  <View style={s.menuRowIcon}>
                    <Ionicons name="trash-outline" size={17} color={colors.danger} />
                    <Text style={[s.menuRowText, { color: colors.danger }]}>Удалить</Text>
                  </View>
                </Pressable>
              </>
            )}
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setMenuFor(null)}>
              <Text style={[s.btnText, { color: colors.text }]}>Отмена</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* переименование */}
      <Modal visible={renaming !== null} transparent animationType="slide" onRequestClose={() => setRenaming(null)}>
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={s.title}>Новое название</Text>
            <TextInput
              style={s.searchInput}
              value={renameText}
              onChangeText={setRenameText}
              placeholder="название сессии"
              placeholderTextColor={colors.textDim}
              autoCapitalize="sentences"
              autoFocus
            />
            <Pressable style={s.btn} onPress={doRename} disabled={busyAction || !renameText.trim()}>
              {busyAction ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Сохранить</Text>}
            </Pressable>
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setRenaming(null)}>
              <Text style={[s.btnText, { color: colors.text }]}>Отмена</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

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
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.s,
    paddingVertical: spacing.xs,
  },
  badgeText: { fontSize: fontSize.s, fontWeight: "700" },
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
  filterRow: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.l,
    marginBottom: spacing.s,
  },
  filterChip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing.m,
    paddingVertical: 7,
  },
  filterChipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterText: { color: colors.textDim, fontSize: fontSize.s, fontWeight: "600" },
  filterTextOn: { color: "#fff", fontWeight: "700" },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: spacing.l,
    marginBottom: spacing.m,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.m,
    gap: spacing.s,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.m,
    paddingVertical: 10,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: spacing.s,
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
  favHdrRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  timeTxt: { color: colors.textDim, fontSize: fontSize.s },
  empty: {
    color: colors.textDim,
    fontSize: fontSize.m,
    textAlign: "center",
    marginTop: spacing.xl * 2,
    marginHorizontal: spacing.xl,
  },
  errRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginHorizontal: spacing.l, marginBottom: spacing.s },
  err: {
    color: colors.danger,
    fontSize: fontSize.s,
    flex: 1,
  },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    alignItems: "center",
    paddingVertical: 14,
  },
  btnRow: { marginTop: spacing.l },
  btnText: { color: "#fff", fontSize: fontSize.l, fontWeight: "600" },
  btnGhost: { backgroundColor: colors.surface2, marginTop: spacing.m },
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
  menuRow: {
    backgroundColor: colors.surface2,
    borderRadius: 12,
    paddingHorizontal: spacing.m,
    paddingVertical: 14,
    marginBottom: spacing.xs,
  },
  menuRowIcon: { flexDirection: "row", alignItems: "center", gap: 10 },
  menuRowText: { color: colors.text, fontSize: fontSize.m, fontWeight: "600" },
});
