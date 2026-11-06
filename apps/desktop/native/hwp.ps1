# ANB Hangul (HWP) automation through the official HWPFrame.HwpObject COM server.
# Runs Hangul invisibly; never touches the user's open Hangul windows (separate instance).
#
#   powershell -File hwp.ps1 write <spec.json> <out.hwpx|.hwp|.docx> [<out.pdf>]
#   powershell -File hwp.ps1 read  <in.hwp|.hwpx|.doc...> <out.txt>
#
# spec.json: { "title": "...", "subtitle": "...", "blocks": [
#   {"type":"heading","level":1,"text":"1. 사업 개요"}, {"type":"paragraph","text":"..."},
#   {"type":"bullets","items":["..."]}, {"type":"table","headers":["..."],"rows":[["..."]]},
#   {"type":"pagebreak"} ] }
# Result: one JSON line on stdout {"ok":true,...} (UTF-8 files carry the text; stdout stays ASCII-safe).
# Before that, a {"pid":N} line names the automation Hwp.exe so the caller can kill it on timeout.
#
# Hangul shows a blocking "파일에 접근하려는 시도" security prompt for automation access to most
# folders (no approval module is installed), but not for the user's temp folder. So every file
# Hangul touches is staged in a private temp folder: inputs are copied in, outputs are saved
# there and then moved to their destination.

param([string]$Cmd, [string]$In, [string]$Out, [string]$Pdf)
$ErrorActionPreference = 'Stop'

function Done($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); }

# Scales every table in an HWPX file to the given total width (HWPUNIT), keeping column ratios.
function Widen-Tables([string]$path, [int]$target) {
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::Open($path, 'Update')
  try {
    foreach ($entry in @($zip.Entries | Where-Object { $_.FullName -like 'Contents/section*.xml' })) {
      $reader = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
      $xml = $reader.ReadToEnd(); $reader.Close()
      $fixed = [regex]::Replace($xml, '(?s)<hp:tbl\b.*?</hp:tbl>', {
        param($m)
        $t = $m.Value
        $w = [regex]::Match($t, '<hp:sz width="(\d+)"')
        if (-not $w.Success -or [int]$w.Groups[1].Value -le 0) { return $t }
        $f = $target / [double]$w.Groups[1].Value
        $t = [regex]::Replace($t, '(<hp:cellSz width=")(\d+)', { param($c) $c.Groups[1].Value + [string][int]([int]$c.Groups[2].Value * $f) })
        return $t.Substring(0, $w.Index) + '<hp:sz width="' + $target + '"' + $t.Substring($w.Index + $w.Length)
      })
      if ($fixed -ne $xml) {
        $name = $entry.FullName
        $entry.Delete()
        $new = $zip.CreateEntry($name)
        $writer = New-Object IO.StreamWriter($new.Open(), (New-Object Text.UTF8Encoding($false)))
        $writer.Write($fixed); $writer.Close()
      }
    }
  } finally { $zip.Dispose() }
}

