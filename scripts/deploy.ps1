<#
    Deploys jiffy-messaging on the Windows host. Run by
    .github/workflows/deploy.yml over SSH, never by hand except to redo a
    deploy that the workflow already started.

    By the time this runs, the workflow has written the new configuration
    to .env.incoming and fast forwarded the checkout to origin/main, so
    this script is the version being deployed rather than the one that was
    running. Everything after that point is here: install, schema, build,
    restart, and a readiness probe that decides whether the deploy counts.

    Nothing is declared successful without a 200 from /ready. If any step
    fails, or the probe never passes, the previous commit and the previous
    .env go back and the service is restarted on them, so a failed deploy
    leaves the box serving what it was serving before.

    Prerequisites on the host, and the one time setup that creates them,
    are in docs/vps-deploy.md.
#>

param(
    # The commit this host was serving before the workflow reset the
    # checkout. Empty means the workflow could not read it, in which case a
    # failure still fails loudly but cannot put the old code back.
    [string]$PreviousCommit = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Native commands report failure through their exit code, which every call
# below checks. Without this, PowerShell 7 turns a non zero exit into a
# terminating error at an unpredictable point instead.
$PSNativeCommandUseErrorActionPreference = $false

$AppDir = 'C:\app\jiffy-messaging'
$ServiceName = 'jiffy-messaging'
$EnvFile = Join-Path $AppDir '.env'
$IncomingEnvFile = Join-Path $AppDir '.env.incoming'
$PreviousEnvFile = Join-Path $AppDir '.env.previous'
$StderrLog = Join-Path $AppDir 'logs\stderr.log'

# A non interactive SSH session gets a minimal PATH, so node, pnpm, git and
# nssm are all missing until this puts the machine and user paths back.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')

$script:Port = 8080
# Set once .env.incoming has replaced .env, which is the point after which
# a rollback has to put the old configuration back. Before it, .env.previous
# is left over from an earlier deploy and restoring it would overwrite good
# configuration with stale configuration.
$script:EnvPromoted = $false

<#
    Runs a native command through cmd so its stderr is merged before
    PowerShell sees it, keeps the tail of the output, and turns a non zero
    exit into a named failure.
#>
function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Command,
        [int]$Tail = 20
    )

    Write-Host "=== $Label ==="
    cmd /c "$Command 2>&1" | Select-Object -Last $Tail
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed (exit $LASTEXITCODE)"
    }
}

# Same thing for the rollback path, where a failure is reported rather than
# thrown: a rollback that gives up halfway is worse than one that finishes
# noisily.
function Invoke-RollbackStep {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Command,
        [int]$Tail = 10
    )

    Write-Host "--- rollback: $Label ---"
    cmd /c "$Command 2>&1" | Select-Object -Last $Tail
    if ($LASTEXITCODE -ne 0) {
        Write-Host "rollback step '$Label' failed (exit $LASTEXITCODE)"
    }
}

<#
    Reads a .env file into this process. The service itself does not read
    one - node --env-file does that for it - but the schema step needs
    DATABASE_URL and the probe needs PORT.
