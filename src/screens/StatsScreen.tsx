import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { OpenCodeApi, ServerKind } from "../api";
import { colors, spacing, fontSize } from "../theme";
import { Ionicons } from "@expo/vector-icons";

/**
 * Экран «Расходы»: сколько output-токенов сожрал агент.
 * Сегменты День / Неделя:
 *  - день: навигация дат (‹ ›), output крупно, вход/размышление мелким,
 *    разбор по чатам (кто сколько сожрал);
 *  - неделя: 7 строк по дням, тап по дню → сегмент «День» на эту дату.
 *
 * Источник: v2-эндпоинт /api/experimental/session/stats (по дню — отдельные
 * вызовы). У Omnirush эндпоинта нет — считаем сами по сообщениям сессий.
 * Токены дня по чату: сообщения с time.created в пределах дня.
 */

interface Props {
  api: OpenCodeApi;
  serverKind: ServerKind;
  onBack: () => void;
}

type Seg = "day" | "week";

interface DayTotals {
  output: number;
  input: number;
  reasoning: number;
  cacheRead: number;
  cost: number;
  prompts: number;
}

interface ChatRow {
  id: string;
  title: string;
  directory: string;
  output: number;
}

const DAY_MS = 86400000;

function dayStartOf(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayLabel(ts: number): string {
  const now = Date.now();
  const diff = Math.round((dayStartOf(now) - dayStartOf(ts)) / DAY_MS);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return new Date(ts).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
}

function dayShort(ts: number): string {
  return new Date(ts).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "numeric" });
}

function fmtTok(n: any): string {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return Math.round(v / 1e3) + "k";
  return String(Math.round(v));
}

