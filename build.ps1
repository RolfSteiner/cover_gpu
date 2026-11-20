<#
.SYNOPSIS
Builds the script library of the module, and puts the module into a Foundry data folder if asked.

.DESCRIPTION
src\test_local_gpu.das is compiled by daslang to a wasm64 library (emscripten): the two files
test_local_gpu_lib.mjs and test_local_gpu_lib.wasm. They go into module\lib, next to the
wrapper test_local_gpu_api.js that loads them. After that, the folder `module` is the whole
Foundry module.

.PARAMETER Daslang
The daslang checkout. It has to hold bin\Release\daslang.exe and the wasm64 build of the OpenGL
module, web\output64\lib\liblibDasModuleOpenGL.a. Default: the environment variable
DASLANG_ROOT, or G:\Packages\daslang.

.PARAMETER Emsdk
The emscripten SDK, whose emsdk_env.ps1 puts its tools on the path. Default: the environment
variable EMSDK, or G:\Packages\emsdk.

.PARAMETER Install
The `modules` folder of a Foundry data folder, for example
G:\Programming\Foundry\foundrydata\Data\modules. With it, the built module is copied to the
folder cover-quadtree-view there (the id of the module, which Foundry wants the folder named by).

.EXAMPLE
.\build.ps1

.EXAMPLE
.\build.ps1 -Install G:\Programming\Foundry\foundrydata\Data\modules
#>
param(
	[string]$Daslang = $(if ($env:DASLANG_ROOT) { $env:DASLANG_ROOT } else { 'G:\Packages\daslang' }),
	[string]$Emsdk = $(if ($env:EMSDK) { $env:EMSDK } else { 'G:\Packages\emsdk' }),
	[string]$Install = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$name = 'test_local_gpu_lib'
$moduleId = 'cover-quadtree-view'

$compiler = Join-Path $Daslang 'bin\Release\daslang.exe'
$openGL = Join-Path $Daslang 'web\output64\lib\liblibDasModuleOpenGL.a'
$emsdkEnv = Join-Path $Emsdk 'emsdk_env.ps1'
foreach ($needed in $compiler, $openGL, $emsdkEnv) {
	if (-not (Test-Path $needed)) { throw "Not found: $needed. See the parameters -Daslang and -Emsdk (Get-Help .\build.ps1)." }
}

# emscripten's tools on the path, for the link step daslang runs
$env:EMSDK_QUIET = '1'
& $emsdkEnv | Out-Null

$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force $build | Out-Null

# What the linker is told: the OpenGL module, WebGL 2 with the whole of ES 3, and the parts of
# emscripten's runtime the wrapper calls.
$linker = @(
	($openGL -replace '\\', '/'),
	'-sMAX_WEBGL_VERSION=2',
	'-sFULL_ES3=1',
	'-sGL_ENABLE_GET_PROC_ADDRESS=1',
	'-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAP32,HEAPF32,HEAPF64,GL',
	'-sMIN_NODE_VERSION=220000'
) -join ' '

Push-Location (Join-Path $root 'src')
try {
	& $compiler -lib -lib-export-all test_local_gpu.das -output "../build/$name" -- --jit-target=wasm64-unknown-emscripten "--jit-linker-string=$linker"
	if ($LASTEXITCODE -ne 0) { throw "daslang failed with exit code $LASTEXITCODE" }
} finally {
	Pop-Location
}

$lib = Join-Path $root 'module\lib'
foreach ($extension in 'mjs', 'wasm') {
	$made = Join-Path $build "$name.$extension"
	if (-not (Test-Path $made)) { throw "The build did not make $made" }
	Copy-Item $made $lib -Force
}
"Built: $(Join-Path $lib "$name.mjs"), $(Join-Path $lib "$name.wasm")"

if ($Install) {
	if (-not (Test-Path $Install)) { throw "Not found: $Install" }
	$target = Join-Path $Install $moduleId
	New-Item -ItemType Directory -Force $target | Out-Null
	Copy-Item (Join-Path $root 'module\*') $target -Recurse -Force
	"Installed: $target"
}
