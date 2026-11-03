/** Обёртка над AsyncStorage — настройки подключения + фэйвориты моделей и чатов */
import AsyncStorageInternal from "@react-native-async-storage/async-storage";
import type { ServerKind } from "./api";

const PREFIX = "oc_remote.";

type SettingKey = "url" | "password" | "omniUrl" | "omniPassword" | "updateRepo";

export const AsyncStorage = {
  async get(key: SettingKey): Promise<string> {
    return (await AsyncStorageInternal.getItem(PREFIX + key)) ?? "";
  },
  async set(key: SettingKey, value: string): Promise<void> {
    await AsyncStorageInternal.setItem(PREFIX + key, value);
  },
  /** фэйвориты моделей: массив ключей "providerID/modelID" */
  async getFavorites(): Promise<string[]> {
    try {
      const raw = await AsyncStorageInternal.getItem(PREFIX + "favorites");
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x: any) => typeof x === "string") : [];
    } catch {
      return [];
    }
  },
  async saveFavorites(keys: string[]): Promise<void> {
    await AsyncStorageInternal.setItem(PREFIX + "favorites", JSON.stringify(keys));
  },
  /** фэйвориты чатов — у каждого сервера свои (id сессий), живут только на телефоне */
  async getChatFavs(server: ServerKind): Promise<string[]> {
    try {
      const raw = await AsyncStorageInternal.getItem(PREFIX + "chatFavs." + server);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x: any) => typeof x === "string") : [];
    } catch {
      return [];
    }
  },
  async saveChatFavs(server: ServerKind, ids: string[]): Promise<void> {
    await AsyncStorageInternal.setItem(PREFIX + "chatFavs." + server, JSON.stringify(ids));
  },
  /** непрочитанные сессии (закончилось, пока чат был закрыт) — для синих точек */
  async getUnread(server: ServerKind): Promise<string[]> {
    try {
      const raw = await AsyncStorageInternal.getItem(PREFIX + "unread." + server);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x: any) => typeof x === "string") : [];
    } catch {
      return [];
    }
  },
  async saveUnread(server: ServerKind, ids: string[]): Promise<void> {
    await AsyncStorageInternal.setItem(PREFIX + "unread." + server, JSON.stringify(ids));
  },
};
