#Requires -Version 5.1
<#
  Unit tests for scripts/kill_stale_bookvoice.ps1 using injected process snapshots.
  Run: powershell -NoProfile -File tests/test_kill_stale_bookvoice.ps1
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
. (Join-Path $root 'scripts\kill_stale_bookvoice.ps1')

$failed = 0
function Assert-Equal($actual, $expected, $name) {
    $a = (@($actual) | Sort-Object) -join ','
    $e = (@($expected) | Sort-Object) -join ','
    if ($a -ne $e) {
        Write-Host "FAIL: $name expected=[$e] actual=[$a]" -ForegroundColor Red
        $script:failed++
    } else {
        Write-Host "PASS: $name" -ForegroundColor Green
    }
}

$runtime = 'C:\Users\test\AppData\Local\BookVoice'
$venvPy = Join-Path $runtime '.venv\Scripts\python.exe'
$basePy = 'C:\Python311\python.exe'

# Parent is venv python (matched); child base interpreter runs uvicorn but has no venv path.
$twoProcessTree = @(
    [pscustomobject]@{
        ProcessId = 100
        ParentProcessId = 1
        Name = 'python.exe'
        ExecutablePath = $venvPy
        CommandLine = "`"$venvPy`" -m uvicorn main:app --host 127.0.0.1 --port 8000"
    },
    [pscustomobject]@{
        ProcessId = 101
        ParentProcessId = 100
        Name = 'python.exe'
        ExecutablePath = $basePy
        CommandLine = "`"$basePy`" -m uvicorn main:app --host 127.0.0.1 --port 8000"
    },
    # Unrelated app on port 8000 — must never be selected.
    [pscustomobject]@{
        ProcessId = 200
        ParentProcessId = 1
        Name = 'python.exe'
        ExecutablePath = 'C:\other\app\.venv\Scripts\python.exe'
        CommandLine = '"C:\other\app\.venv\Scripts\python.exe" -m uvicorn other:app --port 8000'
    },
    [pscustomobject]@{
        ProcessId = 201
        ParentProcessId = 1
        Name = 'node.exe'
        ExecutablePath = 'C:\nodejs\node.exe'
        CommandLine = 'node server.js'
    }
)

$pids = Find-BookVoiceServerTreePids -RuntimeDir $runtime -ProcessSnapshot $twoProcessTree
Assert-Equal $pids @(100, 101) 'two-process BookVoice tree includes parent and child'

$onlyChildWouldSurviveOldLogic = @(
    [pscustomobject]@{
        ProcessId = 300
        ParentProcessId = 1
        Name = 'python.exe'
        ExecutablePath = $venvPy
        CommandLine = "`"$venvPy`" -m uvicorn main:app --port 8000"
    },
    [pscustomobject]@{
        ProcessId = 301
        ParentProcessId = 300
        Name = 'python.exe'
        ExecutablePath = $basePy
        # Child has uvicorn but NO runtime path — old bat filter missed this.
        CommandLine = "`"$basePy`" -m uvicorn main:app --port 8000"
    }
)
$pids2 = Find-BookVoiceServerTreePids -RuntimeDir $runtime -ProcessSnapshot $onlyChildWouldSurviveOldLogic
Assert-equal $pids2 @(300, 301) 'child without venv marker still terminated via parent tree'

$unrelatedOnly = @(
    [pscustomobject]@{
        ProcessId = 400
        ParentProcessId = 1
        Name = 'python.exe'
        ExecutablePath = 'C:\tools\python.exe'
        CommandLine = 'python -m http.server 8000'
    }
)
$pids3 = Find-BookVoiceServerTreePids -RuntimeDir $runtime -ProcessSnapshot $unrelatedOnly
Assert-Equal $pids3 @() 'unrelated port-8000 process is not selected'

$missing = Find-BookVoiceServerTreePids -RuntimeDir $runtime -ProcessSnapshot @()
Assert-equal $missing @() 'empty snapshot yields no victims'

$stopped = Stop-BookVoiceServerTree -RuntimeDir $runtime -WhatIf -ProcessSnapshot $twoProcessTree
Assert-Equal $stopped @(100, 101) 'WhatIf returns tree PIDs without requiring live processes'

if ($failed -gt 0) {
    Write-Host "`n$failed test(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "`nAll kill_stale_bookvoice tests passed" -ForegroundColor Green
exit 0