#>
function Import-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)

    foreach ($line in (Get-Content $Path)) {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim()
            if ($value.Length -ge 2 -and
                (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                 ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

# True once something is listening and answering /health, which is the
# process liveness endpoint and checks no dependency. Used to confirm the
# old process actually stopped, so a later pass cannot be the old version
# answering.
function Test-Listening {
    param([int]$TimeoutSeconds = 4)

    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/health" `
            -UseBasicParsing -TimeoutSec $TimeoutSeconds
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

# True once /ready answers 200, which means the process is up and its
# database connection works. This is the only thing that makes a deploy
# successful.
function Test-Ready {
    param([int]$Attempts = 12, [int]$DelaySeconds = 3)

    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/ready" `
                -UseBasicParsing -TimeoutSec 4
            if ($response.StatusCode -eq 200) {
                # Content comes back as bytes rather than a string when the
                # response carries no charset, which is not how express
                # answers but is cheap to survive.
                $body = if ($response.Content -is [byte[]]) {
                    [Text.Encoding]::UTF8.GetString($response.Content)
                } else {
                    "$($response.Content)"
                }
                Write-Host "ready: $body"
                return $true
            }
            Write-Host "attempt $i : HTTP $($response.StatusCode)"
        } catch {
            # A 503 from /ready arrives here too, since Invoke-WebRequest
            # throws on any non success status.
            Write-Host "attempt $i : $($_.Exception.Message)"
        }
        Start-Sleep -Seconds $DelaySeconds
    }

    return $false
}

<#
    Stops the service and waits for the port to go quiet, then starts it.

    nssm's own exit codes are not reliable enough to gate a deploy on, so
    they are logged and the HTTP checks decide. Confirming nothing answers
    between the stop and the start is what stops a probe from passing
    against a process that never restarted.
#>
function Restart-MessagingService {
    Write-Host '=== restart service ==='

    cmd /c "nssm stop $ServiceName 2>&1" | Select-Object -Last 5
    Write-Host "nssm stop exit: $LASTEXITCODE"

    $stopped = $false
    for ($i = 1; $i -le 10; $i++) {
        if (-not (Test-Listening)) {
            $stopped = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $stopped) {
        throw "$ServiceName is still answering on port $($script:Port) after a stop, so a restart cannot be verified"
    }

    cmd /c "nssm start $ServiceName 2>&1" | Select-Object -Last 5
    Write-Host "nssm start exit: $LASTEXITCODE"
}

function Show-RecentErrors {
    if (Test-Path $StderrLog) {
        Write-Host "=== last 30 lines of $StderrLog ==="
        Get-Content $StderrLog -Tail 30
    } else {
        Write-Host "no stderr log at $StderrLog"
    }
}

<#
    Puts the host back on the commit and the configuration it was serving
    before this run, rebuilds them, restarts, and reports whether the old
    version came back. Never throws: the caller has already failed and its
    error is the one worth reporting.
#>
function Invoke-Rollback {
    param([Parameter(Mandatory = $true)][string]$Reason)

    Write-Host "=== ROLLING BACK: $Reason ==="

    if (-not $script:EnvPromoted) {
        Write-Host 'the configuration was never replaced, leaving .env alone'
    } elseif (Test-Path $PreviousEnvFile) {
        Copy-Item $PreviousEnvFile $EnvFile -Force
        Write-Host 'restored the previous .env'
    } else {
        Write-Host 'there was no .env before this deploy, leaving the new one in place'
    }

    if ($PreviousCommit -match '^[0-9a-f]{40}$') {
        Invoke-RollbackStep -Label "checkout $PreviousCommit" -Command "git reset --hard $PreviousCommit" -Tail 5
        Invoke-RollbackStep -Label 'pnpm install' -Command 'pnpm install --frozen-lockfile'
        Invoke-RollbackStep -Label 'pnpm build' -Command 'pnpm build'
    } else {
        Write-Host 'no previous commit was recorded, leaving the checkout where it is'
    }

    Invoke-RollbackStep -Label 'nssm stop' -Command "nssm stop $ServiceName" -Tail 5
    Start-Sleep -Seconds 3
    Invoke-RollbackStep -Label 'nssm start' -Command "nssm start $ServiceName" -Tail 5

    if (Test-Ready -Attempts 10) {
        Write-Host 'ROLLBACK_OK: the previous version is serving again'
    } else {
        Write-Host 'ROLLBACK_FAILED: nothing is answering /ready. This host needs a look.'
        Show-RecentErrors
    }
}

# Outside the try on purpose. Every rollback step runs git in the working
# directory, so there is no safe recovery to attempt if this is not it.
if (-not (Test-Path $AppDir)) {
    Write-Host "DEPLOY_FAILED: $AppDir does not exist. See docs/vps-deploy.md for the one time setup."
    exit 1
}
Set-Location $AppDir

try {
    Write-Host '=== preflight ==='

    if (-not (Test-Path (Join-Path $AppDir '.git'))) {
        throw "$AppDir is not a git checkout. See docs/vps-deploy.md for the one time setup."
    }
    if (-not (Test-Path $IncomingEnvFile)) {
        throw "$IncomingEnvFile is missing. The workflow writes it before calling this script."
    }

    foreach ($tool in @('git', 'node', 'pnpm', 'nssm')) {
        $found = Get-Command $tool -ErrorAction SilentlyContinue
        if (-not $found) {
            throw "$tool is not on PATH. See docs/vps-deploy.md for what this host needs installed."
        }
    }
    Write-Host "node $(node --version), pnpm $(pnpm --version)"

    # nssm exits non zero for a service it does not know about, which is
    # the one thing here worth failing on before anything is changed.
    cmd /c "nssm status $ServiceName 2>&1" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "the '$ServiceName' service is not registered with nssm. See docs/vps-deploy.md."
    }

    # Keep the configuration that is currently in use, so the rollback has
    # something to put back, then promote the incoming one.
    if (Test-Path $EnvFile) {
        Copy-Item $EnvFile $PreviousEnvFile -Force
    } elseif (Test-Path $PreviousEnvFile) {
        Remove-Item $PreviousEnvFile -Force
    }
    Move-Item $IncomingEnvFile $EnvFile -Force
    $script:EnvPromoted = $true
    Write-Host 'promoted .env.incoming to .env'

    Import-DotEnv -Path $EnvFile
    if (-not $env:DATABASE_URL) {
        throw 'DATABASE_URL is not set in .env'
    }
    if (-not $env:JWT_SECRET -and -not $env:JWT_JWKS_URI) {
        throw 'neither JWT_SECRET nor JWT_JWKS_URI is set in .env'
    }
    if ($env:PORT) {
        $script:Port = [int]$env:PORT
    }
    # Enough to tell a wrong value from a missing one without putting
    # either in a log GitHub keeps.
    Write-Host "DATABASE_URL scheme: $(($env:DATABASE_URL -split '://')[0]) (length: $($env:DATABASE_URL.Length))"
    Write-Host "port: $($script:Port)"

    # The full dependency set, not a production only install: tsup and
    # typescript are devDependencies and the build happens here, on the
    # host, from the checkout. Nothing extra is loaded at runtime for it -
    # the service runs dist/main.js.
    Invoke-Step -Label 'pnpm install' -Command 'pnpm install --frozen-lockfile'

    # Every statement in schema.sql is CREATE ... IF NOT EXISTS, so this is
    # a no op on a database that already has the three tables and the first
    # deploy against an empty one creates them. It runs before the build so
    # a database that cannot be reached fails the deploy without having
    # touched the running service.
    Invoke-Step -Label 'apply schema' -Command 'node scripts/apply-schema.mjs'

    Invoke-Step -Label 'pnpm build' -Command 'pnpm build' -Tail 30

    $entryPoint = Join-Path $AppDir 'dist\main.js'
    if (-not (Test-Path $entryPoint)) {
        throw "BUILD FAILED: $entryPoint missing"
    }

    Restart-MessagingService

    Write-Host '=== readiness probe ==='
    if (-not (Test-Ready)) {
        Show-RecentErrors
        throw "/ready never returned 200 on port $($script:Port)"
    }

    Write-Host 'DEPLOY_OK'
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-Host "DEPLOY_FAILED: $message"
    Invoke-Rollback -Reason $message
    exit 1
}
