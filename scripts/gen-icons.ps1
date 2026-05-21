# Generates Android launcher assets from the brand mark (Asset 910.png).
# - Adaptive foreground: transparent canvas with the M centred at ~42% width
#   (aspect-preserved) so launchers that zoom the foreground (MIUI) keep it
#   inside the masked safe zone instead of clipping/stretching it.
# - Legacy ic_launcher / ic_launcher_round: brand-dark squircle / circle with
#   the M composited (for pre-API-26 launchers).
Add-Type -AssemblyName System.Drawing

$src = "C:\Users\MyBook Hype AMD\Pictures\POS\LOGO MANDALIKA\Asset 910.png"
$res = "C:\Users\MyBook Hype AMD\Downloads\mandalika-pos\apps\pos\android\app\src\main\res"
$logo = [System.Drawing.Image]::FromFile($src)
$ratio = $logo.Width / $logo.Height
$bg = [System.Drawing.Color]::FromArgb(255, 26, 16, 8)  # #1A1008

function New-Canvas([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  return ,@($bmp, $g)
}
function Draw-Logo($g, [int]$size, [double]$frac) {
  $w = [int]($size * $frac); $h = [int]($w / $ratio)
  $x = [int](($size - $w) / 2); $y = [int](($size - $h) / 2)
  $rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
  $g.DrawImage($logo, $rect)
}

$adaptive = [ordered]@{ ldpi = 81; mdpi = 108; hdpi = 162; xhdpi = 216; xxhdpi = 324; xxxhdpi = 432 }
$legacy   = [ordered]@{ ldpi = 36; mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }

# Tracked adaptive foreground in drawable/ (NOT gitignored — this is the asset
# the CI APK build actually uses; mipmap-*/ic_launcher*.png are gitignored).
$c = New-Canvas 432; $bmp = $c[0]; $g = $c[1]
Draw-Logo $g 432 0.42
$bmp.Save((Join-Path $res "drawable\ic_launcher_fg.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# Per-density mipmap foregrounds (gitignored; local/legacy convenience only).
foreach ($d in $adaptive.Keys) {
  $dir = Join-Path $res "mipmap-$d"
  if (-not (Test-Path $dir)) { continue }
  $size = $adaptive[$d]
  $c = New-Canvas $size; $bmp = $c[0]; $g = $c[1]
  Draw-Logo $g $size 0.42
  $bmp.Save((Join-Path $dir "ic_launcher_foreground.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

foreach ($d in $legacy.Keys) {
  $dir = Join-Path $res "mipmap-$d"
  if (-not (Test-Path $dir)) { continue }
  $size = $legacy[$d]

  # Squircle (rounded-rect) dark + M
  $c = New-Canvas $size; $bmp = $c[0]; $g = $c[1]
  $r = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush($bg)
  $g.FillPath($brush, $path)
  Draw-Logo $g $size 0.56
  $bmp.Save((Join-Path $dir "ic_launcher.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $brush.Dispose(); $path.Dispose(); $g.Dispose(); $bmp.Dispose()

  # Round (circle) dark + M
  $c = New-Canvas $size; $bmp = $c[0]; $g = $c[1]
  $brush = New-Object System.Drawing.SolidBrush($bg)
  $g.FillEllipse($brush, 0, 0, $size, $size)
  Draw-Logo $g $size 0.56
  $bmp.Save((Join-Path $dir "ic_launcher_round.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $brush.Dispose(); $g.Dispose(); $bmp.Dispose()
}

$logo.Dispose()
"done"
