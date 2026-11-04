/**
 * Прямой доступ к TurboModule Voice (форк @react-native-voice/voice 4.x).
 *
 * Почему не события: на RN 0.88 (only-new-architecture, bridgeless) нативная
 * сторона шлёт события через legacy RCTDeviceEventEmitter, которого в ядре
 * больше нет — onSpeechEnd/onSpeechResults до JS не доходят. Поэтому app
 * опрашивает isRecognizing(), а текст забирает getSpeechResults() (метод
 * добавлен патчем patches/@react-native-voice+voice+4.0.0.patch).
 */
import { NativeModules, TurboModuleRegistry } from "react-native";

type VoiceNative = {
  startSpeech: (locale: string, opts: Record<string, any>, cb: (e: string | false | null) => void) => void;
  stopSpeech: (cb: (e: string | false | null) => void) => void;
  isRecognizing: (cb: (v: boolean) => void) => void;
  getSpeechResults: (cb: (results: string | null, error: string | null) => void) => void;
};

/**
 * Таймаут-обёртка: если нативный колбэк по какой-то причине не пришёл
 * (мост завис, модуль ушёл в фон), возвращаем дефолт вместо вечного await.
 * Без этого voiceOn мог зависнуть навсегда — «отжать» микрофон было нельзя.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        console.log("[voice] withTimeout: fallback после " + ms + "мс");
        resolve(fallback);
      }
    }, ms);
    p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(fallback);
        }
      }
    );
  });
}

function getVoiceNative(): VoiceNative | null {
  try {
    const m: any = (globalThis as any).__turboModuleProxy
      ? TurboModuleRegistry.getEnforcing("Voice")
      : (NativeModules as any).Voice;
    return m && typeof m.startSpeech === "function" ? (m as VoiceNative) : null;
  } catch {
    return null;
  }
}

export const voiceNative = {
  available: (): boolean => getVoiceNative() !== null,

  /** Запустить распознавание. Отклоняет Promise, если стартовать не удалось. */
  start: (locale = "ru-RU"): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const m = getVoiceNative();
      if (!m) return reject(new Error("модуль голосового ввода недоступен"));
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("микрофон не ответил (таймаут)"));
        }
      }, 8000);
      try {
        m.startSpeech(
          locale,
          {
            EXTRA_LANGUAGE_MODEL: "LANGUAGE_MODEL_FREE_FORM",
            EXTRA_MAX_RESULTS: 5,
            EXTRA_PARTIAL_RESULTS: true,
            // Непрерывная диктовка: пауза до 3с не должна завершать нативную
            // сессию (штатный тайм-аут движка короче). Длинная тишина
            // обрабатывается JS-стороной: авто-рестарт сессии (ChatScreen).
            EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 3000,
            EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 3000,
            REQUEST_PERMISSIONS_AUTO: true,
          },
          (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (e) reject(new Error(e));
            else resolve();
          }
        );
      } catch (e: any) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    }),

  /** Остановить распознавание (безопасно, если уже остановлено). */
  stop: (): void => {
    const m = getVoiceNative();
    try {
      m?.stopSpeech(() => {});
    } catch {
      /* ignore */
    }
  },

  /** Идёт ли распознавание на нативной стороне. */
  isRecognizing: (): Promise<boolean> =>
    withTimeout(
      new Promise<boolean>((resolve) => {
        const m = getVoiceNative();
        if (!m) return resolve(false);
        try {
          m.isRecognizing((v) => resolve(!!v));
        } catch {
          resolve(false);
        }
      }),
      1500,
      false
    ),

  /**
   * Накопленный результат (последний partial или финальный) + последняя ошибка.
   * Пустая строка = ничего не распознано.
   */
  getSpeechResults: (): Promise<{ text: string; error: string }> =>
    withTimeout(
      new Promise((resolve) => {
        const m = getVoiceNative();
        if (!m) return resolve({ text: "", error: "" });
        try {
          m.getSpeechResults((t, e) =>
            resolve({ text: String(t ?? ""), error: String(e ?? "") })
          );
        } catch {
          resolve({ text: "", error: "" });
        }
      }),
      1500,
      { text: "", error: "" }
    ),
};
