#Requires -Version 5.1
<#
.SYNOPSIS
  Stop leftover BookVoice uvicorn process trees for a given runtime directory.

.DESCRIPTION
  Matches only python processes whose command line runs uvicorn main:app and
  whose executable path or command line references the BookVoice venv under
  RuntimeDir. Descendants of matched parents are terminated even when the
  child base interpreter path does not contain the venv marker.

  Never kills processes solely because they listen on port 8000.

.PARAMETER RuntimeDir
  BookVoice runtime directory (e.g. %LocalAppData%\BookVoice).
  When provided (normal launcher use), stale servers are stopped immediately.
  When omitted (dot-source for unit tests), only functions are defined.

.PARAMETER WhatIf
  List PIDs that would be stopped without terminating them.

.PARAMETER ProcessSnapshot
  Optional process objects for unit tests
  (ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine).
#>
[CmdletBinding()]
param(
    [string]$RuntimeDir = '',
    [switch]$WhatIf,
    [object[]]$ProcessSnapshot = $null
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

function Get-ProcessSnapshot {
    param([object[]]$Injected)
    if ($null -ne $Injected) {
        return @($Injected)
    }
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -and ($_.Name -match '^(python(\d+)?|py)\.exe$') })
}

function Test-IsBookVoiceUvicorn {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)][string]$VenvMarker
    )
    $cmd = [string]($Process.CommandLine)
    if (-not $cmd) { return $false }
    if ($cmd -notmatch 'uvicorn') { return $false }
    if ($cmd -notmatch 'main:app') { return $false }

    $exe = [string]($Process.ExecutablePath)
    $haystack = ($exe + ' ' + $cmd)
    return $haystack.IndexOf($VenvMarker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-DescendantProcessIds {
    param(
        [Parameter(Mandatory = $true)][int]$RootPid,
        [Parameter(Mandatory = $true)][hashtable]$ChildrenByParent
    )
    $result = New-Object System.Collections.Generic.List[int]
    $stack = New-Object System.Collections.Generic.Stack[int]
    $stack.Push($RootPid)
    $seen = @{}
    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        if ($seen.ContainsKey($current)) { continue }
        $seen[$current] = $true
        if ($ChildrenByParent.ContainsKey($current)) {
            foreach ($child in $ChildrenByParent[$current]) {
                $result.Add([int]$child) | Out-Null
                $stack.Push([int]$child)
            }
        }
    }
    return @($result)
}

function Find-BookVoiceServerTreePids {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeDir,
        [object[]]$ProcessSnapshot = $null
    )

    $resolved = [System.IO.Path]::GetFullPath($RuntimeDir)
    $venvMarker = [System.IO.Path]::Combine($resolved, '.venv')
    $procs = Get-ProcessSnapshot -Injected $ProcessSnapshot

    $childrenByParent = @{}
    foreach ($p in $procs) {
        $ppid = [int]$p.ParentProcessId
        if (-not $childrenByParent.ContainsKey($ppid)) {
            $childrenByParent[$ppid] = New-Object System.Collections.Generic.List[int]
        }
        $childrenByParent[$ppid].Add([int]$p.ProcessId) | Out-Null
    }

    $toStop = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($p in $procs) {
        if (-not (Test-IsBookVoiceUvicorn -Process $p -VenvMarker $venvMarker)) {
            continue
        }
        $rootPid = [int]$p.ProcessId
        [void]$toStop.Add($rootPid)
        foreach ($childPid in (Get-DescendantProcessIds -RootPid $rootPid -ChildrenByParent $childrenByParent)) {
            [void]$toStop.Add([int]$childPid)
        }
    }

    return @($toStop | Sort-Object -Descending)
}

function Stop-BookVoiceServerTree {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeDir,
        [switch]$WhatIf,
        [object[]]$ProcessSnapshot = $null
    )

    $pids = Find-BookVoiceServerTreePids -RuntimeDir $RuntimeDir -ProcessSnapshot $ProcessSnapshot
    $stopped = @()
    foreach ($procId in $pids) {
        if ($WhatIf) {
            $stopped += $procId
            continue
        }
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            $stopped += $procId
        } catch {
            # Process may already be gone or access denied; continue best-effort.
        }
    }
    return $stopped
}

# Auto-run only when invoked as a script with -RuntimeDir (not when dot-sourced bare).
if ($RuntimeDir) {
    $result = Stop-BookVoiceServerTree -RuntimeDir $RuntimeDir -WhatIf:$WhatIf -ProcessSnapshot $ProcessSnapshot
    if ($WhatIf) {
        $result | ForEach-Object { Write-Output $_ }
    }
}
