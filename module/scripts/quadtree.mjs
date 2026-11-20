// The Foundry types named here are the ones of the pf2e system's declarations
// (github.com/foundryvtt/pf2e, types/foundry): WallDocument in client/documents/wall.d.mts, its
// data in common/documents/wall.d.mts, Edge in client/canvas/geometry/edges/edge.d.mts and the
// values in common/constants.d.mts.

import { wallHeights } from './heights.mjs';
import { MODULE_ID, SURFACE } from './settings.mjs';

/**
 * How a wall acts on what meets it.
 * @typedef {object} WallEffect
 * @property {number} move   a WallMovementType: 0 lets movement through, 20 stops it
 * @property {number} light  an EdgeSenseType: 0 none, 10 limited, 20 normal, 30 proximity, 40 distance
 * @property {number} sight  an EdgeSenseType
 * @property {number} sound  an EdgeSenseType
 * @property {number} dir    an EdgeDirection: 0 both sides, 1 left, 2 right
 * @property {number} lightThreshold the distance a proximity or distance wall works by for
 *   light, in scene pixels; 0 when none is set
 * @property {number} sightThreshold the same for sight
 * @property {number} soundThreshold the same for sound
 * @property {number} attenuation    1 when the wall shortens the reach of what passes it
 * @property {number} metallicLeft    how metallic the wall's left face is, 0 to 1: 0 scatters
 *   the light it gets to all sides, 1 mirrors it. The left face is the one a wall of direction
 *   "left" acts on
 * @property {number} smoothnessLeft  how sharp that face mirrors, 0 to 1
 * @property {number} metallicRight   the same two for its right face
 * @property {number} smoothnessRight
 * @property {number} bottom  the height the wall stands from, in scene pixels; -Infinity when
 *   it names none (see heights.mjs)
 * @property {number} top     the height it stands up to; Infinity when it names none
 */

/**
 * What the two faces of a wall are like: what the wall's flags of this module say, and
 * SURFACE for what they say nothing about.
 *
 * @param {WallDocument} document
 * @returns {{metallicLeft: number, smoothnessLeft: number, metallicRight: number, smoothnessRight: number}}
 */
export function wallSurface(document) {
	const flags = document.flags?.[MODULE_ID] ?? {};
	const share = (key) => {
		const said = Number(flags[key]);
		return flags[key] === null || flags[key] === undefined || flags[key] === '' || !Number.isFinite(said) ? SURFACE[key] : Math.min(Math.max(said, 0), 1);
	};
	return Object.fromEntries(Object.keys(SURFACE).map((key) => [key, share(key)]));
}

/**
 * How a wall acts right now. This is what Foundry itself works with: the Edge of the wall,
 * where an open door restricts nothing and the thresholds are in scene pixels.
 *
 * @param {WallDocument} document
 * @returns {WallEffect}
 */
export function wallEffect(document) {
	const edge = document.edge;
	if (edge) {
		const { light = 0, sight = 0, sound = 0, attenuation = false } = edge.threshold ?? {};
		return { move: edge.move, light: edge.light, sight: edge.sight, sound: edge.sound, dir: edge.direction,
			lightThreshold: light || 0, sightThreshold: sight || 0, soundThreshold: sound || 0, attenuation: attenuation ? 1 : 0,
			...wallSurface(document), ...wallHeights(document) };
	}
	// A wall without an Edge (its scene has not set up its edges yet) is read the way
	// WallDocument makes the Edge.
	const { NONE } = CONST.EDGE_SENSE_TYPES;
	const open = document.door > CONST.WALL_DOOR_TYPES.NONE && document.ds === CONST.WALL_DOOR_STATES.OPEN;
	const pixels = document.parent?.dimensions?.distancePixels ?? 1;
	const threshold = document.threshold ?? {};
	return {
		move: open ? NONE : document.move,
		light: open ? NONE : document.light,
		sight: open ? NONE : document.sight,
		sound: open ? NONE : document.sound,
		dir: document.dir,
		lightThreshold: (threshold.light || 0) * pixels,
		sightThreshold: (threshold.sight || 0) * pixels,
		soundThreshold: (threshold.sound || 0) * pixels,
		attenuation: threshold.attenuation ? 1 : 0,
		...wallSurface(document),
		...wallHeights(document),
	};
}

/**
 * A walls quadtree as the JSON text the script reads: every node of the tree in one list,
 * `root` saying which of them is the root. A node has its `bounds`, the `objects` stored in it
 * and the places of its child `nodes` in the list. An object is one wall: `t` holds its two
 * ends `a` and `b`, `r` its bounding box, `n` the number of nodes that store it, and `w` how
 * it acts (a {@link WallEffect}; a bottom or a top the wall does not name is left out, which
 * the script reads as "as far as the map goes"). With the tree go the flat surfaces of the
 * scene, in `surfaces`.
 *
 * @param {foundry.canvas.geometry.Quadtree} quadtree a quadtree whose objects are walls (Wall
 *   placeables, as in `canvas.walls.quadtree`)
 * @param {object[]} [surfaces] the flat surfaces, as `surfaceList` of heights.mjs gives them
 * @returns {string}
 */
export function quadtreeJson(quadtree, surfaces = []) {
	const nodes = [];
	// The script reads every value as a whole number, so a box is rounded outwards: it may
	// get larger by less than a unit, never smaller.
	const box = (r) => {
		const x = Math.floor(r.x);
		const y = Math.floor(r.y);
		return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
	};
	// a wall is stored in every node it touches; how it acts is worked out once
	const effects = new Map();
	const effectOf = (wall) => {
		if (!effects.has(wall)) {
			// JSON has no way to write "without end"
			const { bottom, top, ...effect } = wallEffect(wall.document);
			if (Number.isFinite(bottom)) effect.bottom = bottom;
			if (Number.isFinite(top)) effect.top = top;
			effects.set(wall, effect);
		}
		return effects.get(wall);
	};
	const add = (node) => {
		const children = node.nodes.map(add);
		nodes.push({
			bounds: box(node.bounds),
			objects: node.objects.map((object) => {
				const [x0, y0, x1, y1] = object.t.document.c;
				return { n: object.n.size, r: box(object.r), t: { a: { x: x0, y: y0 }, b: { x: x1, y: y1 } }, w: effectOf(object.t) };
			}),
			nodes: children,
		});
		return nodes.length - 1;
	};
	const root = add(quadtree);
	return JSON.stringify({ root, nodes, surfaces });
}
