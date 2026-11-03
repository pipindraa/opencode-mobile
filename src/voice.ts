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
    new Promise((resolve, reject) => {
      const m = getVoiceNative();
      if (!m) return reject(new Error("модуль голосового ввода недоступен"));
      try {
        m.startSpeech(
          locale,
          {
            EXTRA_LANGUAGE_MODEL: "LANGUAGE_MODEL_FREE_FORM",
            EXTRA_MAX_RESULTS: 5,
            EXTRA_PARTIAL_RESULTS: true,
            REQUEST_PERMISSIONS_AUTO: true,
          },
          (e) => (e ? reject(new Error(e)) : resolve())
        );
      } catch (e: any) {
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
    new Promise((resolve) => {
      const m = getVoiceNative();
      if (!m) return resolve(false);
      try {
        m.isRecognizing((v) => resolve(!!v));
      } catch {
        resolve(false);
      }
    }),

  /**
   * Накопленный результат (последний partial или финальный) + последняя ошибка.
   * Пустая строка = ничего не распознано.
   */
  getSpeechResults: (): Promise<{ text: string; error: string }> =>
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
};
