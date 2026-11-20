// Lines of sight through a scene that has height.
//
// Foundry works out what a token sees as an outline on the map: a flat shape, cut off by every
// wall that counts for the token. With heights that is not the whole of it. A token looks over
// a wall that ends below the line from its eyes to what it looks at, and under one that begins
// above that line, and a floor or a roof between the two is in the way though no wall is. So a
// single line of sight is followed here as it runs through the room: from a place at a height
// to another place at another height, past the walls where they stand at the height the line
// has there, and through the flat surfaces it crosses on its way up or down.
//
// A wall stops sight by what Foundry's Edge says of it: not from the side a one-way wall does
// not act from, not when a proximity or distance wall is within or beyond its threshold, and a
// limited wall only as the second on one line. Those three go by places on the map, as they do
// in Foundry.
//
// `Obstacles` keeps what can be in the way, read from the scene when it is first asked after a
// change: the walls with their heights (see heights.mjs) and the surfaces that stop sight.
//
// The Foundry types named here are the ones of the pf2e system's declarations
// (github.com/foundryvtt/pf2e, types/foundry): Edge in client/canvas/geometry/edges/edge.d.mts.

import { surfaceList, wallHeights } from './heights.mjs';
import { wallEffect, wallSurface } from './quadtree.mjs';

/** A face counts as a mirror from this much metallic and smoothness on. */
const MIRROR = 0.99;

/** Foundry's CONST.EDGE_SENSE_TYPES. */
const LIMITED = 10;
const PROXIMITY = 30;

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

/** True when a place on the map lies in one of the triangles of `t` (six numbers each). */
function inTriangles(x, y, t) {
	for (let i = 0; i + 5 < t.length; i += 6) {
		const s1 = cross(t[i + 2] - t[i], t[i + 3] - t[i + 1], x - t[i], y - t[i + 1]);
		const s2 = cross(t[i + 4] - t[i + 2], t[i + 5] - t[i + 3], x - t[i + 2], y - t[i + 3]);
		const s3 = cross(t[i] - t[i + 4], t[i + 1] - t[i + 5], x - t[i + 4], y - t[i + 5]);
		if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
	}
	return false;
}

/**
 * True when a wall or a flat surface stops sight on the straight stretch from p to q.
 *
 * @param {{x: number, y: number, z: number}} p where the stretch starts, z being its height
 * @param {{x: number, y: number, z: number}} q where it ends
 * @param {object[]} walls `{ id, ax, ay, bx, by, sight, dir, threshold, bottom, top }` each
 * @param {object[]} surfaces `{ z, t }` each, the flat surfaces that stop sight. As in
 *   Scene#testSurfaceCollision of Foundry, a surface is the floor of what is above it: a stretch
 *   that starts on it and goes up is not stopped by it, one that comes up to end on it is
 * @param {string[]} [ends] walls the stretch starts or ends on, which are not in its way
 * @returns {boolean}
 */
export function stopped(p, q, walls, surfaces = [], ends = []) {
	const dx = q.x - p.x;
	const dy = q.y - p.y;
	const dz = q.z - p.z;
	let limited = 0;
	for (const wall of walls) {
		if (!wall.sight || ends.includes(wall.id)) continue;
		const wx = wall.bx - wall.ax;
		const wy = wall.by - wall.ay;
		const den = cross(dx, dy, wx, wy);
		if (den === 0) continue;
		const t = cross(wall.ax - p.x, wall.ay - p.y, wx, wy) / den;
		if (t <= 1e-6 || t >= 1 - 1e-6) continue;
		const s = cross(wall.ax - p.x, wall.ay - p.y, dx, dy) / den;
		if (s < 0 || s > 1) continue;
		// over the wall, or under it
		const z = p.z + dz * t;
		if (z < wall.bottom || z > wall.top) continue;
		// Foundry's Edge#orientPoint, and a one-way wall does not act from the side it names
		const side = (wall.ay - p.y) * (wall.bx - p.x) - (wall.ax - p.x) * (wall.by - p.y);
		if (wall.dir && wall.dir === (side < 0 ? 1 : 2)) continue;
		if (wall.sight >= PROXIMITY && wall.threshold > 0) {
			const along = Math.min(1, Math.max(0, ((p.x - wall.ax) * wx + (p.y - wall.ay) * wy) / (wx * wx + wy * wy || 1)));
			const apart = Math.hypot(p.x - wall.ax - wx * along, p.y - wall.ay - wy * along);
			if (wall.sight === PROXIMITY ? apart < wall.threshold : apart > wall.threshold) continue;
		}
		if (wall.sight !== LIMITED || ++limited > 1) return true;
	}
	if (dz === 0) return false;
	const low = Math.min(p.z, q.z);
	const high = Math.max(p.z, q.z);
	for (const surface of surfaces) {
		if (!(surface.z > low && surface.z <= high)) continue;
		const t = (surface.z - p.z) / dz;
		if (inTriangles(p.x + dx * t, p.y + dy * t, surface.t)) return true;
	}
	return false;
}

