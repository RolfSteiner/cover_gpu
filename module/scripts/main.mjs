// Cover: Quadtree View. Draws the GPU quadtree view (rays, the path traced light of the
// scene's light sources, cover test of the selected token) on the canvas of the scene, working
// on the walls in game.canvas.walls.quadtree, on what each of them stops and between which
// heights it stands, and on the floors and roofs that regions define (see heights.mjs). The
// view is a canvas layer with a set of scene controls of its own (see layer.mjs); it is shown,
// and can be used, whichever controls are active.

import { CoverViewLayer } from './layer.mjs';
import { quadtreeJson } from './quadtree.mjs';
import { LAYER, MODULE_ID, registerSettings } from './settings.mjs';
import { addSurfaceFields } from './wall-config.mjs';
import { wrapFoundry, wrapVisioner } from './wrappers.mjs';

Hooks.once('init', () => {
	registerSettings((key) => canvas[LAYER]?.optionChanged(key));
	CONFIG.Canvas.layers[LAYER] = { layerClass: CoverViewLayer, group: 'interface' };
	game.modules.get(MODULE_ID).api = {
		quadtreeJson,
		/** True when the path traced light at a place `{x, y}` of the viewed scene counts as lit. */
		isLit: (point) => canvas[LAYER]?.isLit(point) ?? false,
		/** How bright the path traced light makes a place: 0, 1 (dim) or 2 (bright); null while it is not traced. */
		lightLevelAt: (point) => canvas[LAYER]?.lightLevelAt(point) ?? null,
		/** True when one token has a line of sight to another by way of mirrors. */
		seesByMirrors: (observer, target) => canvas[LAYER]?.seesByMirrors(observer, target) ?? false,
		/** True when one token has a straight line of sight to another, over or under the walls between them. */
		seesOver: (observer, target) => canvas[LAYER]?.seesOver(observer, target) ?? false,
		/**
		 * How much of a token the walls and surfaces that stop movement hide, 0 to 1, or null:
		 * looked at from the place `{x, y}`, or, with `source`, from across the token that has its
		 * middle there, at the height that token looks from.
		 */
		coverShare: (from, token, source) => canvas[LAYER]?.coverShare(from, token, source) ?? null,
	};
});

// What this module adds to functions of Foundry and of PF2E Visioner goes through libWrapper
// (see wrappers.mjs): Foundry's once every system and module has set itself up, Visioner's once
// the game is ready and Visioner with it.
Hooks.once('setup', wrapFoundry);
Hooks.once('ready', wrapVisioner);

// A wall enters, moves in or leaves the quadtree when it is drawn, refreshed or destroyed, a
// moment after the hook; the same hooks fire for changes that leave the tree as it is, which
// the layer tells apart.
const refresh = foundry.utils.debounce(() => canvas[LAYER]?.refreshTree(), 200);
// A wall of a level that is not viewed is no object on the canvas, but it is in the way of
// the light all the same, so the changes of the wall documents are followed too.
for (const hook of ['canvasReady', 'drawWall', 'refreshWall', 'createWall', 'updateWall', 'deleteWall', 'destroyWall']) Hooks.on(hook, refresh);

// The cover test follows the tokens: which one is selected, where each is (a token being
// dragged or moved is refreshed all the way), and which there are.
for (const hook of ['controlToken', 'refreshToken', 'drawToken', 'destroyToken', 'updateToken']) {
	Hooks.on(hook, () => canvas[LAYER]?.tokensChanged());
}

// Foundry calls these when it has set up its light sources again, and whenever it draws the
// lighting anew: a light or a token with a light was added, changed, moved or removed.
for (const hook of ['initializeLightSources', 'lightingRefresh']) {
	Hooks.on(hook, () => canvas[LAYER]?.lightsChanged());
}
// A light, or a token with a light, of a level that is not viewed has no light source of
// Foundry's, and Foundry draws nothing anew when it changes; its light is in the path traced
// picture all the same.
for (const hook of ['createAmbientLight', 'updateAmbientLight', 'deleteAmbientLight', 'createToken', 'updateToken', 'deleteToken']) {
	Hooks.on(hook, () => canvas[LAYER]?.lightsChanged());
}
// Foundry makes the parts of its vision mask anew with a scene, and draws into them each time
// what can be seen changes; the lit places of the path traced light go in with them, and what
// tokens see in mirrors.
Hooks.on('visibilityRefresh', (visibility) => canvas[LAYER]?.visionChanged(visibility));

// What a token sees in a mirror has to follow a wall at once, not after the walls were read anew.
for (const hook of ['createWall', 'updateWall', 'deleteWall']) Hooks.on(hook, () => canvas[LAYER]?.wallsChanged());

// The floors and roofs are the surfaces of regions: they change with a region's shapes and
// elevation and with its behaviors. A change of the scene may be one of its levels, or of what
// Wall Height keeps with the scene.
for (const hook of ['createRegion', 'updateRegion', 'deleteRegion', 'createRegionBehavior', 'updateRegionBehavior', 'deleteRegionBehavior', 'updateScene']) {
	Hooks.on(hook, () => {
		canvas[LAYER]?.wallsChanged();
		refresh();
	});
}

// the sheet of a wall gets the fields for how metallic and how smooth its two faces are
Hooks.on('renderWallConfig', (app, element) => addSurfaceFields(app, element));

// lines and marks keep their size on screen, so they are drawn again after a zoom
Hooks.on('canvasPan', () => canvas[LAYER]?.zoomChanged());
