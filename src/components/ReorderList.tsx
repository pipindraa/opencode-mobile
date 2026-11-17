import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";

/**
 * Вертикальный список с перетаскиванием по ручке (drag-and-drop).
 *
 * Для МАЛЫХ списков (избранное: чаты, модели) — НЕ виртуализируется, поэтому
 * реордеринг надёжный. Родитель владеет порядком: передаёт `items` уже в нужном
 * порядке и получает `onReorder(newItems)` в конце. Во время перетаскивания
 * компонент ведёт собственный порядок и синхронизируется с `items`, только когда
 * не тащится (внешние правки — добавить/убрать избранное).
 *
 * Механика: строка, которую тянешь, «всплывает» (zIndex + тень) и следует за
 * пальцем (translateY); остальные плавно занимают слоты, порядок меняется на
 * лету, при отпускании порядок фиксируется и отдаётся родителю.
 */
export function ReorderList<T>({
  items,
  keyOf,
  renderItem,
  onReorder,
  gap = 8,
  rowStyle,
}: {
  items: T[];
  keyOf: (item: T) => string;
  /** renderItem получает ctx.handleProps — привязать к ручке; ctx.dragging — тащится ли эта строка */
  renderItem: (
    item: T,
    ctx: { handleProps: any; dragging: boolean; index: number }
  ) => React.ReactNode;
  onReorder: (items: T[]) => void;
  gap?: number;
  rowStyle?: ViewStyle;
}) {
  const [order, setOrder] = useState<T[]>(items);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const orderRef = useRef<T[]>(items);
  const dragKeyRef = useRef<string | null>(null);
  const heights = useRef<Map<string, number>>(new Map());
  const fingerBase = useRef(0);
  const dy = useRef(new Animated.Value(0)).current;

  // свежие колбэки/props для стабильного PanResponder (создаётся один раз)
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  const gapRef = useRef(gap);
  gapRef.current = gap;

  // внешний порядок (добавили/убрали избранное) — применяем, только когда не тащим.
  // Сравнение по КЛЮЧАМ: родитель часто передаёт новый массив с тем же составом
  // (инлайн-вычисление), setState по идентичности зациклит рендеры.
  useEffect(() => {
    if (dragKeyRef.current) return;
    const cur = orderRef.current;
    const same =
      items.length === cur.length &&
      items.every((it, i) => keyOfRef.current(it) === keyOfRef.current(cur[i]));
    if (!same) {
      orderRef.current = items;
      setOrder(items);
    }
  }, [items]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // ручка — отдельная цель: тап по карточке (не по ручке) работает как обычно
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (evt) => {
          if (!dragKeyRef.current) return;
          fingerBase.current = evt.nativeEvent.pageY;
          dy.setValue(0);
        },
        onPanResponderMove: (evt) => {
          const key = dragKeyRef.current;
          if (!key) return;
          const offset = evt.nativeEvent.pageY - fingerBase.current;
          const cur = orderRef.current;
          const k = keyOfRef.current;
          const g = gapRef.current;
          // Y верха строки key в порядке cur (без учёта текущего смещения)
          const topOf = (arr: T[], target: string): number => {
            let top = 0;
            for (let i = 0; i < arr.length; i++) {
              const ki = k(arr[i]);
              if (ki === target) return top;
              top += (heights.current.get(ki) ?? 0) + g;
            }
            return 0;
          };
          const h = heights.current.get(key) ?? 0;
          const center = topOf(cur, key) + offset + h / 2;
          // ближайший слот по центру
          let targetIdx = 0;
          let best = Infinity;
          for (let j = 0; j < cur.length; j++) {
            const kj = k(cur[j]);
            const cj = topOf(cur, kj) + (heights.current.get(kj) ?? 0) / 2;
            const d = Math.abs(cj - center);
            if (d < best) {
              best = d;
              targetIdx = j;
            }
          }
          const curIdx = cur.findIndex((x) => k(x) === key);
          if (targetIdx !== curIdx) {
            const oldTop = topOf(cur, key);
            const next = [...cur];
            const [moved] = next.splice(curIdx, 1);
            next.splice(targetIdx, 0, moved);
            const newTop = topOf(next, key);
            // компенсируем прыжок после смены слота
            dy.setValue(offset - (newTop - oldTop));
            orderRef.current = next;
            setOrder(next);
          } else {
            dy.setValue(offset);
          }
        },
        onPanResponderRelease: () => {
          const key = dragKeyRef.current;
          if (!key) return;
          dragKeyRef.current = null;
          setDragKey(null);
          Animated.timing(dy, { toValue: 0, duration: 130, useNativeDriver: true }).start();
          onReorderRef.current(orderRef.current);
        },
        onPanResponderTerminate: () => {
          const key = dragKeyRef.current;
          if (!key) return;
          dragKeyRef.current = null;
          setDragKey(null);
          dy.setValue(0);
          onReorderRef.current(orderRef.current);
        },
      }),
    // dy — стабильный ref-объект; остальное через refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const beginDrag = (key: string) => () => {
    dragKeyRef.current = key;
    setDragKey(key);
    dy.setValue(0);
  };

  return (
    <View style={{ gap }}>
      {order.map((item, index) => {
        const key = keyOf(item);
        const dragging = dragKey === key;
        const style: ViewStyle = dragging
          ? {
              zIndex: 50,
              shadowColor: "#000",
              shadowOpacity: 0.4,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 4 },
              elevation: 8,
            }
          : {};
        return (
          <Animated.View
            key={key}
            style={[rowStyle, style, dragging && { transform: [{ translateY: dy }]}]}
            onLayout={(e: LayoutChangeEvent) => {
              heights.current.set(key, e.nativeEvent.layout.height);
            }}
          >
            {renderItem(item, {
              handleProps: {
                ...pan.panHandlers,
                onStartShouldSetResponderCapture: beginDrag(key),
              },
              dragging,
              index,
            })}
          </Animated.View>
        );
      })}
    </View>
  );
}

export default ReorderList;
