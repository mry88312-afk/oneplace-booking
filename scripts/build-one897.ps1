$ErrorActionPreference = 'Stop'
$previous = $env:VITE_REMITTANCE_API_BASE
try {
    $env:VITE_REMITTANCE_API_BASE = '/booking-link'
    npm run check
    if ($LASTEXITCODE -ne 0) { throw '型別檢查失敗' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '建置失敗' }
    $assets = Get-ChildItem -LiteralPath 'dist/public/assets' -Filter '*.js'
    if (-not ($assets | Select-String -SimpleMatch '/booking-link/line-session' -Quiet)) { throw '缺少正式 LINE 驗證程式' }
    npx esbuild deploy/gcp/pilot.js --bundle --platform=browser --outfile=pilot.bundle.js
    if ($LASTEXITCODE -ne 0) { throw '入口頁建置失敗' }
    [IO.File]::WriteAllText((Join-Path (Get-Location) 'pilot.js'), [IO.File]::ReadAllText((Join-Path (Get-Location) 'pilot.bundle.js')).Replace('PILOT_LIFF','2006833424-kPq8efDV'), [Text.UTF8Encoding]::new($false))
} finally {
    $env:VITE_REMITTANCE_API_BASE = $previous
}
