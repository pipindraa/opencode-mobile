# Сборка и публикация релиза одной командой
#
#   powershell -File scripts/release.ps1 -Version 1.2.0 -Notes "что изменилось"
#
# Что делает:
#   1. поднимает version/versionCode (app.json + build.gradle);
#   2. проверяет типы (tsc);
#   3. собирает release-APK;
#   4. коммитит и пушит исходники;
#   5. создаёт GitHub-релиз с APK (приложение подтянет его через «Проверить обновления»).
#
# Подпись: используется debug-keystore, поэтому обновление встаёт поверх установленной
# версии. Если keystore сменится — Android попросит удалить приложение.

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = "",
  [string]$Repo = "pipindraa/opencode-mobile"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$gh = "C:\Program Files\GitHub CLI\gh.exe"
$apk = Join-Path $root "android\app\build\outputs\apk\release\app-release.apk"

# 1.2.0 -> 12, 1.2.1 -> 13 (монотонно растущий versionCode)
function Get-VersionCode([string]$v) {
  $p = $v.Split(".")
  $major = [int]$p[0]
  $minor = if ($p.Length -gt 1) { [int]$p[1] } else { 0 }
  $patch = if ($p.Length -gt 2) { [int]$p[2] } else { 0 }
  return $major * 10000 + $minor * 100 + $patch
}

$code = Get-VersionCode $Version
Write-Host "Версия $Version (versionCode $code)"

# --- 1. версии в конфигах -------------------------------------------------
$appJson = Get-Content "app.json" -Raw | ConvertFrom-Json
$appJson.expo.version = $Version
$appJson | ConvertTo-Json -Depth 20 | Set-Content "app.json" -Encoding utf8

$gradle = Get-Content "android\app\build.gradle" -Raw
$gradle = [regex]::Replace($gradle, 'versionCode\s+\d+', "versionCode $code")
$gradle = [regex]::Replace($gradle, 'versionName\s+"[^"]*"', "versionName `"$Version`"")
Set-Content "android\app\build.gradle" $gradle -NoNewline

# --- 2. типы ---------------------------------------------------------------
Write-Host "Проверяю типы…"
& cmd /c "node_modules\.bin\tsc.cmd --noEmit"
if ($LASTEXITCODE -ne 0) { throw "Ошибки TypeScript — сборка остановлена" }

# --- 3. APK ----------------------------------------------------------------
Write-Host "Собираю APK…"
Push-Location "android"
& cmd /c "gradlew.bat assembleRelease --console=plain -x lint"
$buildOk = $LASTEXITCODE -eq 0
Pop-Location
if (-not $buildOk) { throw "Сборка APK не удалась" }
if (-not (Test-Path $apk)) { throw "APK не найден: $apk" }

# --- 4. исходники ----------------------------------------------------------
git add -A
$hasChanges = (git status --porcelain) -ne $null
if ($hasChanges) {
  git -c user.name="kiril" -c user.email="kiril@local" commit -m "release: v$Version" | Out-Null
}
git push origin HEAD 2>&1 | Out-Null

# --- 5. GitHub-релиз -------------------------------------------------------
$tag = "v$Version"
if (-not $Notes) { $Notes = "Релиз $tag" }
& $gh release create $tag "$apk#app-release.apk" --repo $Repo --title $tag --notes $Notes
Write-Host "Готово: https://github.com/$Repo/releases/tag/$tag"
Write-Host "На телефоне: ⚙ Настройки → «Проверить обновления»"
