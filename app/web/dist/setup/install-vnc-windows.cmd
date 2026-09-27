<# : WebTerm remote desktop - server setup for Windows. Double-click to run.
@echo off
setlocal
set "WT_SELF=%~f0"
set "WT_ARGS=%*"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:WT_SELF))"
exit /b %errorlevel%
#>
# ---------------------------------------------------------------------------
# WebTerm remote desktop - server setup for Windows (TightVNC Server)
#
# Installs TightVNC Server as a Windows service for WebTerm's "Screen" windows:
# it starts with Windows and also shows the sign-in screen before anyone has
# logged in (like NoMachine). The firewall lets only your WebTerm server in.
#
#   install-vnc-windows.cmd              install or update (asks a few questions)
#   install-vnc-windows.cmd /uninstall   remove it again
#
# A TightVNC MSI next to this file (tightvnc-*-gpl-setup-64bit.msi) is used
# instead of downloading one. Works next to NoMachine (different port).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$TightVersion = '2.8.88'
$RuleName = 'WebTerm VNC'
$Service = 'tvnserver'
$Self = $env:WT_SELF
$Here = Split-Path -Parent $Self
$Uninstall = "$env:WT_ARGS" -match '(^|\s)[/-]{0,2}uninstall(\s|$)'
$Arch = if ([Environment]::Is64BitOperatingSystem) { '64bit' } else { '32bit' }

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

# ------------------------------------------------------------ helpers
function Open-Base {
  $view = if ([Environment]::Is64BitOperatingSystem) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
  return [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
}
function Open-Key([string]$path) { return (Open-Base).CreateSubKey($path) }

# Administrators and SYSTEM (nothing inherited from the parent).
$AdminSids = @('S-1-5-32-544', 'S-1-5-18')

# TightVNC's settings key. It holds the VNC passwords, so like TightVNC itself
# does, only administrators and SYSTEM may read it.
function Open-ServerKey {
  $acl = New-Object System.Security.AccessControl.RegistrySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $AdminSids) {
    $who = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule($who, 'FullControl', 'ContainerInherit', 'None', 'Allow')))
  }
  $base = Open-Base
  $path = 'SOFTWARE\TightVNC\Server'
  $check = [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
  $k = $base.OpenSubKey($path, $check, [System.Security.AccessControl.RegistryRights]::FullControl)
  if ($k) { $k.SetAccessControl($acl) }
  else { $k = $base.CreateSubKey($path, $check, $acl) }
  return $k
}

# Copies the installer into a new folder only administrators can write, so it
# cannot be swapped between the signature check and the installation.
function Copy-ToSafePlace([string]$src) {
  $dir = Join-Path $env:SystemRoot ('Temp\webterm-vnc-' + [guid]::NewGuid().ToString('N'))
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $AdminSids) {
    $who = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  (New-Object IO.DirectoryInfo $dir).Create($acl)
  $dst = Join-Path $dir ([IO.Path]::GetFileName($src))
  Copy-Item -LiteralPath $src -Destination $dst
  return $dst
}

# VNC's stored-password format: DES with the fixed VNC key (23 82 107 6 35 78
# 88 7, each byte's bits reversed for a standard DES implementation).
function Protect-VncPassword([string]$plain) {
  $block = New-Object byte[] 8
  $src = [Text.Encoding]::ASCII.GetBytes($plain)
  [Array]::Copy($src, $block, [Math]::Min(8, $src.Length))
  $des = [Security.Cryptography.DES]::Create()
  $des.Mode = [Security.Cryptography.CipherMode]::ECB
  $des.Padding = [Security.Cryptography.PaddingMode]::None
  $key = [byte[]](0xE8, 0x4A, 0xD6, 0x60, 0xC4, 0x72, 0x1A, 0xE0)
  $enc = $des.CreateEncryptor($key, (New-Object byte[] 8))
  return , $enc.TransformFinalBlock($block, 0, 8)
}

