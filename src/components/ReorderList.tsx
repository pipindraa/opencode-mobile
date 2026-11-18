import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  ScrollView,
  Vibration,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";

/**
 * Вертикальный список с перетаскиванием за ручку.
 *
 * Почему так, а не «переставлять массив по ходу»: если переставлять массив на
 * каждом свопе, строка прыгает в новый слот и её приходится компенсировать
 * translateY — получаются рывки и дрожание. Здесь массив НЕ меняется до
 * отпускания: тащимая строка едет за пальцем (translateY = смещение пальца),
 * остальные съезжают на её высоту плавной анимацией, освобождая слот. На
 * отпускании массив переставляется ровно один раз, все смещения обнуляются в
 * том же кадре — визуально ничего не прыгает.
 *
 * Порог: драг считается начатым только после смещения > ACT_THRESHOLD, поэтому
 * обычный тап по ручке ничего не меняет (и не пишет в хранилище).
 *
 * Автоскролл: если палец у верхнего/нижнего края контейнера — контейнер
 * прокручивается, а база отсчёта корректируется, чтобы строка оставалась под
 * пальцем. Нужны scrollRef + getScrollInfo (родитель знает свой scrollY).
 */
const ACT_THRESHOLD = 4;

export interface ReorderScrollInfo {
  /** текущий scrollY контейнера */
  y: number;
  /** высота видимой области */
  height: number;
  /** pageY верхней границы контейнера на экране */
  top: number;
}

