<# : WebTerm remote desktop over RDP - setup for Windows Pro / Enterprise. Double-click to run.
@echo off
setlocal
set "WT_SELF=%~f0"
set "WT_ARGS=%*"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:WT_SELF))"
exit /b %errorlevel%
#>
# ---------------------------------------------------------------------------
# WebTerm remote desktop over RDP - setup for Windows (built-in Remote Desktop)
#
# Turns on Windows' own Remote Desktop (with Network Level Authentication and
# sound) and lets only your WebTerm server reach it. Needs Windows Pro,
# Enterprise or Education - Windows Home has no RDP server (use
# install-vnc-windows.cmd there).
#
#   install-rdp-windows.cmd              set up (asks a few questions)
#   install-rdp-windows.cmd /uninstall   turn Remote Desktop off again
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$RuleName = 'WebTerm RDP'
$Self = $env:WT_SELF
$Uninstall = "$env:WT_ARGS" -match '(^|\s)[/-]{0,2}uninstall(\s|$)'
$TS = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
$RDPTCP = "$TS\WinStations\RDP-Tcp"

function Close-Window([int]$code) {
  Write-Host ''
  [void](Read-Host 'Press Enter to close')
  exit $code
}
function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "warning: $m" -ForegroundColor Yellow }

# ------------------------------------------------------------ administrator rights
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Asking for administrator rights...'
  try {
    if ($env:WT_ARGS) { Start-Process -FilePath $Self -ArgumentList $env:WT_ARGS -Verb RunAs }
    else { Start-Process -FilePath $Self -Verb RunAs }
  } catch {
    Write-Host 'This setup needs administrator rights.' -ForegroundColor Red
    Close-Window 1
  }
  exit 0
}

function Remove-WebTermRule {
  Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

try {
  # ------------------------------------------------------------ uninstall
  if ($Uninstall) {
    Set-ItemProperty -Path $TS -Name fDenyTSConnections -Value 1 -Type DWord
    Remove-WebTermRule
    Say 'Remote Desktop is turned off again.'
    Close-Window 0
  }

  Write-Host ''
  Write-Host 'WebTerm remote desktop setup - RDP (Windows Remote Desktop)' -ForegroundColor Cyan
  Write-Host ''

  $os = Get-CimInstance Win32_OperatingSystem
  $edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue).EditionID
  if ("$edition" -match 'Core|Home' -or "$($os.Caption)" -match 'Home') {
    Write-Host "This PC runs $($os.Caption). Windows Home has no Remote Desktop server." -ForegroundColor Red
    Write-Host 'Use install-vnc-windows.cmd on this PC instead (it also shows the sign-in screen).'
    Close-Window 1
  }

  # ------------------------------------------------------------ questions
  $defaultPort = 3389
  $cur = (Get-ItemProperty -Path $RDPTCP -Name PortNumber -ErrorAction SilentlyContinue).PortNumber
  if ($cur) { $defaultPort = [int]$cur }
  $defaultAllow = ''
  $oldRule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($oldRule) {
    $ra = @(($oldRule | Get-NetFirewallAddressFilter).RemoteAddress)
    if ($ra.Count -eq 1 -and "$($ra[0])" -match '^\d{1,3}(\.\d{1,3}){3}$') { $defaultAllow = "$($ra[0])" }
  }
  Write-Host 'Enter the IP address of your WebTerm server (the VM) so only it can connect.'
  while ($true) {
    if ($defaultAllow) { $in = Read-Host "WebTerm server IP [$defaultAllow] ('any' = whole local network)" }
    else { $in = Read-Host 'WebTerm server IP (Enter = allow the whole local network)' }
    $in = "$in".Trim()
    if (-not $in) { $in = $defaultAllow }
    if ($in -eq 'any' -or -not $in) { $allow = ''; break }
    $ip = $null
    if ($in -match '^\d{1,3}(\.\d{1,3}){3}$' -and [Net.IPAddress]::TryParse($in, [ref]$ip)) { $allow = $in; break }
    Write-Host '  that is not an IPv4 address (example: 192.168.1.10)'
  }
  while ($true) {
    $in = "$(Read-Host "RDP port [$defaultPort]")".Trim()
    if (-not $in) { $port = $defaultPort; break }
    $n = 0
    if ([int]::TryParse($in, [ref]$n) -and $n -ge 1 -and $n -le 65535) { $port = $n; break }
    Write-Host '  enter a number between 1 and 65535'
  }

  # ------------------------------------------------------------ Remote Desktop
  Say 'turning on Remote Desktop (with Network Level Authentication)'
  Set-ItemProperty -Path $TS -Name fDenyTSConnections -Value 0 -Type DWord
  Set-ItemProperty -Path $RDPTCP -Name UserAuthentication -Value 1 -Type DWord
  # Sound from the remote session is played in the browser.
  Set-ItemProperty -Path $RDPTCP -Name fDisableAudioCapture -Value 1 -Type DWord -ErrorAction SilentlyContinue
  Set-ItemProperty -Path $RDPTCP -Name fDisableCam -Value 0 -Type DWord -ErrorAction SilentlyContinue
  $portChanged = $false
  if ($port -ne [int]$cur) {
    Set-ItemProperty -Path $RDPTCP -Name PortNumber -Value $port -Type DWord
    $portChanged = $true
  }
  Set-Service -Name TermService -StartupType Automatic
  if ($portChanged) { Restart-Service -Name TermService -Force -ErrorAction SilentlyContinue }
  else { Start-Service -Name TermService -ErrorAction SilentlyContinue }

  # ------------------------------------------------------------ firewall
  # Windows' own "Remote Desktop" rules accept every address; ours only the WebTerm server.
  Get-NetFirewallRule -Group '@FirewallAPI.dll,-28752' -ErrorAction SilentlyContinue | Disable-NetFirewallRule -ErrorAction SilentlyContinue
  Remove-WebTermRule
  $remote = 'LocalSubnet'
  if ($allow) { $remote = $allow }
  New-NetFirewallRule -DisplayName $RuleName -Description 'Lets the WebTerm server reach Windows Remote Desktop.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemoteAddress $remote -Profile Any | Out-Null
  Say "firewall: port $port open for $remote"

  # ------------------------------------------------------------ account
  $who = "$env:USERNAME"
  $msa = $false
  try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $prof = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\IdentityStore\Cache\$sid\IdentityCache\$sid" -ErrorAction SilentlyContinue
    if ($prof -and $prof.UserName -match '@') { $who = $prof.UserName; $msa = $true }
  } catch {}

  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | Select-Object -ExpandProperty IPAddress)
  Write-Host ''
  Say 'done - Remote Desktop is on and starts with Windows'
  Write-Host ''
  Write-Host '   In WebTerm: Systems -> this PC -> edit:'
  Write-Host ('     IP / host     : ' + ($ips -join ', '))
  Write-Host "     RDP port      : $port"
  Write-Host "     RDP user      : $who"
  Write-Host '     RDP password  : your Windows password'
  if ($msa) {
    Write-Host '   (A Microsoft account signs in with its account password, not the PIN. If Settings ->'
    Write-Host '    Accounts -> Sign-in options has "only allow Windows Hello sign-in" on, turn it off.)'
  }
  Write-Host '   Then choose RDP on the Screen button. Someone working at this PC with the same'
  Write-Host '   account keeps their programs running; the screen here locks while you are connected.'
  if (-not $allow) { Write-Host '   Accepting connections from the local network. Run this again with your WebTerm server IP to allow only it.' }
  Close-Window 0
} catch {
  Write-Host ''
  Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
  Close-Window 1
}
