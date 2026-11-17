$ErrorActionPreference = 'Stop'
npm run check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$testFiles = @(rg --files -g '*.test.ts')
& .\node_modules\.bin\tsx.cmd --test --test-concurrency=1 @testFiles
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:VITE_REMITTANCE_API_BASE = '/booking-link'
npm run build
exit $LASTEXITCODE
