# OGP画像（img/og/cNN.jpg）と発行元ロゴ（img/og/logo.png）を作り直す。
# ビルドには組み込んでいない。写真を差し替えたとき・版面（tools/ogcover.html）を直したときだけ実行する。
#
#   powershell -ExecutionPolicy Bypass -File tools/ogcover.ps1 -Src <1200x630 の写真を cNN.webp の名前で置いたフォルダ>
#
# 写真は images.unsplash.com/<photo>?fm=webp&q=82&fit=crop&w=1200&h=630 で取ったもの（リポジトリには入れない）。
# Edge のヘッドレスで ogcover.html を撮り、System.Drawing で JPEG にする。Windows 専用。
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [int]$Quality = 86
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'msedge.exe が見つかりません' }

$root = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $root 'img\og'
$page = ([Uri](Join-Path $PSScriptRoot 'ogcover.html')).AbsoluteUri
$tmp  = Join-Path ([IO.Path]::GetTempPath()) ("ogcover-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $out, $tmp | Out-Null

function Shot([string]$url, [string]$png, [int]$w, [int]$h) {
  $a = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
         '--allow-file-access-from-files', "--user-data-dir=$tmp\profile",
         "--window-size=$w,$h", "--screenshot=$png", $url)
  Start-Process -FilePath $edge -ArgumentList $a -Wait -WindowStyle Hidden
  if (-not (Test-Path $png)) { throw "撮れませんでした: $url" }
}

$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$enc  = New-Object System.Drawing.Imaging.EncoderParameters 1
$enc.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

try {
  # 写真は c01 から連番で揃っていること。欠けたまま走ると、前の回の絵が残っても気づけない
  $files = @(Get-ChildItem -LiteralPath $Src -Filter 'c*.webp' | Sort-Object Name)
  if (-not $files.Count) { throw "写真がありません: $Src" }
  for ($i = 0; $i -lt $files.Count; $i++) {
    $want = 'c{0:d2}' -f ($i + 1)
    if ($files[$i].BaseName -ne $want) { throw "連番になっていません: $want.webp がありません" }
  }
  $stale = @(Get-ChildItem -LiteralPath $out -Filter 'c*.jpg' | Where-Object { $files.BaseName -notcontains $_.BaseName })
  if ($stale.Count) { throw "img/og/ に対応する写真のない絵があります: $($stale.Name -join ', ')" }

  foreach ($f in $files) {
    $png = Join-Path $tmp ($f.BaseName + '.png')
    Shot ($page + '?src=' + [Uri]::EscapeDataString(([Uri]$f.FullName).AbsoluteUri)) $png 1200 630
    $bmp = [System.Drawing.Image]::FromFile($png)
    try {
      if ($bmp.Width -ne 1200 -or $bmp.Height -ne 630) { throw "大きさが違います: $($f.Name) $($bmp.Width)x$($bmp.Height)" }
      $bmp.Save((Join-Path $out ($f.BaseName + '.jpg')), $jpeg, $enc)
    } finally { $bmp.Dispose() }
    Write-Host "img/og/$($f.BaseName).jpg"
  }

  $logo = Join-Path $out 'logo.png'
  Shot ($page + '?logo=1') $logo 512 512
  Write-Host 'img/og/logo.png'
  Write-Host "写真は $($files.Count) 枚。tools/build.js の COVERS と同じ数にすること"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
