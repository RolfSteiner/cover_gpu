// How high things are. The script library works on a map with height: a wall stands from a
// bottom to a top, a token from its feet to its head, a light is at a height, and floors and
// roofs lie level at one. Foundry and its modules say all of these as elevations, in the units
// distances are measured in on the scene (feet, as a rule); the library wants them in scene
// pixels, like every place on the map. This file reads them and turns them over.
//
//  - Walls. Foundry has no height for a wall. The module Wall Height
//    (github.com/theripper93/wall-height) adds one: "Wall Height (Bottom)" and "Wall Height
//    (Top)" in the sheet of a wall, kept in the wall's flags as `wall-height.bottom` and
//    `wall-height.top`. A wall that names neither is as deep and as high as the scene goes. The
//    flags are read wherever they are set, unless Wall Height's own switch for the scene
//    ("advanced vision") is off.
//  - Tokens. A token stands on its elevation. How high it is comes from Wall Height where that
//    module is active (`Token#losHeight`, the height it sees from, which that module works out
//    from the token's size or its own setting), and otherwise from the token's depth, which
//    Foundry counts in grid squares. A token looks from its top, and a light it carries is held
//    there.
//  - Light sources that are no token's are at the elevation they say.
//  - Floors, ceilings and roofs are the surfaces Foundry's regions define: a region with a
//    "Define Surface" behavior has a surface at the bottom of its elevation range, at its top,
//    or both, over the area of its shapes, and the behavior says whether the surface stops
//    light, movement and sight (Scene#getSurfaces).
//  - The floor the path traced light is shown on is the base of the level being viewed.
//
// The Foundry types named here are the ones of the pf2e system's declarations
// (github.com/foundryvtt/pf2e, types/foundry): TokenDocument in client/documents/token.d.mts,
// RegionDocument in client/documents/region.d.mts.

/** The id of the module Wall Height, which is also the scope of its flags. */
const WALL_HEIGHT = 'wall-height';

/** How many scene pixels one unit of elevation is. */
export function perUnit() {
	const dimensions = canvas.dimensions ?? {};
	return dimensions.distancePixels ?? ((dimensions.size ?? 100) / (dimensions.distance || 5));
}

/** A number someone has set, or `none` where nothing is set. */
function said(value, none) {
	return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? none : Number(value);
}

/**
 * Between which heights a wall stands, in scene pixels; -Infinity and Infinity where it names
 * no bottom or no top.
 * @param {WallDocument} document
 * @returns {{bottom: number, top: number}}
 */
export function wallHeights(document) {
	if (document.parent?.flags?.[WALL_HEIGHT]?.advancedVision === false) return { bottom: -Infinity, top: Infinity };
	const flags = document.flags?.[WALL_HEIGHT] ?? {};
	const per = perUnit();
	return { bottom: said(flags.bottom, -Infinity) * per, top: said(flags.top, Infinity) * per };
}

/**
 * Where a token stands and how high it is, in scene pixels: its feet (`bottom`), its head
 * (`top`), and the height it looks from (`eye`).
 * @param {Token} token the token on the canvas; while it is dragged, its preview
 * @returns {{bottom: number, top: number, eye: number}}
 */
export function tokenHeights(token) {
	const document = token?.document ?? token ?? {};
	const bottom = said(document.elevation, 0);
	// Wall Height's: the height a token sees from, feet included
	let top = said(token?.losHeight, NaN);
	if (!(top >= bottom)) {
		const squares = said(document.depth, Math.max(said(document.width, 1), said(document.height, 1)));
		top = bottom + squares * (canvas.dimensions?.distance || 5);
	}
	const per = perUnit();
	return { bottom: bottom * per, top: top * per, eye: top * per };
}

/**
 * How high a light source is, in scene pixels. The light a token carries is at the height the
 * token looks from.
 * @param {PointLightSource} source
 */
export function lightHeight(source) {
	const object = source.object;
	if (object?.document?.documentName === 'Token') return tokenHeights(object).eye;
	return said(source.elevation ?? source.data?.elevation, 0) * perUnit();
}

/** How high the floor of the viewed level lies, in scene pixels. */
export function floorHeight() {
	const range = canvas.level?.elevation ?? {};
	const base = Number.isFinite(range.base) ? range.base : range.bottom;
	return (Number.isFinite(base) ? base : 0) * perUnit();
}

/**
 * The flat surfaces of the viewed level that stop anything: `{ z, light, move, sight, t }` each,
 * with `z` the height in scene pixels, `light`, `move` and `sight` 1 where the surface stops
 * that, and `t` the triangles of its area, six numbers each (the x and y of three corners).
 * @returns {object[]}
 */
export function surfaceList() {
	const scene = canvas.scene;
	if (typeof scene?.getSurfaces !== 'function') return [];
	const per = perUnit();
	const list = [];
	for (const surface of scene.getSurfaces(canvas.level ? { level: canvas.level } : {})) {
		if (!Number.isFinite(surface.elevation) || !(surface.light || surface.move || surface.sight)) continue;
		const { vertices, indices } = surface.region?.triangulation ?? {};
		if (!vertices || !indices?.length) continue;
		const t = [];
		for (let i = 0; i + 2 < indices.length; i += 3) {
			const corners = [0, 1, 2].flatMap((k) => [Math.round(vertices[indices[i + k] * 2] * 10) / 10, Math.round(vertices[indices[i + k] * 2 + 1] * 10) / 10]);
			// a triangle without an area covers nothing
			if ((corners[2] - corners[0]) * (corners[5] - corners[1]) === (corners[3] - corners[1]) * (corners[4] - corners[0])) continue;
			t.push(...corners);
		}
		if (t.length) list.push({ z: Math.round(surface.elevation * per * 100) / 100, light: surface.light ? 1 : 0, move: surface.move ? 1 : 0, sight: surface.sight ? 1 : 0, t });
	}
	return list;
}
