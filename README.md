# cover_gpu

A Foundry VTT module, **Cover: Quadtree View** (id `cover-quadtree-view`), and the script
library it runs on. The library is written in [daslang](https://daslang.io/), compiled to
WebAssembly, and does its ray tests on the graphics card through WebGL 2.

What the module does, for Foundry 14 (written against 14.370) with the pf2e system:

- **Path traced light.** The light of the scene's light sources is path traced in place of
  Foundry's own light meshes: walls stop it by their properties and throw it back, scattered or
  mirrored, by how metallic and how smooth each side of a wall is set to be. The picture is
  denoised, anti-aliased, and drawn inside Foundry's own lighting, for every user.
- **Vision.** Places the reflected light reaches count as lit for what tokens see. A wall side
  that is fully metallic and fully smooth is a mirror tokens can see in, several in a row.
- **Cover.** How much of every other token the walls that stop movement hide from the selected
  token.
- **A view for the GM** of the walls' quadtree, of rays through it, and of the cover test.
- **PF2E Visioner.** Where [PF2E Visioner](https://github.com/roileaf/pf2e-visioner) is active,
  its light levels, lines of sight and wall cover go by the three above.

## Layout

| Path | What it is |
|---|---|
| `src/test_local_gpu.das` | The script library: quadtree ray tests, cover test, path tracer (the shaders are in it). |
| `module/` | The Foundry module. After a build it is complete and can be copied into a data folder. |
| `module/lib/test_local_gpu_api.js` | The JavaScript wrapper over the built library. |
| `module/scripts/` | The module's own code; each file says at its top what it is for. |
| `build.ps1` | Builds the library into `module/lib` and can install the module. |

The built library (`module/lib/test_local_gpu_lib.mjs` and `.wasm`, about 10 MB) is not kept in
the repository. A fresh checkout has to be built before the module works.

## Building

Needed:

- a daslang checkout with `bin\Release\daslang.exe` and the wasm64 build of its OpenGL module,
  `web\output64\lib\liblibDasModuleOpenGL.a`;
- the emscripten SDK (emsdk);
- Windows PowerShell.

```powershell
.\build.ps1
```

The script looks for daslang in `%DASLANG_ROOT%` or `G:\Packages\daslang`, and for emsdk in
`%EMSDK%` or `G:\Packages\emsdk`; `-Daslang` and `-Emsdk` name other places. `Get-Help
.\build.ps1` shows all of it.

To build and put the module into a Foundry data folder in one go:

```powershell
.\build.ps1 -Install G:\Programming\Foundry\foundrydata\Data\modules
```

That copies `module\*` to `cover-quadtree-view` in that folder. Foundry reads a module's
manifest when the server starts, so restart the server after a change to `module.json`; for
anything else, reloading the world is enough.

## In Foundry

The module needs [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper): everything it adds
to functions of Foundry and of PF2E Visioner goes through it. PF2E Visioner is optional.

The GM gets a set of scene controls, "Quadtree View", with the switch that turns the path
traced light on for the world. How a wall side treats light is set in the wall's sheet, under
"Reflected Light". The numbers (paths per pixel, bounces, smoothing, wall height and so on) are
in the module's settings.

## The library by itself

`module/lib/test_local_gpu_api.js` can be used without Foundry, in any page with WebGL 2:

```js
import { cover } from './test_local_gpu_api.js';

const { boxHits, wallHits } = cover.test(treeJson, [0, 0, 0], [6000, 4600, 0]);
const shares = cover.testCover(treeJson, source, targets, sourceDiameter, targetDiameter, points);
cover.traceLights(treeJson, lights, { width: 1024, height: 785, samples: 32, bounces: 2 });
```

`treeJson` is a quadtree of walls as `module/scripts/quadtree.mjs` writes it; the wrapper
documents each function.
