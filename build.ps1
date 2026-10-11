$ErrorActionPreference = 'Stop'
# Keep UTF-8 BOM for Windows PowerShell 5.1.
$root = $PSScriptRoot
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$env:CARGO_TERM_COLOR = 'always'

# Rust bakes the absolute path of every compiled source file into the binary (panic
# locations), and the MSVC linker records where the .pdb lived. In a release build
# that means the developer's Windows account name and project directory ship inside
# every downloaded exe. All prefixes here are derived from the environment, so this
# stays correct on any machine and never hardcodes one person's path into the repo.
# Result on a zh-CN dev box: the account name goes to zero occurrences, and crate
# paths arrive as `/cargo\registry\src\<mirror>\<crate>\...`. The mirror directory
# name itself is a path *component*, not a prefix, so remapping cannot remove it --
# only a rule naming that exact directory would, which is why none is here.
#   - /PDBALTPATH is what shortens the RSDS CodeView record; `strip = true` does not
#     touch it. One `E:\...` style path can still survive inside a macro-expanded
#     constant, since --remap-path-prefix only rewrites file paths, not string data.
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { "${env:USERPROFILE}\.cargo" }
$remaps = @(
    "--remap-path-prefix=${env:USERPROFILE}=/users/dev",
    "--remap-path-prefix=$root=/build/relay",
    "--remap-path-prefix=$cargoHome=/cargo",
    "-C", "link-args=/PDBALTPATH:relay.pdb"
)
$env:RUSTFLAGS = (($remaps + $env:RUSTFLAGS) -join ' ').Trim()
Write-Host "RUSTFLAGS=$($env:RUSTFLAGS)" -ForegroundColor DarkGray
$wantDebug = $Args -contains '--debug'
$wantPortable = $wantDebug -or ($Args -contains '--portable')
Push-Location (Join-Path $root 'src-tauri')
try {
    if ($wantPortable) {
        if ($wantDebug) { & cargo build } else { & cargo build --release }
        if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
        $profileName = if ($wantDebug) { 'debug' } else { 'release' }
        $source = Join-Path $root ('src-tauri/target/' + $profileName + '/relay.exe')
        $filename = 'Relay.exe'
    } else {
        & cargo tauri build --bundles nsis
        if ($LASTEXITCODE -ne 0) { throw "Installer build failed: $LASTEXITCODE" }
        # -Encoding UTF8 is not cosmetic. Windows PowerShell 5.1 decodes Get-Content
        # with the ANSI codepage, so the Chinese strings in tauri.conf.json arrive
        # mojibake and ConvertFrom-Json throws ArgumentException -- which made the
        # installer branch of this script fail outright on a zh-CN machine while
        # --portable kept working. pwsh 7 defaults to UTF-8 and hides the bug.
        $config = Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $filename = $config.productName + '_' + $config.version + '_x64-setup.exe'
        $source = Join-Path $root ('src-tauri/target/release/bundle/nsis/' + $filename)
    }
    $dist = Join-Path $root 'dist'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $destination = Join-Path $dist $filename
    Copy-Item -LiteralPath $source -Destination $destination -Force
    Write-Host ("Built: {0} ({1:N2} MB)" -f $destination, ((Get-Item -LiteralPath $destination).Length / 1MB)) -ForegroundColor Green
} finally { Pop-Location }