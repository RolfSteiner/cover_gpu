# cover_gpu

A Foundry VTT module, **Cover: Quadtree View** (id `cover-quadtree-view`), and the script
library it runs on. The library is written in [daslang](https://daslang.io/), compiled to
WebAssembly, and does its ray tests on the graphics card through WebGL 2.

Everything that is worked out is worked out by the library. The module's JavaScript reads the
scene from Foundry, says when something has to be worked out again, and puts the answers where
Foundry draws from them (see [Who does what](#who-does-what)).

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

- **Light.** The picture shows the light on the floor that is at each place: on a region's
  surface that stops movement, where one lies within the viewed level (a raised floor, the roof
  of a room below), and on the ground elsewhere, which is the base of the viewed level or of a
  lower level seen from it. A lamp on a roof lights the roof, not the ground around the room at
  the roof's height. Light from a source
  above a low wall falls over it, and the wall's shadow on the floor is as long as the heights
  make it; light passes under a wall that begins higher up; a roof keeps light out, or in. The
  reach of a light counts with the difference in height. A wall without a top throws light back
  up to the setting "Height of walls without a top" above the floor.
- **Levels.** The light of the whole scene is traced, whichever level is viewed: the lights and
  the tokens with a light on other levels too, which Foundry itself neither sets up nor draws,
  with the walls and surfaces of every level in the way. A wall that names levels ends, for
  the light, where those levels end. Light passes from one level to another wherever no
  surface or wall stops it, so a floor between two levels needs a region that defines one.
- **Cover.** From the height a token looks from, another token fills a cone of lines of sight:
  from side to side of it, and from its feet to its head, with its top where it is looked down
  on. The cover test sends rays all through that cone (setting "Cover test: rays up and down"),
  and the hidden share is the part of the cone the walls and floors cut off. A low wall hides
  the lower part of what stands behind it, a floor hides what is under it from above.
- **Vision.** A token sees another over or under the walls between them where the straight line
  from its eyes to the other clears them. A mirror is as high as its wall. Foundry's own views
  (what of the map a token reveals) stay flat shapes, worked out by Foundry and Wall Height.

On a scene where nothing names a height, everything is as on a flat map.

Two switches in the scene controls show the scene from the side, for the user who sets them.
In both, every token stands as a cylinder from its feet to its head, and with the GM's view
shown the walls stand from bottom to top, with the floors and roofs where they lie and each
traced light at its height. Token and tile art stays flat on the map.

- **Isometric view** turns the whole canvas of Foundry.
- **3D view** shows the scene in perspective, with a camera: drag with the right mouse button
  to move over the ground, with the middle button (or Shift and the right button) to turn and
  tilt, and use the wheel to come closer or go away. The left button works as on the map. This
  view is a picture of its own over Foundry's canvas (`module/scripts/view3d.mjs`). It shows
  every level of the scene at once: Foundry's flat picture is laid on the floors of the viewed
  level and on the tokens Foundry has drawn; the floors of the other levels are drawn in the
  level's own picture or color, lit by the light path traced for them, with their walls and
  their tokens. The cover test is drawn as the cone it is: where it ends on each target, what
  is hidden (red) and what is seen (yellow), with the lines of sight to it. Foundry's
  HUD is hidden while the view is on.

## Layout

| Path | What it is |
|---|---|
| `src/test_local_gpu.das` | The script library: ray tests, cover test, path tracer (the shaders are in it), where the light counts as lit, and the functions a caller reaches the three files below by. |
| `src/sight.das` | Single lines of sight through a scene with heights, and what is seen in mirrors. |
| `src/view3d.das` | The scene in perspective: the camera, what it sees as triangles and lines, and what the mouse is on. |
| `src/isometric.das` | The outlines of what stands on the scene when it is looked at from the side. |
| `module/` | The Foundry module. After a build it is complete and can be copied into a data folder. |
| `module/lib/test_local_gpu_api.js` | The JavaScript wrapper over the built library. |
| `module/scripts/` | The module's own code; each file says at its top what it is for. |
| `build.ps1` | Builds the library into `module/lib` and can install the module. |
| `daslang/` | The daslang the library is built with: a git submodule, the fork [RolfSteiner/daScript](https://github.com/RolfSteiner/daScript) at a fixed commit. |
| `test/` | Two pages that check the library and the module in a browser, without Foundry running, and a run through the module to compare two states of it. |

The built library (`module/lib/test_local_gpu_lib.mjs` and `.wasm`, about 10 MB) is not kept in
the repository. A fresh checkout has to be built before the module works.

## Who does what

| | The library (daslang) | The module's JavaScript |
|---|---|---|
| Light | Path traces the picture; turns a light as Foundry describes it (cone, softness, color and its strength, dim level) into what the tracer takes; reads off the picture where the light counts as lit, and answers for a place. | Reads the light sources, decides when to trace, puts the pictures into Foundry's lighting and vision mask. |
| Sight | Follows a line of sight past walls and through floors; finds the way by a row of mirrors; names the places of a token that are looked at. | Reads the walls and surfaces; asks Foundry's detection modes about range and angle. |
| Mirrors | Says where to look at a mirror, cuts it into the parts that are seen, mirrors the place looked from, and works out the outline of each view. | Asks a view of Foundry's whether it holds a place; makes the vision sources. |
| Cover | The cover test, with a size per target, and which point of the source sees most. | Reads the tokens; draws the result on the map. |
| Isometric view | How the map lies on the screen; the outlines of tokens, walls, floors and lights, in drawing order. | Turns Foundry's canvas; draws the outlines with PIXI. |
| 3D view | The camera and how it follows the mouse; every triangle and line of a frame; what the mouse is on; where Foundry's own view has to go. | The canvas and its WebGL calls, the pictures as textures, the mouse events. |

What is left of arithmetic in JavaScript is of the kind `x * pixelsPerUnit`: turning what
Foundry says into what the library takes, and sizes and colors of what PIXI draws.

The library keeps what it is given between calls where it is asked often: the walls for lines
of sight, the lit places, the scene and the camera of the 3D view. `module/lib/test_local_gpu_api.js`
works nothing out; it copies numbers into the library's memory and back.

## Building

Needed:

- daslang, built (below);
- the emscripten SDK (emsdk);
- Windows PowerShell.

```powershell
.\build.ps1
```

The script looks for daslang in `%DASLANG_ROOT%`, then in the submodule `daslang` if it has
been built, then in `G:\Packages\daslang`; and for emsdk in `%EMSDK%` or `G:\Packages\emsdk`.
`-Daslang` and `-Emsdk` name other places. `Get-Help .\build.ps1` shows all of it.

### daslang

The library needs a daslang whose `-lib` build for `wasm64-unknown-emscripten` goes on from
the object to an ES module (`.mjs` and `.wasm`). That is in the fork
[RolfSteiner/daScript](https://github.com/RolfSteiner/daScript), on its `master`; the
repository names the commit it is built with as the submodule `daslang`. To get it with the
repository:

```powershell
git clone --recurse-submodules <url of this repository>
```

or, in a checkout that is there already, `git submodule update --init`. A daslang checkout
kept elsewhere does as well; `build.ps1` warns when it is not at the commit the submodule
names.

Two builds of that checkout are needed, both described in its own documentation
(`web/README.md` for the second):

- the compiler with the module dasLLVM, `bin\Release\daslang.exe`:
  `cmake -B build -DDAS_LLVM_DISABLED=OFF`, then `cmake --build build --config Release`;
- the wasm64 archives of the runtime and of the OpenGL module, in `web\output64\lib`
  (`liblibDasModuleOpenGL.a` among them): with emsdk's tools on the path,
  `emcmake cmake -S web -B web/cmake_temp -G Ninja -DCMAKE_BUILD_TYPE=Release
  -DDAS_WASM_MEMORY64=ON -DDAS_WEB_OUTPUT_DIR=<checkout>/web/output64`, then
  `cmake --build web/cmake_temp --target libDaScript_runtime libDasModuleOpenGL`.

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
  light that is thrown back for what has to hold of it; lines of sight and views in mirrors
  against the JavaScript the module used for them before (`test/reference.mjs`); the lit
  places, the outlines of the isometric view and the camera of the 3D view. The page lists its
  checks, each with `ok`, and `allOk` at the end. With `old=<folder of an earlier build of the
  library>` added to the command, it also checks that a map without heights gives what that
  build gave.
- `http://127.0.0.1:8377/test/module.html` runs the module outside Foundry: real PIXI and
  Foundry's quadtree class from the installation named by `foundry=`, stand-ins for the rest
  (`test/visioner` stands in for PF2E Visioner). It sets a scene up and leaves handles in
  `window.h` to try things from the browser's console.
- `test/scenario.mjs` runs through the module on that page (sight over walls and in mirrors,
  the traced light, cover, a ray, both views) and returns a digest of what the module answered
  and drew; `compare` says where two digests differ. To compare with an earlier state of the
  repository, check that state out somewhere, build its library, serve it with
  `before=<that folder>` and `before/pf2e-visioner=<this repository>\test\visioner` added to
  the command, and run the scenario on `module.html?module=/before/module` as well.

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
