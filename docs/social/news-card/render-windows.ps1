# Render news headline cards with headless Chrome: 1600x900 at 1.5x = 2400x1350 PNG for X.
# News only: no pool, no YES/NO, no mascot. The three approved templates (1 Nov 2026), one HTML file each:
#   lead.html          Dark lead: Market intel lead story on the black grid + an Earlier row
#   phone.html         In the app: yellow frame, headline + the story in Market intel on a phone
#   photo-inset.html   Photo inset: light theme, rounded photo panel, headline below
# Edit the cards list below for each new story (headline, source, date, photo, crop position, credit).
# Headlines are verbatim from makomarket.xyz/news with the source named. Use dates, not "6H ago".
# Photos: free-licence stock only (Unsplash/Pexels), saved in photos/, credited on the card. Ask before downloading.
# Usage: powershell -File render-windows.ps1 -CardDir <this folder> -OutDir <out> -ProfileDir <temp folder>
param([string]$CardDir, [string]$OutDir, [string]$ProfileDir)
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$dot = [char]0x00B7; $apos = [char]0x2019
$h = 'Binance opens crypto withdrawals in phases starting with bitcoin following $6.3 billion hack'
$fbi = "FBI confirms North Korea${apos}s role in `$6 billion Binance hack, asks DeFi community to block BTC, ETH, SOL addresses"
$pacs = 'Crypto PACs made big Republican push in final weeks before November 3 election'
$brown = "Sherrod Brown${apos}s Ohio edge threatens a rough go for crypto next year"
$cards = @(
  @{ out='mako-news-lead.png'; file='lead.html'; kicker="Market intel $dot 1 Nov 2026"; cat='CRYPTO'; src='coindesk.com'; h=$h;
     ewhen='31 OCT'; ecat='CRYPTO'; eh=$fbi },
  @{ out='mako-news-in-the-app.png'; file='phone.html'; label='New in Market intel'; h=$h;
     src="coindesk.com $dot 1 Nov 2026"; count="LATEST $dot CRYPTO"; pcat='CRYPTO'; pmeta="1 NOV $dot coindesk.com";
     list=(@("1 NOV~~CRYPTO~~$pacs", "1 NOV~~CRYPTO~~$brown", "31 OCT~~CRYPTO~~$fbi") -join '||') },
  @{ out='mako-news-photo-inset.png'; file='photo-inset.html'; kicker="Market intel $dot 1 Nov 2026"; cat='CRYPTO';
     src="Source: coindesk.com"; h=$h; img='photos/unsplash-mckenzie-bitcoin-monitor.jpg'; pos='center 8%';
     credit=("Photo: Andr" + [char]0x00E9 + " Fran" + [char]0x00E7 + "ois McKenzie / Unsplash") }
)
foreach ($c in $cards) {
  $base = 'file:///' + (($CardDir -replace '\\','/') -replace ' ','%20') + '/' + $c.file
  $qs = ($c.Keys | Where-Object { $_ -notin @('out','file') } | ForEach-Object { $_ + '=' + [uri]::EscapeDataString($c[$_]) }) -join '&'
  $png = Join-Path $OutDir $c.out
  $cargs = @('--headless=new','--disable-gpu','--hide-scrollbars','--allow-file-access-from-files',
            "--user-data-dir=$ProfileDir",'--window-size=1600,900','--force-device-scale-factor=1.5',
            '--virtual-time-budget=5000',"--screenshot=$png","${base}?${qs}")
  Start-Process -FilePath $chrome -ArgumentList ($cargs | ForEach-Object { '"' + $_ + '"' }) -Wait -NoNewWindow -RedirectStandardError (Join-Path $OutDir 'chrome-stderr.txt')
  Write-Output ("{0}  exists={1}" -f $c.out, (Test-Path $png))
}