export function ReorderList<T>({
  items,
  keyOf,
  renderItem,
  onReorder,
  gap = 8,
  rowStyle,
  scrollTo,
  getScrollInfo,
  onDragChange,
  autoScrollEdge = 80,
  autoScrollStep = 12,
}: {
  items: T[];
  keyOf: (item: T) => string;
  renderItem: (
    item: T,
    ctx: {
      /** привязать к ручке (широкая зона — на совести рендерера) */
      handleProps: any;
      dragging: boolean;
      /** true, если строку реально тащат (а не просто коснулись) */
      active: boolean;
      index: number;
    }
  ) => React.ReactNode;
  onReorder: (items: T[]) => void;
  gap?: number;
  rowStyle?: ViewStyle;
  /** контейнер для автоскролла */
  scrollTo?: (y: number) => void;
  /** как узнать scrollY/высоту/верх контейнера (родитель обновляет в onScroll) */
  getScrollInfo?: () => ReorderScrollInfo | null;
  /** начало/конец перетаскивания (родитель может отключить скролл) */
  onDragChange?: (dragging: boolean) => void;
  autoScrollEdge?: number;
  autoScrollStep?: number;
}) {
  const [order, setOrder] = useState<T[]>(items);
  const [dragKey, setDragKey] = useState<string | null>(null);
  /** true — строка реально тащится (прошли порог), а не просто коснулись */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** индекс слота, в который строка встанет при отпускании */
  const [slot, setSlot] = useState(-1);

  const orderRef = useRef<T[]>(items);
  const dragKeyRef = useRef<string | null>(null);
  const fromRef = useRef(-1);
  const slotRef = useRef(-1);
  const heights = useRef<Map<string, number>>(new Map());
  const baseY = useRef(0);
  const activeRef = useRef(false);
  const dy = useRef(new Animated.Value(0)).current;
  const shifts = useRef<Map<string, Animated.Value>>(new Map());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoDir = useRef(0);
  const lastScrollY = useRef(0);
  /** отмена анимации отката при новом драге */
  const rollbackToken = useRef(0);

  // свежие пропсы/колбэки для стабильного PanResponder
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  const gapRef = useRef(gap);
  gapRef.current = gap;
  const scrollToRef = useRef(scrollTo);
  scrollToRef.current = scrollTo;
  const infoRef = useRef(getScrollInfo);
  infoRef.current = getScrollInfo;
  const dragChangeRef = useRef(onDragChange);
  dragChangeRef.current = onDragChange;
  const edgeRef = useRef(autoScrollEdge);
  edgeRef.current = autoScrollEdge;
  const stepRef = useRef(autoScrollStep);
  stepRef.current = autoScrollStep;

  const shiftOf = (k: string) => {
    let v = shifts.current.get(k);
    if (!v) {
      v = new Animated.Value(0);
      shifts.current.set(k, v);
    }
    return v;
  };

  /** Y верха каждой строки в текущем порядке */
  const topsOf = (arr: T[]) => {
    const tops: number[] = [];
    let top = 0;
    for (const it of arr) {
      tops.push(top);
      top += (heights.current.get(keyOfRef.current(it)) ?? 0) + gapRef.current;
    }
    return tops;
  };

  // внешние изменения состава (добавили/убрали избранное) — применяем вне драга;
  // сравнение по ключам: родитель считает список инлайн (новая ссылка каждый рендер)
  useEffect(() => {
    if (dragKeyRef.current) return;
    const cur = orderRef.current;
    const same =
      items.length === cur.length &&
      items.every((it, i) => keyOfRef.current(it) === keyOfRef.current(cur[i]));
    if (!same) {
      orderRef.current = items;
      setOrder(items);
      shifts.current.forEach((v) => v.setValue(0));
    }
  }, [items]);

  const stopAuto = () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    autoDir.current = 0;
  };

  useEffect(() => () => stopAuto(), []);

  /** автоскролл у краёв + коррекция базы, чтобы строка оставалась под пальцем */
  const tickAuto = (pageY: number) => {
    const info = infoRef.current?.();
    const scroll = scrollToRef.current;
    if (!info || !scroll) return;
    const e = edgeRef.current;
    let dir = 0;
    if (pageY < info.top + e) dir = -1;
    else if (pageY > info.top + info.height - e) dir = 1;
    if (dir === 0) {
      if (timer.current) stopAuto();
      return;
    }
    if (dir === autoDir.current && timer.current) return;
    stopAuto();
    autoDir.current = dir;
    lastScrollY.current = info.y;
    timer.current = setInterval(() => {
      const i2 = infoRef.current?.();
      if (!i2) return;
      const next = Math.max(0, lastScrollY.current + autoDir.current * stepRef.current);
      const d = next - lastScrollY.current;
      if (d === 0) return; // упёрлись в край
      lastScrollY.current = next;
      // контент уехал на d → компенсируем базу, иначе строка «оторвётся» от пальца
      baseY.current -= d;
      const key = dragKeyRef.current;
      if (key) {
        const off = fingerY.current - baseY.current;
        dy.setValue(off);
        recomputeSlot(off);
      }
      scroll(next);
    }, 16);
  };

  const fingerY = useRef(0);

  /** пересчёт слота по смещению + плавный сдвиг соседей */
  const recomputeSlot = (offset: number) => {
    const key = dragKeyRef.current;
    if (!key) return;
    const cur = orderRef.current;
    const from = fromRef.current;
    if (from < 0 || from >= cur.length) return;
    const tops = topsOf(cur);
    const hFrom = heights.current.get(key) ?? 0;
    const center = tops[from] + offset + hFrom / 2;
    let best = from;
    let bestD = Infinity;
    for (let j = 0; j < cur.length; j++) {
      const kj = keyOfRef.current(cur[j]);
      const c = tops[j] + (heights.current.get(kj) ?? 0) / 2;
      const d = Math.abs(c - center);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best === slotRef.current) return;
    slotRef.current = best;
    setSlot(best);
    // соседи: освобождают/занимают место ровно на высоту тащимого + gap
    const delta = hFrom + gapRef.current;
    for (let i = 0; i < cur.length; i++) {
      if (i === from) continue;
      const k = keyOfRef.current(cur[i]);
      let target = 0;
      if (from < best && i > from && i <= best) target = -delta;
      else if (from > best && i >= best && i < from) target = delta;
      Animated.timing(shiftOf(k), {
        toValue: target,
        duration: 140,
        useNativeDriver: true,
      }).start();
    }
  };

  const finish = (commit: boolean) => {
    stopAuto();
    const key = dragKeyRef.current;
    const from = fromRef.current;
    const to = slotRef.current;
    const cur = orderRef.current;
    dragKeyRef.current = null;
    fromRef.current = -1;
    slotRef.current = -1;
    const wasActive = activeRef.current;
    activeRef.current = false;
    setSlot(-1);
    if (!key) {
      setDragKey(null);
      setActiveKey(null);
      return;
    }
    dragChangeRef.current?.(false);

    const changed = commit && wasActive && to >= 0 && to < cur.length && to !== from;
    if (!changed) {
      // откат: строка плавно возвращается в свой слот, соседи — на места.
      // dragKey/activeKey снимаем ТОЛЬКО по окончании анимации, иначе строка
      // мгновенно прыгнет в исходное положение (и будет выглядеть как рывок).
      setActiveKey(null);
      shifts.current.forEach((v) =>
        Animated.timing(v, { toValue: 0, duration: 130, useNativeDriver: true }).start()
      );
      const token = ++rollbackToken.current;
      Animated.timing(dy, { toValue: 0, duration: 130, useNativeDriver: true }).start(({ finished }) => {
        // откат отменён новым драгом — не трогаем состояние
        if (!finished || rollbackToken.current !== token) return;
        setDragKey(null);
      });
      return;
    }
    setDragKey(null);
    setActiveKey(null);
    const next = [...cur];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    orderRef.current = next;
    // снимаем смещения в том же кадре, что и новый layout — визуально без прыжка
    dy.setValue(0);
    shifts.current.forEach((v) => v.setValue(0));
    setOrder(next);
    onReorderRef.current(next);
  };

  const pan = React.useMemo(
    () =>
      PanResponder.create({
        // забираем касание ручки сразу (тап по карточке не сработает)
        onStartShouldSetPanResponder: () => dragKeyRef.current !== null,
        onStartShouldSetPanResponderCapture: () => dragKeyRef.current !== null,
        onMoveShouldSetPanResponder: () => dragKeyRef.current !== null,
        // не отдаём жест скроллу/свайпу, пока тащим
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (evt) => {
          if (!dragKeyRef.current) return;
          baseY.current = evt.nativeEvent.pageY;
          fingerY.current = evt.nativeEvent.pageY;
          dy.setValue(0);
        },
        onPanResponderMove: (evt) => {
          const key = dragKeyRef.current;
          if (!key) return;
          const pageY = evt.nativeEvent.pageY;
          fingerY.current = pageY;
          const offset = pageY - baseY.current;
          if (!activeRef.current) {
            if (Math.abs(offset) < ACT_THRESHOLD) return; // тап, не драг
            activeRef.current = true;
            setActiveKey(key);
            dragChangeRef.current?.(true);
            Vibration.vibrate(10);
          }
          dy.setValue(offset);
          recomputeSlot(offset);
          tickAuto(pageY);
        },
        onPanResponderRelease: () => finish(true),
        onPanResponderTerminate: () => finish(false),
      }),
    // dy/shifts — стабильные объекты; всё остальное через refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const beginDrag = (key: string) => () => {
    rollbackToken.current++; // отменяем незавершённый откат предыдущего драга
    dragKeyRef.current = key;
    fromRef.current = orderRef.current.findIndex((x) => keyOfRef.current(x) === key);
    slotRef.current = fromRef.current;
    activeRef.current = false;
    setDragKey(key);
    setSlot(fromRef.current);
    dy.setValue(0);
  };

  return (
    <View style={{ gap }}>
      {order.map((item, index) => {
        const key = keyOf(item);
        const dragging = dragKey === key;
        const active = activeKey === key;
        const lift: ViewStyle = active
          ? {
              zIndex: 50,
              elevation: 12,
              shadowColor: "#000",
              shadowOpacity: 0.45,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 6 },
            }
          : {};
        return (
          <Animated.View
            key={key}
            onLayout={(e: LayoutChangeEvent) => {
              heights.current.set(key, e.nativeEvent.layout.height);
            }}
            style={[
              rowStyle,
              lift,
              dragging
                ? { transform: [{ translateY: dy }, { scale: active ? 1.02 : 1 }] }
                : { transform: [{ translateY: shiftOf(key) }] },
            ]}
          >
            {renderItem(item, {
              handleProps: {
                ...pan.panHandlers,
                onStartShouldSetResponderCapture: beginDrag(key),
              },
              dragging,
              active,
              index,
            })}
          </Animated.View>
        );
      })}
    </View>
  );
}

export default ReorderList;
