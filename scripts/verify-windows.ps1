$ErrorActionPreference = 'Stop'
$version = node -p "require('./package.json').version"
$installer = Join-Path (Get-Location) "dist.noindex/Xingmu-$version-windows-x64-setup.exe"
if (!(Test-Path $installer)) { throw "Missing installer: $installer" }
$testRoot = Join-Path $env:RUNNER_TEMP ("todo-install-" + [guid]::NewGuid().ToString())
$installDir = Join-Path $testRoot '醒目-个人效率工作台'
$profile = Join-Path $testRoot 'profile'
New-Item -ItemType Directory -Path $testRoot | Out-Null
$env:SMOKE_ARTIFACT_DIR = Join-Path (Get-Location) 'dist.noindex/windows-smoke'
function Install-Panel {
  $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
  if (!(Test-Path "$installDir/醒目-个人效率工作台.exe")) { throw 'Installed executable missing' }
}
Install-Panel
node scripts/smoke-app.js "$installDir/醒目-个人效率工作台.exe" $profile
if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke failed' }
Install-Panel
node scripts/smoke-app.js "$installDir/醒目-个人效率工作台.exe" $profile retained
if ($LASTEXITCODE -ne 0) { throw 'Reinstall retention smoke failed' }
$uninstaller = Get-ChildItem -Path $installDir -Filter 'Uninstall*.exe' | Select-Object -First 1
if (!$uninstaller) { throw 'Uninstaller missing' }
$process = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', "_?=$installDir") -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
if (Test-Path "$installDir/醒目-个人效率工作台.exe") { throw 'Uninstall left executable behind' }
if (!(Test-Path "$profile/workspace.json")) { throw 'Uninstall deleted retained user data' }
$hash = (Get-FileHash -Algorithm SHA256 -Path $installer).Hash.ToLowerInvariant()
"$hash  $([IO.Path]::GetFileName($installer))" | Set-Content -Encoding ascii "$installer.sha256"
Write-Output 'Windows install, launch, reinstall, data retention and uninstall passed.'
