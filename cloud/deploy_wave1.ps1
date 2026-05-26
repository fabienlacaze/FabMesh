# FabMesh Cloud — Wave 1 parity deploy.
# Usage:
#   $env:CLOUDFLARE_API_TOKEN = "<your_token>"
#   ./deploy_wave1.ps1
#
# Sets 2 new secrets and redeploys the Worker. Modal side already
# deployed by `modal deploy modal_app/app.py`.

if (-not $env:CLOUDFLARE_API_TOKEN) {
    Write-Host "ERROR: set CLOUDFLARE_API_TOKEN first." -ForegroundColor Red
    Write-Host '  $env:CLOUDFLARE_API_TOKEN = "<your_token>"'
    exit 1
}

$ErrorActionPreference = "Stop"

Write-Host "[1/3] Setting MODAL_TPOSE_URL..." -ForegroundColor Cyan
"https://fabienlacaze--myfabmesh-cloud-myfabmeshbackview-tpose.modal.run" | `
    npx wrangler secret put MODAL_TPOSE_URL

Write-Host "[2/3] Setting MODAL_RECTIFY_URL..." -ForegroundColor Cyan
"https://fabienlacaze--myfabmesh-cloud-myfabmeshbackview-rectify.modal.run" | `
    npx wrangler secret put MODAL_RECTIFY_URL

Write-Host "[3/3] Deploying Worker..." -ForegroundColor Cyan
npx wrangler deploy

Write-Host "Wave 1 deploy done." -ForegroundColor Green
