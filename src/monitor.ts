/**
 * JS-обёртка над нативным модулем Monitor (фоновый монитор сессий).
 *
 * Нативка: MonitorModule.kt + MonitorWorker.kt — WorkManager-цепочка тиков
 * по ~60с, переживает убийство процесса. JS только включает/выключает и
 * сообщает, что приложение в переднем плане (тогда баннеры шлёт сам JS).
 *
 * Все вызовы — Promise с таймаутом: если мост не вернёт ответ, не вешаемся.
 * На не-Android / в отладочной сборке без нативки — available() = false,
 * тумблер в настройках честно пишет «недоступно».
 */
import { NativeModules, Platform } from "react-native";

type MonitorNative = {
  start: (url: string, password: string, flavor: string, cb: (ok: boolean) => void) => void;
  stop: (cb: (ok: boolean) => void) => void;
  isRunning: (cb: (running: boolean) => void) => void;
  setForeground: (fg: boolean) => void;
};

/** колбэк-метод → Promise с защитой от «мост промолчал» */
function withTimeout<T>(fn: (resolve: (v: T) => void) => void, fallback: T, ms = 6000): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    fn((v: T) => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve(v);
      }
    });
  });
}

const native: MonitorNative | undefined =
  Platform.OS === "android" ? (NativeModules as any).Monitor : undefined;

export const monitor = {
  /** нативный модуль на месте (в собранном APK — да, в web-режиме — нет) */
  available(): boolean {
    return !!native;
  },
  /** включить: сохранить url/пароль и расписать первый тик (~5с) */
  start(url: string, password: string, flavor: string): Promise<boolean> {
    if (!native) return Promise.resolve(false);
    return withTimeout((res) => native.start(url, password, flavor, res), false);
  },
  /** выключить: гаснет цепочка тиков */
  stop(): Promise<boolean> {
    if (!native) return Promise.resolve(false);
    return withTimeout((res) => native.stop(res), false);
  },
  /** тик в расписании (ENQUEUED/RUNNING) и монитор включён */
  isRunning(): Promise<boolean> {
    if (!native) return Promise.resolve(false);
    return withTimeout((res) => native.isRunning(res), false);
  },
  /** приложение в переднем плане — нативка не дублирует уведомления */
  setForeground(fg: boolean): void {
    try {
      native?.setForeground(fg);
    } catch {
      /* не критично */
    }
  },
};
