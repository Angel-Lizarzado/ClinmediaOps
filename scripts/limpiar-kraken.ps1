# ==============================================================================
# Script de Limpieza y Recuperación de Instalación de Kraken CLI Control Center
#
# Propósito:
#   1. Detiene procesos colgados de Kraken/Electron.
#   2. Respalda config.json de forma preventiva al Escritorio.
#   3. Elimina la clave huérfana de desinstalación en el Registro de Windows
#      (evita el error "Fallo al desinstalar archivos antiguos... : 2").
#   4. Limpia la carpeta de instalación dañada y la caché del actualizador.
#   5. Preserva la configuración para que el nuevo instalador la reconozca intacta.
# ==============================================================================

Write-Host "Iniciando limpieza de Kraken CLI..." -ForegroundColor Cyan

# 1. Detener procesos bloqueantes
Write-Host "1. Cerrando procesos de Kraken y Electron en segundo plano..." -ForegroundColor Yellow
Get-Process -Name "*Kraken*", "*electron*" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

# 2. Respaldo preventivo de config.json
$programsDir = "$env:LOCALAPPDATA\Programs"
$configFile  = Join-Path $programsDir "config.json"
$backupFile  = Join-Path $HOME "Desktop\config_backup_kraken.json"

if (Test-Path $configFile) {
    Copy-Item -Path $configFile -Destination $backupFile -Force
    Write-Host "2. [OK] Copia preventiva de config.json guardada en el Escritorio." -ForegroundColor Green
} else {
    Write-Host "2. [INFO] No se encontro config.json previo en $programsDir." -ForegroundColor Gray
}

# 3. Eliminar clave huérfana del Registro de Windows
Write-Host "3. Limpiando entradas del Registro de Windows..." -ForegroundColor Yellow
$regKey = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\dff81567-3cd8-56cc-aea7-f5fa5c13b02c"
& reg delete $regKey /f 2>$null | Out-Null

# 4. Eliminar carpeta de instalacion y cache del updater
Write-Host "4. Eliminando archivos antiguos y cache del actualizador..." -ForegroundColor Yellow
$krakenDir   = Join-Path $programsDir "kraken-cli"
$updaterDir  = "$env:LOCALAPPDATA\kraken-cli-updater"

if (Test-Path $krakenDir) {
    Remove-Item -Path $krakenDir -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path $updaterDir) {
    Remove-Item -Path $updaterDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 5. Confirmar que config.json sigue en su lugar original
if (-not (Test-Path $configFile) -and (Test-Path $backupFile)) {
    Copy-Item -Path $backupFile -Destination $configFile -Force
}

Write-Host "`n==============================================================================" -ForegroundColor Green
Write-Host "  [OK] Limpieza completa finalizada exitosamente." -ForegroundColor Green
Write-Host "  Ya puedes ejecutar el instalador de Kraken CLI sin ningun bloqueo ni error." -ForegroundColor Green
Write-Host "==============================================================================`n" -ForegroundColor Green
