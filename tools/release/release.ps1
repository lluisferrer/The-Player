# Release local d'ezyPlayer per a Windows (amb motor natiu ASIO).
#
# El CI de GitHub no pot compilar ASIO (l'SDK de Steinberg no es pot redistribuir),
# així que l'instal·lador que es ven es genera en aquesta màquina. Aquest script
# fa que el procés sigui reproduïble:
#   1. Comprovacions: arbre git net, versions coherents (tauri.conf.json,
#      package.json, Cargo.toml), entrada al CHANGELOG, ASIO dins les features per
#      defecte, variables de l'SDK disponibles, ezyplayer.exe tancat.
#   2. Tests del frontend (npm test).
#   3. Build de l'instal·lador NSIS (npm run tauri build -- --bundles nsis).
#   4. Còpia a releases\<versió>\ amb SHA256SUMS.txt i release-info.txt.
#
# Ús:  powershell -ExecutionPolicy Bypass -File tools\release\release.ps1
#      (opcions: -TargetDir C:\tpbuild  -AllowDirty  -SkipTests)
param(
  [string]$TargetDir = "C:\tpbuild",
  [switch]$AllowDirty,
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Step([string]$msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# ── 1. Comprovacions ─────────────────────────────────────────────────────────
Step "Comprovacions"

$dirty = git status --porcelain
if ($dirty -and -not $AllowDirty) { Fail "L'arbre git té canvis sense commit (usa -AllowDirty per a proves)." }
$commit = (git rev-parse --short HEAD).Trim()
if ($dirty) { $commit = "$commit-dirty" }

# Versions: les tres fonts han de coincidir.
$confVersion = (Get-Content "src-tauri\tauri.conf.json" -Raw -Encoding UTF8 | ConvertFrom-Json).version
$pkgVersion = (Get-Content "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json).version
$cargoLine = Select-String -Path "src-tauri\Cargo.toml" -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
$cargoVersion = $cargoLine.Matches[0].Groups[1].Value
if ($confVersion -ne $pkgVersion -or $confVersion -ne $cargoVersion) {
  Fail "Versions diferents: tauri.conf.json=$confVersion package.json=$pkgVersion Cargo.toml=$cargoVersion"
}
$version = $confVersion
Write-Host "Versió $version (commit $commit)"

if (-not (Select-String -Path "CHANGELOG.md" -Pattern "^## \[$([regex]::Escape($version))\]" -Quiet)) {
  Fail "CHANGELOG.md no té cap entrada '## [$version]'."
}

# L'instal·lador comercial ha de portar ASIO: ha de ser a les features per defecte.
if (-not (Select-String -Path "src-tauri\Cargo.toml" -Pattern '^default\s*=\s*\[[^\]]*"asio"' -Quiet)) {
  Fail "La feature 'asio' no és a default de src-tauri\Cargo.toml."
}

# Variables de l'SDK: un terminal vell pot no tenir les persistides a l'usuari.
foreach ($name in @("LIBCLANG_PATH", "CPAL_ASIO_DIR")) {
  if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
    $val = [Environment]::GetEnvironmentVariable($name, "User")
    if (-not $val) { Fail "Falta la variable $name (vegeu docs/motor-natiu-asio.md)." }
    [Environment]::SetEnvironmentVariable($name, $val, "Process")
  }
  $path = [Environment]::GetEnvironmentVariable($name, "Process")
  if (-not (Test-Path $path)) { Fail "$name apunta a una ruta que no existeix: $path" }
}

# Amb l'app oberta el linker no pot sobreescriure l'exe.
if (Get-Process ezyplayer -ErrorAction SilentlyContinue) { Fail "Tanca ezyplayer.exe abans de compilar." }

# El target-dir es fixa aquí perquè .cargo\config.toml és local i pot no existir.
$env:CARGO_TARGET_DIR = $TargetDir

# ── 2. Tests ─────────────────────────────────────────────────────────────────
if (-not $SkipTests) {
  Step "Tests (npm test)"
  npm test
  if ($LASTEXITCODE -ne 0) { Fail "Els tests han fallat." }
}

# ── 3. Build ─────────────────────────────────────────────────────────────────
Step "Build de l'instal·lador NSIS amb ASIO"
npm run tauri build -- --bundles nsis
if ($LASTEXITCODE -ne 0) { Fail "El build ha fallat." }

$installerName = "ezyPlayer_${version}_x64-setup.exe"
$installer = Join-Path $TargetDir "release\bundle\nsis\$installerName"
if (-not (Test-Path $installer)) { Fail "No trobo l'instal·lador: $installer" }

# L'exe ha de dur la versió i l'editor correctes a les seves metadades.
$info = (Get-Item (Join-Path $TargetDir "release\ezyplayer.exe")).VersionInfo
if ($info.ProductVersion -ne $version) { Fail "L'exe diu versió $($info.ProductVersion), s'esperava $version." }

# ── 4. Artefactes ────────────────────────────────────────────────────────────
Step "Artefactes"
$outDir = Join-Path $root "releases\$version"
New-Item -ItemType Directory -Force $outDir | Out-Null
Copy-Item $installer $outDir -Force

$hash = (Get-FileHash (Join-Path $outDir $installerName) -Algorithm SHA256).Hash.ToLower()
# Format de sha256sum, verificable amb `sha256sum -c SHA256SUMS.txt`.
[IO.File]::WriteAllText((Join-Path $outDir "SHA256SUMS.txt"), "$hash *$installerName`n")

$rustc = (rustc --version).Trim()
$node = (node --version).Trim()
$infoText = @"
ezyPlayer $version
commit:    $commit
data:      $((Get-Date).ToString("yyyy-MM-dd HH:mm"))
rustc:     $rustc
node:      $node
features:  default (asio)
editor:    $($info.CompanyName)
sha256:    $hash
"@
[IO.File]::WriteAllText((Join-Path $outDir "release-info.txt"), $infoText.Replace("`r`n", "`n") + "`n")

Write-Host "`nFet: $outDir" -ForegroundColor Green
Write-Host "  $installerName"
Write-Host "  sha256 $hash"
if ($dirty) { Write-Host "AVÍS: build fet amb canvis sense commit — no el distribueixis." -ForegroundColor Yellow }