function New-Password {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  $buf = New-Object byte[] 8
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return -join ($buf | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Read-Secret([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Get-TightVnc {
  $paths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
  return @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'TightVNC*' })
}

function Get-VersionOf($entry) {
  try { return [version](([string]$entry.DisplayVersion) -replace '[^0-9.]', '') } catch { return [version]'0.0' }
}

function Remove-WebTermRule {
  Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

# Older TightVNC installs may have opened the firewall to every address.
function Disable-BroadVncRules {
  try {
    $filters = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*tvnserver.exe' })
    foreach ($f in $filters) {
      foreach ($r in @($f | Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
        if ("$($r.Direction)" -eq 'Inbound' -and "$($r.Action)" -eq 'Allow' -and "$($r.Enabled)" -eq 'True') {
          $r | Disable-NetFirewallRule
          Warn "turned off the firewall rule '$($r.DisplayName)' (it let any address reach TightVNC)"
        }
      }
    }
  } catch {}
}

function Get-Installer {
  $local = Get-ChildItem -Path $Here -Filter "tightvnc-*-gpl-setup-$Arch.msi" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if ($local) {
    Say "using $($local.Name) from this folder"
    return $local.FullName
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $dir = Join-Path $env:TEMP 'webterm-vnc'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $urls = @("https://www.tightvnc.com/download/$TightVersion/tightvnc-$TightVersion-gpl-setup-$Arch.msi")
  try {
    # Prefer whatever the download page currently offers.
    $page = (Invoke-WebRequest -Uri 'https://www.tightvnc.com/download.php' -UseBasicParsing -TimeoutSec 30).Content
    $m = [regex]::Match($page, "download/([0-9.]+)/tightvnc-\1-gpl-setup-$Arch\.msi")
    if ($m.Success) { $urls = @("https://www.tightvnc.com/$($m.Value)") + $urls }
  } catch {}
  foreach ($u in ($urls | Select-Object -Unique)) {
    $out = Join-Path $dir ([IO.Path]::GetFileName($u))
    try {
      Say "downloading $u"
      Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -TimeoutSec 600
      return $out
    } catch {
      Warn "download failed: $($_.Exception.Message)"
    }
  }
  throw "Could not download TightVNC. Download the $Arch MSI from https://www.tightvnc.com/download.php, put it next to this file and run this again."
}

function Set-ServerConfig([string]$password, [string]$control, [int]$port) {
  $k = Open-ServerKey
  try {
    $k.SetValue('Password', (Protect-VncPassword $password), [Microsoft.Win32.RegistryValueKind]::Binary)
    $k.SetValue('ControlPassword', (Protect-VncPassword $control), [Microsoft.Win32.RegistryValueKind]::Binary)
    $dwords = [ordered]@{
      RfbPort = $port; AcceptRfbConnections = 1; UseVncAuthentication = 1; UseControlAuthentication = 1
      AcceptHttpConnections = 0; LoopbackOnly = 0; AllowLoopback = 0; AlwaysShared = 1; NeverShared = 0
      RemoveWallpaper = 0; PollingInterval = 50
    }
    foreach ($name in $dwords.Keys) { $k.SetValue($name, [int]$dwords[$name], [Microsoft.Win32.RegistryValueKind]::DWord) }
  } finally {
    $k.Close()
  }
  # Ctrl+Alt+Del from the remote side (needed at the sign-in screen).
  $p = Open-Key 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  try {
    $cur = $p.GetValue('SoftwareSASGeneration')
    if (-not $cur) { $p.SetValue('SoftwareSASGeneration', 1, [Microsoft.Win32.RegistryValueKind]::DWord) }
  } finally {
    $p.Close()
  }
}

# ------------------------------------------------------------ uninstall
try {
  if ($Uninstall) {
    Write-Host 'Removing WebTerm remote desktop (TightVNC Server)...'
    foreach ($a in (Get-TightVnc)) {
      if ($a.PSChildName -match '^\{[0-9A-Fa-f-]+\}$') {
        $p = Start-Process msiexec.exe -ArgumentList "/x $($a.PSChildName) /qn /norestart" -Wait -PassThru
        Say "removed $($a.DisplayName) (exit code $($p.ExitCode))"
      }
    }
    Remove-WebTermRule
    try { (Open-Base).DeleteSubKeyTree('SOFTWARE\TightVNC', $false) } catch {}
    Say 'done'
    Close-Window 0
  }

  # ------------------------------------------------------------ questions
  Write-Host ''
  Write-Host 'WebTerm remote desktop setup (TightVNC Server)' -ForegroundColor Cyan
  Write-Host 'Installs a VNC server that starts with Windows and also shows the sign-in screen,'
  Write-Host 'so WebTerm can show and control this PC in the browser.'
  Write-Host ''

  $k = Open-ServerKey
  $oldPort = $k.GetValue('RfbPort')
  $k.Close()
  $defaultPort = 5900
  if ($oldPort) { $defaultPort = [int]$oldPort }
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
    $in = "$(Read-Host "VNC port [$defaultPort]")".Trim()
    if (-not $in) { $port = $defaultPort; break }
    $n = 0
    if ([int]::TryParse($in, [ref]$n) -and $n -ge 1 -and $n -le 65535) { $port = $n; break }
    Write-Host '  enter a number between 1 and 65535'
  }
  $generated = $false
  while ($true) {
    $pw = Read-Secret 'VNC password (up to 8 characters; Enter = generate one)'
    if (-not $pw) { $pw = New-Password; $generated = $true; break }
    if ($pw -notmatch '^[\x20-\x7E]+$') { Write-Host '  use letters, digits and plain ASCII symbols only'; continue }
    $pw2 = Read-Secret 'Repeat the password'
    if ($pw -ceq $pw2) { break }
    Write-Host '  the two entries differ - try again'
  }
  if ($pw.Length -gt 8) {
    $pw = $pw.Substring(0, 8)
    Warn "VNC uses only the first 8 characters - the password is: $pw"
  }
  $control = New-Password
  Write-Host ''

  # ------------------------------------------------------------ install / update
  $svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
  $installed = Get-TightVnc
  $newest = [version]'0.0'
  foreach ($e in $installed) { $v = Get-VersionOf $e; if ($v -gt $newest) { $newest = $v } }
  # Write the settings first so the service never runs without a password.
  Set-ServerConfig $pw $control $port
  if (-not $svc -or $newest -lt [version]$TightVersion) {
    $msi = Copy-ToSafePlace (Get-Installer)
    $sig = Get-AuthenticodeSignature -FilePath $msi
    if ("$($sig.Status)" -ne 'Valid' -or "$($sig.SignerCertificate.Subject)" -notmatch '(^|,\s*)(CN|O)="?GlavSoft') {
      Warn "the installer's digital signature could not be verified ($($sig.Status); $($sig.SignerCertificate.Subject))"
      if ((Read-Host 'Install it anyway? (y/N)') -notmatch '^(y|yes)$') { throw 'Cancelled.' }
    }
    Say 'installing TightVNC Server (service mode)...'
    $log = Join-Path $env:TEMP 'webterm-vnc-msi.log'
    $msiArgs = "/i `"$msi`" /qn /norestart /l*v `"$log`" ADDLOCAL=Server SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=0 SERVER_ALLOW_SAS=1 " +
      "SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=0 SET_RFBPORT=1 VALUE_OF_RFBPORT=$port"
    $p = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
    Remove-Item -LiteralPath (Split-Path -Parent $msi) -Recurse -Force -ErrorAction SilentlyContinue
    if (@(0, 1641, 3010) -notcontains $p.ExitCode) { throw "The TightVNC installer failed (exit code $($p.ExitCode)). Log: $log" }
  } else {
    Say "TightVNC Server $newest is already installed - updating its settings"
  }
  if (-not (Get-Service -Name $Service -ErrorAction SilentlyContinue)) { throw 'The TightVNC service was not installed.' }

  Stop-Service -Name $Service -Force -ErrorAction SilentlyContinue
  Set-ServerConfig $pw $control $port
  Set-Service -Name $Service -StartupType Automatic
  & sc.exe failure $Service reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
  Start-Service -Name $Service

  # ------------------------------------------------------------ firewall
  Remove-WebTermRule
  $remote = 'LocalSubnet'
  if ($allow) { $remote = $allow }
  New-NetFirewallRule -DisplayName $RuleName -Description 'Lets the WebTerm server reach TightVNC Server (remote desktop).' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemoteAddress $remote -Profile Any | Out-Null
  Disable-BroadVncRules
  Say "firewall: port $port open for $remote"

  $listening = $false
  for ($i = 0; $i -lt 20 -and -not $listening; $i++) {
    try {
      $c = New-Object Net.Sockets.TcpClient
      $c.Connect('127.0.0.1', $port)
      $c.Close()
      $listening = $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $listening) { Warn "TightVNC is not answering on port $port yet - check the 'TightVNC Server' service." }

  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | Select-Object -ExpandProperty IPAddress)
  Write-Host ''
  Say 'done - TightVNC Server runs as a Windows service (starts with Windows, works at the sign-in screen)'
  Write-Host ''
  Write-Host '   In WebTerm: Systems -> this PC -> edit:'
  Write-Host ('     IP / host     : ' + ($ips -join ', '))
  Write-Host "     VNC port      : $port"
  if ($generated) { Write-Host "     VNC password  : $pw" -ForegroundColor Yellow }
  else { Write-Host '     VNC password  : the one you just entered' }
  Write-Host '   then use the Screen button. At the sign-in screen use Keys -> Ctrl+Alt+Del.'
  Write-Host ''
  Write-Host "   TightVNC's own settings password (only to change TightVNC itself): $control"
  if (-not $allow) { Write-Host '   Accepting connections from the local network. Run this again with your WebTerm server IP to allow only it.' }
  Close-Window 0
} catch {
  Write-Host ''
  Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
  Close-Window 1
}