function fmtFull(n: any): string {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function fmtCost(c: any): string {
  const v = Number(c) || 0;
  if (v === 0) return "";
  return "$" + (v >= 1 ? v.toFixed(2) : v.toFixed(4));
}

export default function StatsScreen({ api, serverKind, onBack }: Props) {
  const [seg, setSeg] = useState<Seg>("day");
  const [dayTs, setDayTs] = useState<number>(() => dayStartOf(Date.now()));
  const [dayTotals, setDayTotals] = useState<DayTotals | null>(null);
  const [chatRows, setChatRows] = useState<ChatRow[] | null>(null);
  const [week, setWeek] = useState<DayTotals[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const todayStart = dayStartOf(Date.now());

  const dayStart = dayStartOf(dayTs);
  const dayEnd = dayStart + DAY_MS;

  /** output-токены по сообщениям сессии за [from, to) — разбор по чатам */
  const chatBreakdown = useCallback(
    async (from: number, to: number, limit = 10): Promise<ChatRow[]> => {
      const lists = await Promise.all([
        api.sessions(false, 200).catch(() => [] as any[]),
        api.omni ? Promise.resolve([] as any[]) : api.sessions(true, 200).catch(() => [] as any[]),
      ]);
      const seen = new Set<string>();
      const cands: { id: string; title: string; directory: string; timeCreated: number; timeUpdated: number }[] = [];
      for (const s of [...lists[0], ...lists[1]]) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        if (s.timeCreated <= to && s.timeUpdated >= from) cands.push(s);
      }
      cands.sort((a, b) => b.timeUpdated - a.timeUpdated);
      const rows: ChatRow[] = [];
      for (const s of cands.slice(0, limit)) {
        try {
          const msgs = await api.rawMessages(s.id, 500);
          let out = 0;
          for (const m of msgs) {
            const info = m?.info ?? m;
            const t = Number(info?.time?.created ?? 0) || 0;
            if (t >= from && t < to) out += Number(info?.tokens?.output ?? 0) || 0;
          }
          rows.push({ id: s.id, title: s.title, directory: s.directory, output: out });
        } catch {
          /* одна сессия не загрузилась — остальным верим */
        }
      }
      rows.sort((a, b) => b.output - a.output);
      return rows;
    },
    [api]
  );

  /** агрегаты дня: v2 — stats-эндпоинт, форк — суммируем по сообщениям */
  const loadDay = useCallback(
    async (from: number, to: number) => {
      setLoading(true);
      setError(null);
      setDayTotals(null);
      setChatRows(null);
      try {
        if (!api.omni) {
          const st: any = await api.sessionStats(from, to);
          setDayTotals({
            output: Number(st?.tokens?.output ?? 0) || 0,
            input: Number(st?.tokens?.input ?? 0) || 0,
            reasoning: Number(st?.tokens?.reasoning ?? 0) || 0,
            cacheRead: Number(st?.tokens?.cache?.read ?? 0) || 0,
            cost: Number(st?.cost ?? 0) || 0,
            prompts: Number(st?.prompts ?? 0) || 0,
          });
        }
        const rows = await chatBreakdown(from, to);
        setChatRows(rows);
        if (api.omni) {
          const sum = rows.reduce((acc, r) => acc + r.output, 0);
          setDayTotals((prev) => prev ?? { output: sum, input: 0, reasoning: 0, cacheRead: 0, cost: 0, prompts: 0 });
          // у форка входные токены не считаем — только то, что просили (output)
        }
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    },
    [api, chatBreakdown]
  );

  /** неделя: v2 — 7 stats-вызовов по дню; форк — один проход по сообщениям */
  const loadWeek = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWeek(null);
    try {
      const start = dayStartOf(Date.now()) - 6 * DAY_MS;
      if (!api.omni) {
        const days: DayTotals[] = [];
        for (let i = 0; i < 7; i++) {
          const from = start + i * DAY_MS;
          const to = from + DAY_MS;
          try {
            const st: any = await api.sessionStats(from, to);
            days.push({
              output: Number(st?.tokens?.output ?? 0) || 0,
              input: Number(st?.tokens?.input ?? 0) || 0,
              reasoning: 0,
              cacheRead: 0,
              cost: Number(st?.cost ?? 0) || 0,
              prompts: Number(st?.prompts ?? 0) || 0,
            });
          } catch {
            days.push({ output: 0, input: 0, reasoning: 0, cacheRead: 0, cost: 0, prompts: 0 });
          }
        }
        setWeek(days);
        return;
      }
      // форк: сообщения сессий недели → по дням
      const lists = await Promise.all([
        api.sessions(false, 200).catch(() => [] as any[]),
        api.sessions(true, 200).catch(() => [] as any[]),
      ]);
      const seen = new Set<string>();
      const cands = [...lists[0], ...lists[1]].filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return s.timeUpdated >= start;
      });
      cands.sort((a, b) => b.timeUpdated - a.timeUpdated);
      const days: DayTotals[] = Array.from({ length: 7 }, () => ({
        output: 0,
        input: 0,
        reasoning: 0,
        cacheRead: 0,
        cost: 0,
        prompts: 0,
      }));
      for (const s of cands.slice(0, 15)) {
        try {
          const msgs = await api.rawMessages(s.id, 500);
          for (const m of msgs) {
            const info = m?.info ?? m;
            const t = Number(info?.time?.created ?? 0) || 0;
            const idx = Math.floor((t - start) / DAY_MS);
            if (idx >= 0 && idx < 7) days[idx].output += Number(info?.tokens?.output ?? 0) || 0;
          }
        } catch {
          /* пропускаем */
        }
      }
      setWeek(days);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (seg === "day") loadDay(dayStart, dayEnd);
    else loadWeek();
  }, [seg, dayTs, loadDay, loadWeek, dayStart, dayEnd]);

  const openDay = (ts: number) => {
    setDayTs(ts);
    setSeg("day");
  };

  const maxWeek = week ? Math.max(1, ...week.map((d) => d.output)) : 1;
  /** старт недели для строк (пересчитывается каждый рендер — не дрейфует за полночь) */
  const startWeek = dayStartOf(Date.now()) - 6 * DAY_MS;

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Pressable style={s.back} onPress={onBack} hitSlop={12}>
          <View style={s.backRow}>
            <Ionicons name="chevron-back" size={20} color={colors.accent} />
            <Text style={s.backText}>Назад</Text>
          </View>
        </Pressable>
        <Text style={s.title}>Расходы</Text>
        <View style={s.back} />
      </View>

      {/* сегменты */}
      <View style={s.segRow}>
        {(["day", "week"] as Seg[]).map((x) => (
          <Pressable key={x} style={[s.segBtn, seg === x && s.segBtnOn]} onPress={() => setSeg(x)}>
            <Text style={[s.segText, seg === x && s.segTextOn]}>{x === "day" ? "День" : "Неделя"}</Text>
          </Pressable>
        ))}
      </View>

      {seg === "day" && (
        <View style={s.dateRow}>
          <Pressable
            style={s.dateNav}
            hitSlop={8}
            disabled={dayStart <= todayStart - 365 * DAY_MS}
            onPress={() => setDayTs((p) => p - DAY_MS)}
          >
            <Ionicons name="chevron-back" size={20} color={colors.textDim} />
          </Pressable>
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={s.dateLabel}>{dayLabel(dayTs)}</Text>
          </View>
          <Pressable
            style={s.dateNav}
            hitSlop={8}
            disabled={dayStart >= todayStart}
            onPress={() => setDayTs((p) => Math.min(p + DAY_MS, todayStart))}
          >
            <Ionicons name="chevron-forward" size={20} color={dayStart >= todayStart ? colors.border : colors.textDim} />
          </Pressable>
        </View>
      )}

      {error && (
        <View style={s.errRow}>
          <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
          <Text style={s.err}>{error}</Text>
        </View>
      )}

      {loading && !dayTotals && !week ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl * 2 }} />
      ) : seg === "day" ? (
        <View style={{ flex: 1 }}>
          {dayTotals && (
            <View style={s.totCard}>
              <Text style={s.totLabel}>Output-токены за день</Text>
              <Text style={s.totBig}>{fmtFull(dayTotals.output)}</Text>
              <Text style={s.totSub}>
                вход {fmtTok(dayTotals.input)} · размышление {fmtTok(dayTotals.reasoning)}
                {dayTotals.cacheRead > 0 ? ` · кэш ${fmtTok(dayTotals.cacheRead)}` : ""}
                {dayTotals.prompts > 0 ? ` · ${dayTotals.prompts} запрос(ов)` : ""}
              </Text>
              {dayTotals.cost > 0 && (
                <Text style={s.totCost}>{fmtCost(dayTotals.cost)}</Text>
              )}
            </View>
          )}

          <Text style={s.secHdr}>По чатам</Text>
          <FlatList
            data={chatRows ?? []}
            keyExtractor={(r) => r.id}
            ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
            ListEmptyComponent={
              <Text style={s.empty}>
                {chatRows == null
                  ? "Считаю по сообщениям…"
                  : "Этот день в чатах не было output-токенов (или история не подгружается)."}
              </Text>
            }
            renderItem={({ item }) => (
              <View style={s.chatRow}>
                <View style={{ flex: 1, paddingRight: spacing.m }}>
                  <Text style={s.chatTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={s.chatDir} numberOfLines={1}>
                    {item.directory || "(нет пути)"}
                  </Text>
                </View>
                <Text style={s.chatTok}>{fmtTok(item.output)}</Text>
              </View>
            )}
          />
        </View>
      ) : (
        <FlatList
          data={(week ?? []).map((d, i) => ({ ...d, key: String(startWeek + i * DAY_MS), ts: startWeek + i * DAY_MS }))}
          keyExtractor={(r) => r.key}
          ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
          ListEmptyComponent={<Text style={s.empty}>Неделя ещё пустая.</Text>}
          renderItem={({ item }) => (
            <Pressable style={s.weekRow} onPress={() => openDay(item.ts)}>
              <View style={{ flex: 1, paddingRight: spacing.m }}>
                <Text style={[s.chatTitle, item.ts === todayStart && { color: colors.accent }]}>
                  {dayShort(item.ts)}
                  {item.ts === todayStart ? " · сегодня" : ""}
                </Text>
                <View style={s.weekBarBg}>
                  <View style={[s.weekBar, { width: `${Math.round((item.output / maxWeek) * 100)}%` }]} />
                </View>
              </View>
              <Text style={[s.chatTok, item.ts === todayStart && { color: colors.accent }]}>{fmtTok(item.output)}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
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
  backRow: { flexDirection: "row", alignItems: "center", gap: 2 },
  backText: { color: colors.accent, fontSize: fontSize.l },
  title: { color: colors.text, fontSize: fontSize.l, fontWeight: "700", textAlign: "center", flex: 1 },
  segRow: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 3,
    marginHorizontal: spacing.l,
  },
  segBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    borderRadius: 8,
  },
  segBtnOn: { backgroundColor: colors.accent },
  segText: { color: colors.textDim, fontWeight: "600", fontSize: fontSize.s },
  segTextOn: { color: "#fff", fontWeight: "700" },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.l,
    marginTop: spacing.m,
    marginBottom: spacing.xs,
  },
  dateNav: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  dateLabel: { color: colors.text, fontSize: fontSize.m, fontWeight: "700", textTransform: "capitalize" },
  errRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginHorizontal: spacing.l,
    marginTop: spacing.xs,
  },
  err: { color: colors.danger, fontSize: fontSize.s, flex: 1 },
  totCard: {
    marginHorizontal: spacing.l,
    marginTop: spacing.m,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: spacing.l,
    alignItems: "center",
  },
  totLabel: { color: colors.textDim, fontSize: fontSize.s, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  totBig: { color: colors.text, fontSize: 40, fontWeight: "800", marginTop: spacing.xs },
  totSub: { color: colors.textDim, fontSize: fontSize.s, marginTop: spacing.s, textAlign: "center" },
  totCost: { color: colors.warn, fontSize: fontSize.m, fontWeight: "700", marginTop: spacing.xs },
  secHdr: {
    color: colors.textDim,
    fontSize: fontSize.s,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginHorizontal: spacing.l,
    marginTop: spacing.l,
    marginBottom: spacing.xs,
  },
  chatRow: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginHorizontal: spacing.l,
    flexDirection: "row",
    alignItems: "center",
  },
  chatTitle: { color: colors.text, fontSize: fontSize.m, fontWeight: "600" },
  chatDir: { color: colors.textDim, fontSize: fontSize.s, marginTop: 2 },
  chatTok: { color: colors.accent, fontSize: fontSize.l, fontWeight: "800" },
  weekRow: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginHorizontal: spacing.l,
    flexDirection: "row",
    alignItems: "center",
  },
  weekBarBg: {
    height: 6,
    backgroundColor: colors.bg,
    borderRadius: 3,
    marginTop: spacing.s,
    overflow: "hidden",
  },
  weekBar: { height: 6, backgroundColor: colors.accent, borderRadius: 3 },
  empty: {
    color: colors.textDim,
    fontSize: fontSize.m,
    textAlign: "center",
    marginTop: spacing.xl,
    marginHorizontal: spacing.xl,
  },
});
