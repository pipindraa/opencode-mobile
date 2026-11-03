/**
 * Локальные уведомления: «агент закончил / нужно разрешение / ошибка».
 *
 * Локальные (без push): баннер виден и в переднем плане, и когда приложение
 * в фоне/минимизировано. Тап по уведомлению (в т.ч. холодный старт) открывает
 * сессию — логику тапа держит App через onTapped().
 *
 * Фоновые задачи (app убит, процесс не жив) — не покрываем: для этого нужен
 * push, а «всё бесплатно» + свой сервер. Честный уровень: уведомления живут,
 * пока приложение установлено и запущено хотя бы раз (локальные уведомления
 * Android показываются из фонового режима).
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

let ready = false;

/**
 * Запросить POST_NOTIFICATIONS (Android 13+) и настроить обработчик.
 * Идемпотентно; возвращает false, если разрешения нет или не Android.
 */
export async function initNotifications(): Promise<boolean> {
  if (ready) return true;
  if (Platform.OS !== "android") return false;
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== "granted") return false;
    // баннер + звук, без бейджа; показываем и в фоне
    await Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    ready = true;
    return true;
  } catch {
    return false;
  }
}

export function isReady(): boolean {
  return ready;
}

/** Показать уведомление немедленно (локальное, без push-сервера). */
export async function notify(title: string, body: string, data: Record<string, string> = {}): Promise<void> {
  if (!ready) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data, sound: true },
      trigger: null, // null = показать сейчас
    });
  } catch {
    /* уведомления не критичны для работы чата */
  }
}

/**
 * Тап по уведомлению (hot + cold start). Колбэк получает data
 * (в нём sessionID). Возвращает функцию отписки.
 */
export function onTapped(cb: (data: Record<string, string>) => void): () => void {
  if (Platform.OS !== "android") return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const data = (resp.notification?.request?.content?.data ?? {}) as Record<string, string>;
    if (data && Object.keys(data).length > 0) cb(data);
  });
  // холодный старт: тап, который запустил приложение, — в getLastNotificationResponseAsync
  // (на Android это ответ из launch-интента; при обычном старте приходит null)
  (async () => {
    try {
      const resp = await Notifications.getLastNotificationResponseAsync();
      const data = (resp?.notification?.request?.content?.data ?? {}) as Record<string, string>;
      if (data && Object.keys(data).length > 0) cb(data);
    } catch {
      /* ignore */
    }
  })();
  return () => sub.remove();
}