$h = $null
$stage = Join-Path ([IO.Path]::GetTempPath()) ('anb-hwp-' + [guid]::NewGuid().ToString('N'))
try {
  [void](New-Item -ItemType Directory -Path $stage -Force)
  $before = @(Get-Process Hwp -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $h = New-Object -ComObject HWPFrame.HwpObject
  # Report only a new, COM-launched instance (never the user's own Hangul windows).
  $mine = Get-CimInstance Win32_Process -Filter "Name='Hwp.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $before -notcontains $_.ProcessId -and [string]$_.CommandLine -match '-Automation' } | Select-Object -First 1
  if ($mine) { [Console]::Out.WriteLine('{"pid":' + $mine.ProcessId + '}'); [Console]::Out.Flush() }
  try { [void]$h.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule') } catch { }
  $h.XHwpWindows.Item(0).Visible = $false
  # Answer Hangul's own message boxes automatically (they would block an invisible instance):
  # OK / OK-Cancel -> OK (e.g. "호환 문서 … 계속"), Yes-No -> Yes.
  try { [void]$h.SetMessageBoxMode(0x10011) } catch { }
  $act = $h.HAction
  $ps = $h.HParameterSet

  if ($Cmd -eq 'read') {
    $fmt = ''
    if ($In -match '\.hwpx$') { $fmt = 'HWPX' } elseif ($In -match '\.hwp$') { $fmt = 'HWP' }
    $src = Join-Path $stage ('in' + [IO.Path]::GetExtension($In))
    Copy-Item -LiteralPath $In -Destination $src
    if (-not $h.Open($src, $fmt, 'forceopen:true;versionwarning:false')) { throw "cannot open $In" }
    $text = $h.GetTextFile('TEXT', '')
    [IO.File]::WriteAllText($Out, $text, (New-Object Text.UTF8Encoding($false)))
    Done @{ ok = $true; chars = $text.Length }
    return
  }

  if ($Cmd -ne 'write') { throw "unknown command $Cmd" }
  $finalOut = $Out; $finalPdf = $Pdf
  $Out = Join-Path $stage ('out' + [IO.Path]::GetExtension($finalOut))
  if ($Pdf) { $Pdf = Join-Path $stage 'out.pdf' }
  $spec = [IO.File]::ReadAllText($In, [Text.Encoding]::UTF8) | ConvertFrom-Json

  function SetChar([double]$pt, [bool]$bold, [string]$face) {
    [void]$act.GetDefault('CharShape', $ps.HCharShape.HSet)
    $cs = $ps.HCharShape
    $cs.Height = [int]($pt * 100)
    $cs.Bold = [int]$bold
    if ($face) {
      $cs.FaceNameHangul = $face; $cs.FaceNameLatin = $face; $cs.FaceNameHanja = $face
      $cs.FaceNameJapanese = $face; $cs.FaceNameOther = $face; $cs.FaceNameSymbol = $face; $cs.FaceNameUser = $face
      $cs.FontTypeHangul = 1; $cs.FontTypeLatin = 1; $cs.FontTypeHanja = 1
      $cs.FontTypeJapanese = 1; $cs.FontTypeOther = 1; $cs.FontTypeSymbol = 1; $cs.FontTypeUser = 1
    }
    [void]$act.Execute('CharShape', $cs.HSet)
  }
  function SetPara([int]$align, [int]$spacing, [int]$before, [int]$after) {
    # align: 0 justify, 1 left, 2 right, 3 center. spacing: percent. before/after: HWPUNIT (1pt = 100)
    [void]$act.GetDefault('ParagraphShape', $ps.HParaShape.HSet)
    $p = $ps.HParaShape
    $p.AlignType = $align; $p.LineSpacingType = 0; $p.LineSpacing = $spacing
    $p.PrevSpacing = $before; $p.NextSpacing = $after
    [void]$act.Execute('ParagraphShape', $p.HSet)
  }
  function Text([string]$s) {
    if (-not $s) { return }
    [void]$act.GetDefault('InsertText', $ps.HInsertText.HSet)
    $ps.HInsertText.Text = $s
    [void]$act.Execute('InsertText', $ps.HInsertText.HSet)
  }
  function Para { [void]$act.Run('BreakPara') }

  $body = '맑은 고딕'
  $head = '맑은 고딕'
  if ($spec.font) { $body = $spec.font; $head = $spec.font }

  # Title block
  if ($spec.title) {
    SetPara 3 160 0 600; SetChar 22 $true $head; Text $spec.title; Para
    if ($spec.subtitle) { SetPara 3 160 0 1200; SetChar 13 $false $body; Text $spec.subtitle; Para }
  }

  $tables = 0
  foreach ($b in $spec.blocks) {
    switch ($b.type) {
      'heading' {
        $lv = 1; if ($b.level) { $lv = [int]$b.level }
        $size = 16; if ($lv -eq 2) { $size = 13.5 } elseif ($lv -ge 3) { $size = 12 }
        SetPara 1 160 1000 300; SetChar $size $true $head; Text $b.text; Para
      }
      'paragraph' {
        SetPara 0 170 0 400; SetChar 11 $false $body
        $lines = ([string]$b.text) -split "`n"
        foreach ($l in $lines) { Text $l; Para }
      }
      'bullets' {
        SetPara 1 170 0 150; SetChar 11 $false $body
        foreach ($it in $b.items) { Text ("  • " + $it); Para }
      }
      'table' {
        $headers = @($b.headers)
        $rows = @($b.rows)
        $cols = [Math]::Max(1, $headers.Count)
        $nrows = $rows.Count + 1
        SetPara 3 130 0 0; SetChar 10 $false $body
        [void]$act.GetDefault('TableCreate', $ps.HTableCreation.HSet)
        $tc = $ps.HTableCreation
        $tc.Rows = $nrows; $tc.Cols = $cols; $tc.HeightType = 0
        # Full text width (A4 minus default margins ~ 150mm = 42500 HWPUNIT); columns share it equally.
        $tc.WidthType = 2; $tc.WidthValue = 42500
        [void]$act.Execute('TableCreate', $tc.HSet)
        for ($c = 0; $c -lt $cols; $c++) {
          SetPara 3 130 0 0; SetChar 10 $true $body; Text ([string]$headers[$c])
          [void]$act.Run('TableRightCell')
        }
        for ($r = 0; $r -lt $rows.Count; $r++) {
          $row = @($rows[$r])
          for ($c = 0; $c -lt $cols; $c++) {
            SetPara 1 130 0 0; SetChar 10 $false $body
            $v = ''; if ($c -lt $row.Count) { $v = [string]$row[$c] }
            Text $v
            if (-not ($r -eq $rows.Count - 1 -and $c -eq $cols - 1)) { [void]$act.Run('TableRightCell') }
          }
        }
        # Leave the table: caret to document end, then a fresh paragraph.
        [void]$act.Run('Cancel')
        [void]$act.Run('MoveDocEnd')
        SetPara 0 170 0 400; Para
        $tables++
      }
      'pagebreak' { [void]$act.Run('BreakPage') }
      default { SetPara 0 170 0 400; SetChar 11 $false $body; Text ([string]$b.text); Para }
    }
  }

  # Save as HWPX first; widen tables in its XML (COM table-width options are ignored by this
  # Hangul version), then reopen the fixed file to produce .hwp / .pdf from it.
  $hwpx = $Out
  if ($Out -notmatch '\.hwpx$') { $hwpx = [IO.Path]::ChangeExtension($Out, '.tmp.hwpx') }
  if (-not $h.SaveAs($hwpx, 'HWPX', '')) { throw "save failed: $hwpx" }
  if ($tables -gt 0) {
    [void]$h.Clear(1)
    Widen-Tables $hwpx 42520
    if (-not $h.Open($hwpx, 'HWPX', 'forceopen:true')) { throw "reopen failed: $hwpx" }
  }
  if ($hwpx -ne $Out) {
    $fmtOut = 'HWP'; if ($Out -match '\.docx$') { $fmtOut = 'OOXML' }  # Word
    if (-not $h.SaveAs($Out, $fmtOut, '')) { throw "save failed: $Out" }
  }
  $pdfOk = $false
  if ($Pdf) { try { $pdfOk = [bool]$h.SaveAs($Pdf, 'PDF', '') } catch { $pdfOk = $false } }
  $pages = $h.PageCount
  [void]$h.Clear(1)
  $dir = Split-Path -Parent $finalOut
  if ($dir) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  Move-Item -LiteralPath $Out -Destination $finalOut -Force
  if ($pdfOk) { Move-Item -LiteralPath $Pdf -Destination $finalPdf -Force }
  Done @{ ok = $true; out = $finalOut; pdf = $pdfOk; tables = $tables; pages = $pages }
}
catch {
  Done @{ ok = $false; error = $_.Exception.Message }
}
finally {
  if ($h) { try { $h.Clear(1) } catch { }; try { $h.Quit() } catch { } }
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