/**
 * The walls of the viewed level as a line of sight meets them: `{ id, ax, ay, bx, by, sight,
 * dir, threshold, bottom, top, left, right }`, where `sight`, `dir` and `threshold` are what
 * Foundry's Edge of the wall says of sight, `bottom` and `top` are the heights it stands
 * between, and `left` and `right` tell which of its faces mirror. The four sides of the canvas
 * end every line of sight, as they end Foundry's views.
 * @returns {object[]}
 */
function sceneWalls() {
	const walls = [];
	for (const wall of canvas.walls?.placeables ?? []) {
		const document = wall.document;
		const [ax, ay, bx, by] = document.c;
		if (ax === bx && ay === by) continue;
		const effect = wallEffect(document);
		const surface = wallSurface(document);
		walls.push({ id: document.id, ax, ay, bx, by, sight: effect.sight, dir: effect.dir, threshold: effect.sightThreshold, ...wallHeights(document),
			left: surface.metallicLeft >= MIRROR && surface.smoothnessLeft >= MIRROR,
			right: surface.metallicRight >= MIRROR && surface.smoothnessRight >= MIRROR });
	}
	const { x, y, width, height } = canvas.dimensions.rect;
	const corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
	corners.forEach(([ax, ay], i) => {
		const [bx, by] = corners[(i + 1) % 4];
		walls.push({ id: `canvas side ${i}`, ax, ay, bx, by, sight: 20, dir: 0, threshold: 0, bottom: -Infinity, top: Infinity, left: false, right: false });
	});
	return walls;
}

/** What can be in the way of a line of sight on the viewed scene. */
export class Obstacles {
	/** Counts the changes of walls and surfaces. */
	#count = 0;

	/** What was read from the scene, and the count it was read at. */
	#read = null;

	/** A number that moves on with every change of a wall or a surface. */
	get count() {
		return this.#count;
	}

	/** To be called when a wall or a region was added, changed or removed. */
	changed() {
		this.#count++;
	}

	#fresh() {
		if (this.#read?.at !== this.#count) {
			const walls = canvas.walls ? sceneWalls() : [];
			const surfaces = surfaceList().filter((surface) => surface.sight);
			// a scene on which nothing has a height: every line of sight is as on a flat map
			const flat = !surfaces.length && walls.every((wall) => wall.bottom === -Infinity && wall.top === Infinity);
			this.#read = { at: this.#count, walls, surfaces, flat };
		}
		return this.#read;
	}

	/** The walls, as `stopped` takes them. */
	get walls() {
		return this.#fresh().walls;
	}

	/** The flat surfaces that stop sight, as `stopped` takes them. */
	get surfaces() {
		return this.#fresh().surfaces;
	}

	/** True while no wall names a height and no surface stops sight. */
	get flat() {
		return this.#fresh().flat;
	}

	/**
	 * True when nothing stops sight on the straight line between two places, each `{ x, y, z }`
	 * with z its height in scene pixels.
	 */
	clear(from, to) {
		const { walls, surfaces } = this.#fresh();
		return !stopped(from, to, walls, surfaces);
	}
}
