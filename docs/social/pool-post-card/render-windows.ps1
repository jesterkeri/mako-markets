# Render the pool post cards with headless Chrome (same pools and size as render.js: 1600x900 at 1.5x = 2400x1350).
param([string]$CardDir, [string]$OutDir, [string]$ProfileDir)
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$apos = [char]0x2019
$pools = @(
  @{ out='mako-state-police-pool-card.png'; kicker='Nigeria · Constitution review'; cat='POLITICS';
     q='Will President Tinubu sign the state police constitutional amendment (Sixth Alteration Bill, 2026) by 2 November?';
     sub='Betting closes Sun 1 Nov, 23:59 WAT · Hosted by Mako Market'; pc='Sun 23:59';
     yes='He signs it by 2 November.'; no='Not signed by 2 November.' },
  @{ out='mako-senate-offenders-bill-pool-card.png'; kicker='Nigeria · Senate'; cat='POLITICS';
     q="Will the Senate pass Tinubu${apos}s bill letting Nigerians convicted abroad serve their sentences at home by 6 November?";
     sub='Betting closes Thu 5 Nov, 23:59 WAT · Hosted by Mako Market'; pc='Thu 23:59';
     yes='The Senate passes it by 6 November.'; no='Still not passed on 6 November.' },
  @{ out='mako-nasdaq-correction-pool-card.png'; kicker='AI selloff · Wall Street'; cat='MARKETS';
     q='Will the Nasdaq fall into a correction by 5 November?';
     sub='Betting closes Wed 4 Nov, 23:59 WAT · Hosted by Mako Market'; pc='Wed 23:59';
     yes='It closes 10% below its record.'; no='It stays above correction.' },
  @{ out='mako-palantir-earnings-pool-card.png'; kicker='Palantir earnings · 2 Nov'; cat='MARKETS';
     q='Will Palantir beat analyst estimates when it reports on 2 November?';
     sub='Betting closes Sun 1 Nov, 11:59 WAT · Hosted by Mako Market'; pc='Sun 11:59';
     yes='It beats the estimate.'; no='It matches or misses.' }
)
$base = 'file:///' + (($CardDir -replace '\\','/') -replace ' ','%20') + '/card.html'
foreach ($p in $pools) {
  $qs = ($p.Keys | Where-Object { $_ -ne 'out' } | ForEach-Object { $_ + '=' + [uri]::EscapeDataString($p[$_]) }) -join '&'
  $png = Join-Path $OutDir $p.out
  $cargs = @('--headless=new','--disable-gpu','--hide-scrollbars','--allow-file-access-from-files',
            "--user-data-dir=$ProfileDir",'--window-size=1600,900','--force-device-scale-factor=1.5',
            '--virtual-time-budget=5000',"--screenshot=$png","${base}?${qs}")
  Start-Process -FilePath $chrome -ArgumentList ($cargs | ForEach-Object { '"' + $_ + '"' }) -Wait -NoNewWindow -RedirectStandardError (Join-Path $ProfileDir '..\chrome-stderr.txt')
  Write-Output ("{0}  exists={1}" -f $p.out, (Test-Path $png))
}

