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

## Heights

Light, vision and cover are worked out in a scene that has height.

| What | Where its height comes from |
|---|---|
| Walls | "Wall Height (Bottom)" and "Wall Height (Top)" of the module [Wall Height](https://github.com/theripper93/wall-height) (the wall's flags `wall-height.bottom` and `.top`). A wall that names neither is as deep and as high as the scene goes. |
| Tokens | A token stands on its elevation. With Wall Height active it is as high as that module says (the height it sees from); otherwise as high as its depth, which Foundry counts in grid squares. It looks from its top, and a light it carries is held there. |
| Lights | An ambient light is at its elevation. |
| Floors and roofs | Regions with a "Define Surface" behavior: a level surface at the bottom or the top of the region's elevation range, over the region's area, that stops light, movement or sight as the behavior says. |

What that changes:

- **Light.** The picture shows the light on the floor of the viewed level. Light from a source
  above a low wall falls over it, and the wall's shadow on the floor is as long as the heights
  make it; light passes under a wall that begins higher up; a roof keeps light out, or in. The
  reach of a light counts with the difference in height. A wall without a top throws light back
  up to the setting "Height of walls without a top" above the floor.
- **Cover.** The cover test looks from the height the token looks from at the other token from
  its feet to its head (setting "Cover test: heights"). A low wall hides the lower part of what
  stands behind it, a floor hides what is under it from above.
- **Vision.** A token sees another over or under the walls between them where the straight line
  from its eyes to the other clears them. A mirror is as high as its wall. Foundry's own views
  (what of the map a token reveals) stay flat shapes, worked out by Foundry and Wall Height.

On a scene where nothing names a height, everything is as on a flat map.

## Layout

| Path | What it is |
|---|---|
| `src/test_local_gpu.das` | The script library: ray tests, cover test, path tracer (the shaders are in it). |
| `module/` | The Foundry module. After a build it is complete and can be copied into a data folder. |
| `module/lib/test_local_gpu_api.js` | The JavaScript wrapper over the built library. |
| `module/scripts/` | The module's own code; each file says at its top what it is for. |
| `build.ps1` | Builds the library into `module/lib` and can install the module. |
| `test/` | Two pages that check the library and the module in a browser, without Foundry running. |

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

## Testing

The pages need a browser with WebGL 2 and Node to serve them:

```powershell
node test\server.mjs 8377 foundry=G:\Programming\Foundry\FoundryVTT-Node-14.370
```

- `http://127.0.0.1:8377/test/library.html` checks the built library: rays, cover and the light
  that comes straight from the sources against answers worked out in plain JavaScript, and the
  light that is thrown back for what has to hold of it. The page lists its checks, each with
  `ok`, and `allOk` at the end. With `old=<folder of an earlier build of the library>` added to
  the command, it also checks that a map without heights gives what that build gave.
- `http://127.0.0.1:8377/test/module.html` runs the module outside Foundry: real PIXI and
  Foundry's quadtree class from the installation named by `foundry=`, stand-ins for the rest
  (`test/visioner` stands in for PF2E Visioner). It sets a scene up and leaves handles in
  `window.h` to try things from the browser's console.

Neither page stands in for a try in Foundry itself.

## In Foundry

The module needs [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper): everything it adds
to functions of Foundry and of PF2E Visioner goes through it. PF2E Visioner and Wall Height are
optional.

The GM gets a set of scene controls, "Quadtree View", with the switch that turns the path
traced light on for the world. How a wall side treats light is set in the wall's sheet, under
"Reflected Light". The numbers (paths per pixel, bounces, smoothing, heights and so on) are in
the module's settings.

## The library by itself

`module/lib/test_local_gpu_api.js` can be used without Foundry, in any page with WebGL 2:

```js
import { cover } from './test_local_gpu_api.js';

const { boxHits, wallHits } = cover.test(treeJson, [0, 0, 0], [6000, 4600, 0]);
const shares = cover.testCover(treeJson, [x, y, eye], [[x1, y1, feet, head]], sourceDiameter, targetDiameter, points, heights);
cover.traceLights(treeJson, lights, { width: 1024, height: 785, samples: 32, bounces: 2, floor: 0 });
```

`treeJson` is a quadtree of walls with the flat surfaces of the scene, as
`module/scripts/quadtree.mjs` writes it; the wrapper documents it and each function.
