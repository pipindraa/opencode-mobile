/**
 * Авто-обновления через GitHub Releases.
 *
 * APK подписан debug-ключом, а GitHub-релиз играет роль «сервера обновлений»:
 * приложение спрашивает последний релиз, сравнивает версию со своей,
 * скачивает APK во временную папку и отдаёт системному установщику через FileProvider.
 *
 * Настройка: репозиторий зашит в UPDATE_REPO — пользователю ничего вводить не нужно.
 */
import { Paths } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import { getContentUriAsync, downloadAsync, cacheDirectory } from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";

/** репозиторий с релизами: откуда приложение тянет APK */
export const UPDATE_REPO = "pipindraa/opencode-mobile";

export interface ReleaseInfo {
  version: string;
  /** версия, поднятая в теге релиза: v1.1.0 или 1.1.0 */
  tag: string;
  notes: string;
  apkUrl: string;
  assetName: string;
}

/** 1.1.0 → [1,1,0]; «мусор» игнорируется */
export function parseVersion(v: string): number[] {
  return String(v)
    .replace(/^v/i, "")
    .split(/[.\-+]/)
    .map((x) => parseInt(x, 10))
    .map((x) => (Number.isFinite(x) ? x : 0));
}

/** true, если candidate новее current */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** последний релиз из публичного репозитория; null — обновлений нет или репозиторий не задан */
export async function checkLatest(repo: string): Promise<ReleaseInfo | null> {
  const r = String(repo ?? "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) return null;
  const res = await fetch(`https://api.github.com/repos/${r}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    // 404 = релизов ещё нет — это не ошибка для пользователя
    if (res.status === 404) return null;
    throw new Error(`GitHub ответил ${res.status}`);
  }
  const j: any = await res.json();
  const assets: any[] = Array.isArray(j?.assets) ? j.assets : [];
  const apk = assets.find((a) => String(a?.name ?? "").toLowerCase().endsWith(".apk")) ?? assets[0];
  if (!apk?.browser_download_url) return null;
  return {
    version: String(j?.tag_name ?? j?.name ?? "").replace(/^v/i, ""),
    tag: String(j?.tag_name ?? ""),
    notes: String(j?.body ?? "").slice(0, 1500),
    apkUrl: String(apk.browser_download_url),
    assetName: String(apk.name ?? "app-release.apk"),
  };
}

/**
 * Скачать APK и отдать установщику.
 * onProgress получает 0..1 (или -1, если размер неизвестен).
 */
export async function downloadAndInstall(
  rel: ReleaseInfo,
  onProgress?: (p: number) => void
): Promise<void> {
  const dir = cacheDirectory ?? String(Paths.cache.uri);
  const target = `${dir}${rel.assetName || "update.apk"}`;
  onProgress?.(0);
  // createDownloadResumable умеет отдавать прогресс — иначе на 65 МБ экран «висит»
  const task = FileSystem.createDownloadResumable(rel.apkUrl, target, {}, (e) => {
    if (e.totalBytesExpectedToWrite > 0) {
      onProgress?.(e.totalBytesWritten / e.totalBytesExpectedToWrite);
    }
  });
  const res = await task.downloadAsync();
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error(`Скачивание не удалось: HTTP ${res?.status ?? "?"}`);
  }
  // legacy-загрузка молча отдаёт успех на недокачанном файле — проверяем размер
  const info = await FileSystem.getInfoAsync(res.uri);
  if (!info.exists || !info.size || info.size < 1024 * 1024) {
    throw new Error("APK скачался не полностью — попробуй ещё раз");
  }
  onProgress?.(1);
  const uri = await getContentUriAsync(res.uri); // content:// — иначе установщик не откроет файл
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: uri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: "application/vnd.android.package-archive",
  });
}
