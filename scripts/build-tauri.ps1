[CmdletBinding()]
param(
  [ValidateSet("build", "dev", "check")]
  [string]$Mode = "build"
)

$ErrorActionPreference = "Stop"

function Resolve-RequiredPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw $Message
  }

  (Resolve-Path -LiteralPath $Path).Path
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..")).Path

$programFilesX86 = ${env:ProgramFiles(x86)}
$vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
$vsInstallPath = $null

if (Test-Path -LiteralPath $vswhere) {
  $vsInstallPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0) {
    $vsInstallPath = $null
  }
}

if (-not $vsInstallPath) {
  $fallbacks = @(
    "C:\Program Files\Microsoft Visual Studio\2022\Community",
    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise"
  )
  foreach ($fallback in $fallbacks) {
    if (Test-Path -LiteralPath $fallback) {
      $vsInstallPath = $fallback
      break
    }
  }
}

if (-not $vsInstallPath) {
  throw "Visual Studio C++ tools were not found. Install Desktop development with C++ first."
}

$vcvars64 = Resolve-RequiredPath `
  -Path (Join-Path $vsInstallPath "VC\Auxiliary\Build\vcvars64.bat") `
  -Message "vcvars64.bat was not found under $vsInstallPath. Install MSVC v143 x64/x86 build tools."

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (-not (Test-Path -LiteralPath (Join-Path $cargoBin "cargo.exe"))) {
  $cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
  if (-not $cargoCommand) {
    throw "cargo.exe was not found. Install Rust stable MSVC with rustup first."
  }
  $cargoBin = Split-Path -Parent $cargoCommand.Source
}

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCommand) {
  throw "pnpm was not found in PATH. Install pnpm or run corepack enable first."
}

switch ($Mode) {
  "build" {
    $releaseExe = Join-Path $repoRoot "src-tauri\target\release\app.exe"
    if (Test-Path -LiteralPath $releaseExe) {
      $runningRelease = Get-Process app -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $releaseExe }
      foreach ($process in $runningRelease) {
        Write-Host "Stopping running release app.exe (PID $($process.Id)) before rebuild."
        Stop-Process -Id $process.Id -Force
      }
    }
    $innerCommand = "cd /d `"$repoRoot`" && pnpm tauri:build"
  }
  "dev" {
    $innerCommand = "cd /d `"$repoRoot`" && pnpm tauri:dev"
  }
  "check" {
    $innerCommand = "cd /d `"$repoRoot\src-tauri`" && cargo check"
  }
}

Write-Host "Using Visual Studio: $vsInstallPath"
Write-Host "Using vcvars64: $vcvars64"
Write-Host "Using Cargo bin: $cargoBin"
Write-Host "Mode: $Mode"

$cmd = "set `"PATH=$cargoBin;%PATH%`" && call `"$vcvars64`" && $innerCommand"
& cmd.exe /d /s /c $cmd

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
