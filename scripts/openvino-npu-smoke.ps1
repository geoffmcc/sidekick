<#
.SYNOPSIS
    Run the Sidekick OpenVINO NPU hardware smoke test on native Windows.

.DESCRIPTION
    Thin wrapper around src/compute/openvino/smoke_test.py. It drives the
    production helper (helper.py) over its real stdin/stdout JSON protocol and
    fails unless a genuine embedding executes on the required device (NPU by
    default). Fallback is disabled by default so a silent CPU execution fails
    the test.

    This does NOT require a running Sidekick server or any network listener.

.PARAMETER Python
    Absolute path to the isolated Python 3.12 executable that has the certified
    openvino / transformers / numpy packages installed.

.PARAMETER ModelsDir
    Absolute path to the trusted model store. It must contain a subdirectory
    named exactly after the model id (e.g. <ModelsDir>\qwen3-embedding-0.6b-int8)
    with openvino_model.xml, openvino_model.bin, and the local tokenizer files.

.PARAMETER ModelId
    Certified model id to test. Defaults to qwen3-embedding-0.6b-int8.

.PARAMETER RequiredDevice
    Device the embedding must run on. Defaults to NPU.

.PARAMETER Fallback
    'none' (default, disabled) or 'same_model_cpu'.

.EXAMPLE
    .\scripts\openvino-npu-smoke.ps1 `
        -Python "$HOME\.venvs\sidekick-openvino\Scripts\python.exe" `
        -ModelsDir 'C:\ProgramData\Sidekick\openvino-models'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Python,
    [Parameter(Mandatory = $true)] [string] $ModelsDir,
    [string] $ModelId = 'qwen3-embedding-0.6b-int8',
    [ValidateSet('query', 'document')] [string] $InputKind = 'query',
    [string] $Text = 'Smoke test: verify Intel NPU embedding execution.',
    [string] $RequiredDevice = 'NPU',
    [ValidateSet('none', 'same_model_cpu')] [string] $Fallback = 'none',
    [int] $StartupTimeoutMs = 120000,
    [int] $InferenceTimeoutMs = 180000,
    [switch] $ShowEmbedding
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    Write-Error "Python executable not found: $Python"
    exit 2
}
if (-not (Test-Path -LiteralPath $ModelsDir -PathType Container)) {
    Write-Error "Model store directory not found: $ModelsDir"
    exit 2
}

# Locate smoke_test.py relative to this script (scripts/ -> src/compute/openvino/).
$repoRoot = Split-Path -Parent $PSScriptRoot
$smokeScript = Join-Path $repoRoot 'src\compute\openvino\smoke_test.py'
if (-not (Test-Path -LiteralPath $smokeScript -PathType Leaf)) {
    Write-Error "Smoke test script not found: $smokeScript"
    exit 2
}

$smokeArgs = @(
    $smokeScript,
    '--python', $Python,
    '--models-dir', $ModelsDir,
    '--model-id', $ModelId,
    '--input-kind', $InputKind,
    '--text', $Text,
    '--required-device', $RequiredDevice,
    '--fallback', $Fallback,
    '--startup-timeout-ms', $StartupTimeoutMs,
    '--inference-timeout-ms', $InferenceTimeoutMs
)
if ($ShowEmbedding) { $smokeArgs += '--show-embedding' }

Write-Host "Running OpenVINO NPU smoke test..." -ForegroundColor Cyan
& $Python @smokeArgs
$code = $LASTEXITCODE

if ($code -eq 0) {
    Write-Host "OpenVINO NPU smoke test PASSED." -ForegroundColor Green
} else {
    Write-Host "OpenVINO NPU smoke test FAILED (exit $code)." -ForegroundColor Red
}
exit $code
