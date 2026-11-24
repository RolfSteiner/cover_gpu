// JavaScript wrapper over test_local_gpu_lib.wasm (src/test_local_gpu.das built with
// `daslang -lib`): tests of rays against the walls of a map, a cover test and a path tracer
// for the map's light, with the ray tests run on the graphics card through WebGL 2; and, worked
// out by the script without the graphics card, single lines of sight and what is seen in
// mirrors, the scene in perspective, and the outlines of the scene looked at from the side.
//
// This file works nothing out. It puts what a caller says into the memory of the script, calls
// the script, and hands back what the script answers.
//
//   import { cover } from './test_local_gpu_api.js';
//   const { boxHits, wallHits } = cover.test(treeJson, [0, 0, 0], [6000, 4600, 0]);
//
// The map has height: a point is `[x, y, z]`, x and y a place on the map and z how high up, all
// in map units. `treeJson` is the text of an object `{ root, nodes, surfaces }`: the walls in a
// quadtree, and the flat surfaces (floors, ceilings, roofs), which may be left out.
//  - An object of the tree is one wall. In `w` it may say how it acts (see `testCover` and
//    `traceLights`), and with `w.bottom` and `w.top` between which heights it stands; a wall
//    that leaves one of them out goes as deep, or as high, as the map does.
//  - A surface is `{ z, light, move, t }`: it lies level at the height `z`, `light` and `move`
//    are 1 when it stops light and movement, and `t` holds the triangles that make up its area,
//    six numbers each (the x and y of three corners). It is the floor of what is above it: what
//    sets off on it and goes up does not pass through it. With `noFloor`: 1 it stops what it
//    stops, but is never a floor `traceLights` shows the light on.
//
// It works in a browser only: Node has no WebGL. The wasm library loads while this module is
// imported (top-level await), so `cover` is ready to call as soon as the import has finished.
//
// A page that has to be sure of a fresh copy of the library loads this file under an address of
// its own, with something after a "?" (as the Foundry module does). Whatever follows the "?" is
// passed on to the two files this one loads, test_local_gpu_lib.mjs and test_local_gpu_lib.wasm,
// so that they are fresh copies too and the three fit each other.
const asked = new URL(import.meta.url).search;
const { default: createModule } = await import(`./test_local_gpu_lib.mjs${asked}`);

const M = await createModule({ locateFile: (file) => new URL(file, import.meta.url).href.split('?')[0] + asked });

// The script cannot create a WebGL context itself, so one is made here and handed to the
// module's GL layer. For its results the script draws into targets of its own and reads them
// back; the canvas itself only ever holds the picture `testLightAdaptive` can draw (see there),
// and is kept between calls so that a page can show it.
if (typeof document === 'undefined') throw new Error('test_local_gpu: needs a browser (WebGL 2)');
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
if (!gl) throw new Error('test_local_gpu: this browser has no WebGL 2');
M.GL.makeContextCurrent(M.GL.registerContext(gl, { majorVersion: 2, minorVersion: 0 }));

// The build keeps 8-byte pointers: a pointer passed to or returned from a script export
// is a BigInt, while _malloc and the string helpers work with plain numbers.
const readString = (ptr) => (ptr ? M.UTF8ToString(Number(ptr)) : '');

const ctx = M._test_local_gpu_lib_create();
if (!ctx) throw new Error(`test_local_gpu: create failed: ${readString(M._test_local_gpu_lib_last_error(0n))}`);

function allocString(text) {
	const size = M.lengthBytesUTF8(text) + 1;
	const ptr = M._malloc(size);
	M.stringToUTF8(text, ptr, size);
	return ptr;
}

function allocFloat3([x, y, z]) {
	const ptr = M._malloc(12);
	M.HEAPF32.set([x, y, z], ptr / 4);
	return ptr;
}

// Lists of numbers go to the script in one block of its memory that every call uses from its
// start again (`fresh`), so that a call that is made often asks for no memory. A list the block
// has no room for gets memory of its own until the next call.
let block = 0;
let blockSize = 0;
let used = 0;
const spilled = [];

function fresh() {
	used = 0;
	for (const ptr of spilled.splice(0)) M._free(ptr);
}

function room(bytes) {
	const at = (used + 7) & ~7;
	if (at + bytes <= blockSize) {
		used = at + bytes;
		return block + at;
	}
	if (used === 0) {
		if (block) M._free(block);
		blockSize = Math.max(bytes * 2, 65536);
		block = M._malloc(blockSize);
		used = bytes;
		return block;
	}
	const ptr = M._malloc(Math.max(bytes, 8));
	spilled.push(ptr);
	return ptr;
}

/** Puts numbers into the script's memory, as single (4 bytes) or double (8 bytes) floats or as bytes; the pointer to them. */
function floats(list) {
	const ptr = room(Math.max(list.length, 1) * 4);
	M.HEAPF32.set(list, ptr / 4);
	return BigInt(ptr);
}

function doubles(list) {
	const ptr = room(Math.max(list.length, 1) * 8);
	M.HEAPF64.set(list, ptr / 8);
	return BigInt(ptr);
}

function bytes(list) {
	const ptr = room(Math.max(list.length, 1));
	M.HEAPU8.set(list, ptr);
	return BigInt(ptr);
}

/** Calls a script export and throws what the script raised, if it raised anything. */
function call(exported, ...given) {
	const result = exported(ctx, ...given);
	const error = M._test_local_gpu_lib_last_error(ctx);
	if (error) throw new Error(`test_local_gpu: ${readString(error)}`);
	return result;
}

/** The list of numbers the script export called last handed back, copied out of its memory. */
const resultDoubles = (count) => { const at = Number(M._test_local_gpu_lib_result_doubles(ctx)) / 8; return M.HEAPF64.slice(at, at + count); };
const resultFloats = (count) => { const at = Number(M._test_local_gpu_lib_result_floats(ctx)) / 4; return M.HEAPF32.slice(at, at + count); };
const resultInts = (count) => { const at = Number(M._test_local_gpu_lib_result_ints(ctx)) / 4; return M.HEAP32.slice(at, at + count); };

/** The triangles of flat surfaces (`{ z, t }` each, `t` six numbers per triangle) as seven numbers each: the height, then the corners. */
function trianglesOf(surfaces) {
	const list = [];
	for (const { z, t } of surfaces) for (let i = 0; i + 5 < t.length; i += 6) list.push(z, t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], t[i + 5]);
	return list;
}

/** A height that may be without end, as the scene in perspective and the outlines take it. */
const BIG = 1e9;
const orElse = (value, none) => (Number.isFinite(value) ? value : none);

/** Tokens, walls and lights as lists of numbers, seven each, as view3d.das and isometric.das take them. */
const tokenNumbers = (tokens) => tokens.flatMap((token) => [token.x, token.y, token.radius, token.bottom, token.top, token.picked ? 1 : 0, token.shows ?? 0]);
const wallNumbers = (walls) => walls.flatMap((wall) => [wall.a.x, wall.a.y, wall.b.x, wall.b.y, orElse(wall.bottom, -BIG), orElse(wall.top, BIG), wall.mirror ? 1 : 0]);
const lightNumbers = (lights) => lights.flatMap((light) => [light.x, light.y, light.z ?? 0, ...(light.color ?? [1, 1, 1]), light.strength ?? 1]);

// The script returns its two result arrays back to back, "[...][...]", which is not one JSON
// document; this cuts the text where each top-level value ends and parses the pieces.
function parseJsonValues(text) {
	const values = [];
	let depth = 0;
	let start = 0;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === '\\') i++;
			else if (c === '"') inString = false;
		} else if (c === '"') {
			inString = true;
		} else if (c === '[' || c === '{') {
			if (depth++ === 0) start = i;
		} else if ((c === ']' || c === '}') && --depth === 0) {
			values.push(JSON.parse(text.slice(start, i + 1)));
		}
	}
	return values;
}

// Calls a script export that takes the tree and one point and returns one JSON array.
function callWithPoint(exported, treeJson, point) {
	const pTree = allocString(treeJson);
	const pPoint = allocFloat3(point);
	try {
		// Reclaims the script memory of the previous call, whose result was copied out below.
		M._test_local_gpu_lib_collect(ctx);
		const result = exported(ctx, BigInt(pTree), BigInt(pPoint));
		const error = M._test_local_gpu_lib_last_error(ctx);
		if (error) throw new Error(`test_local_gpu: ${readString(error)}`);
		const values = parseJsonValues(readString(result));
		if (values.length !== 1) {
			throw new Error(`test_local_gpu: expected one result array from the script, got ${values.length}`);
		}
		return values[0];
	} finally {
		M._free(pTree);
		M._free(pPoint);
	}
}

export const cover = {
	/**
	 * Tests the segment from `a` to `b` against the objects of the tree in `treeJson`. The box of
	 * a wall stands from the wall's bottom to its top, as the wall does.
	 *
	 * @param {string} treeJson
	 * @param {[number, number, number]} a
	 * @param {[number, number, number]} b
	 * @returns {{ boxHits: object[], wallHits: object[] }} `boxHits`: objects whose bounding
	 *   box the segment crosses; `wallHits`: those of them whose wall it crosses as well
	 */
	test(treeJson, a, b) {
		const pTree = allocString(treeJson);
		const pA = allocFloat3(a);
		const pB = allocFloat3(b);
		try {
			// Reclaims the script memory of the previous call, whose result was copied out below.
			M._test_local_gpu_lib_collect(ctx);
			const result = M._test_local_gpu_lib_test(ctx, BigInt(pTree), BigInt(pA), BigInt(pB));
			const error = M._test_local_gpu_lib_last_error(ctx);
			if (error) throw new Error(`test_local_gpu: ${readString(error)}`);
			const values = parseJsonValues(readString(result));
			if (values.length !== 2) {
				throw new Error(`test_local_gpu: expected two result arrays from the script, got ${values.length}`);
			}
			return { boxHits: values[0], wallHits: values[1] };
		} finally {
			M._free(pTree);
			M._free(pA);
			M._free(pB);
		}
	},
	/**
	 * Finds the walls visible from `point`. It spins a ray around the point in 1 degree steps
	 * (360 rays); each ray stops at the first wall it meets, and a wall met by several rays
	 * counts once. Then it takes a closer look where two of the rays it is about to return are
	 * less than a degree apart: around the middle between them, a degree to either side, it sends
	 * a ray every 0.05 degrees, and adds the walls those rays find. The look is level, at the
	 * height of `point`, and takes in the walls that stand at that height.
	 *
	 * @param {string} treeJson
	 * @param {[number, number, number]} point
	 * @returns {{ origin: {x: number, y: number, z: number}, dir: {x: number, y: number, z: number} }[]}
	 *   two rays per visible wall, one after the other: each starts at one end of the wall
	 *   (`origin`) and reaches `point` (`origin + dir`). Where another visible wall hides that
	 *   end, the ray starts at the end of the visible part of the wall instead.
	 */
	testRadAdaptive(treeJson, point) {
		return callWithPoint(M._test_local_gpu_lib_test_rad_adaptive, treeJson, point);
	},
	/**
	 * Reads `point` as a light source and returns, for every wall its light reaches, the area
	 * that wall keeps the light from. The walls and rays are the ones `testRadAdaptive` finds.
	 *
	 * @param {string} treeJson
	 * @param {[number, number, number]} point
	 * @returns {{ wall: object, partly: boolean, rayA: object, rayB: object, area: {x: number, y: number, z: number}[] }[]}
	 *   per wall: `wall`, the whole wall as `{ origin, dir }`; `partly`, true when another wall
	 *   hides part of it; `rayA` and `rayB`, the rays from the ends of its lit part to `point`;
	 *   `area`, the corners of its shadow in drawing order, the far ones well outside the map
	 *   (empty when `point` sits on the wall)
	 *
	 * With `picture`, the call also path traces a picture of the light and leaves it on
	 * `cover.canvas`: one pixel per place of the tree's root cell, from black (no light) to white,
	 * counting the light that comes straight from `point` and the light that walls throw back.
	 * The picture shows the light on a floor at the height of `point`. The call returns when the
	 * picture is drawn.
	 *
	 * @param {{ width: number, height: number, samples: number, bounces: number }} [picture]
	 *   `width` and `height`: size of the picture in pixels; `samples`: paths followed per pixel
	 *   (1 to 1024); `bounces`: walls a path may bounce off (0 to 16, 0 shows direct light only)
	 */
	testLightAdaptive(treeJson, point, picture) {
		const { width = 0, height = 0, samples = 0, bounces = 0 } = picture || {};
		// resizing a canvas clears it, so it is only done when the size changes
		if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
			canvas.width = width;
			canvas.height = height;
		}
		return callWithPoint((context, tree, at) => M._test_local_gpu_lib_test_light_adaptive(context, tree, at, width, height, samples, bounces),
			treeJson, point);
	},
	/**
	 * Path traces a picture of the light of any number of light sources and leaves it on
	 * `cover.canvas`: one pixel per place of the tree's root cell, black where no light gets to,
	 * in the color of the light that does, counting the light that comes straight from a source
	 * and the light that walls and flat surfaces throw back. The picture is made for a screen
	 * (gamma 2.2), so it can be shown as it is; the brightest light of one source is white, and
	 * more light than that is white too. The call returns when the picture is drawn.
	 *
	 * The picture shows the light on the floor of the map. The ground lies level at the height
	 * `picture.floor`. Where a surface that stops movement (and does not say `noFloor`) lies over
	 * a place, above the ground and below `picture.ceiling`, the highest such surface is the floor
	 * there: a place under a raised floor shows the light on that floor, a place beside it the
	 * light on the ground. Light runs through the room: a source is at its own height, a
	 * wall stops light between its bottom and its top (light passes over a low wall and under a
	 * raised one, and the wall's shadow on the floor is as long as that makes it), and a surface
	 * that stops light does so over its area. How far a place is from a source, for the reach of
	 * its light, counts with the difference in height.
	 *
	 * Each wall acts on the light the way its object in the tree says in `w` (Foundry's values):
	 * `light` 0 lets light through, 10 (limited) stops light that has crossed another limited
	 * wall, 20 stops it, 30 (proximity) lets through the light of a source nearer than
	 * `lightThreshold`, 40 (distance) that of a source farther away; `dir` 1 or 2 makes it act
	 * from one side only. `metallicLeft` and `smoothnessLeft` say what the left face of the wall
	 * is like, `metallicRight` and `smoothnessRight` its right face, each 0 to 1; the left face
	 * is the one a wall of direction 1 ("left") acts on. A face that is not metallic scatters
	 * the light it gets to all sides, a metallic face mirrors it, and smoothness is how sharp
	 * the mirror is (1 mirrors exactly, 0 spreads the mirrored light a quarter turn to either
	 * side). An object without `w` is a wall that stops light from both sides and is neither
	 * metallic nor smooth.
	 *
	 * @param {string} treeJson
	 * @param {object[]} lights per source: `x`, `y` and `z`, its height (0 if left out);
	 *   `radius`, how far its light reaches, and
	 *   `bright`, how far its bright light does (the rest is dim, half as bright), in map units;
	 *   `color`, `[r, g, b]` from 0 to 1 (white if left out); `walls`, false for a source that
	 *   shines through walls; `angle`, the width of its cone in degrees (360 or left out: all
	 *   round) and `rotation`, where the cone points, in degrees clockwise from straight down;
	 *   `attenuation`, how soft its edges are, 0 to 1 (0.5 if left out); `externalRadius`, the
	 *   size of the source itself, which counts for proximity and distance walls; `dimLevel`,
	 *   how bright its dim light looks next to its bright light, 0 to 1 (0.25 if left out, as
	 *   in Foundry); `reflectedOnly`, true for a source of which the picture is to hold only
	 *   the light that walls throw back, because what comes straight from it is drawn elsewhere;
	 *   `strength`, how much of its color its light has, 0 to 1 (1 if left out; the rest of the
	 *   light is white). A source whose light reaches nowhere takes no part
	 * @param {{ width: number, height: number, samples: number, bounces: number, smoothing: number, wallHeight: number }} picture
	 *   as for `testLightAdaptive`, and `smoothing`: how many times the light the walls throw
	 *   back is smoothed to take the noise of path tracing out of it, 0 to 6 (3 if left out;
	 *   0 leaves the noise in). Smoothing never spreads light through a wall that stands on the
	 *   floor. `floor`: the height of the ground (0 if left out). `ceiling`: the height below
	 *   which a surface that stops movement is a floor of the picture (no limit if left out).
	 *   `wallHeight`:
	 *   up to how far above the floor a wall without a top throws light back, in map units (above
	 *   its own bottom, where that is higher). Such a wall is lit as high up as the light of a
	 *   source carries, and would throw all of that back down; 0, or left out, lets it.
	 *   `antialias`: at how many places of a pixel's side the light that comes straight from the
	 *   sources is taken, 1 to 4 (1 if left out). Above 1 the edges of shadows and of the reach
	 *   of a source come out smooth and not in steps; 3 takes nine places per pixel.
	 * @returns {{ lights: number, walls: number, surfaces: number }} how many sources, how many
	 *   walls that act on light, and how many triangles of surfaces that stop light took part
	 */
	traceLights(treeJson, lights, picture) {
		const { width = 0, height = 0, samples = 0, bounces = 0, smoothing = 3, wallHeight = 0, antialias = 1, floor = 0, ceiling = Infinity } = picture || {};
		if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
			canvas.width = width;
			canvas.height = height;
		}
		const pTree = allocString(treeJson);
		fresh();
		// sixteen floats per source, as sourcesOf of the script reads them
		const pLights = floats(lights.flatMap((light) => {
			const color = light.color ?? [1, 1, 1];
			return [light.x, light.y, light.radius, light.bright ?? 0, color[0], color[1], color[2], light.walls === false ? 0 : 1,
				light.angle ?? 360, light.rotation ?? 0, light.attenuation ?? 0.5, light.strength ?? 1,
				light.externalRadius ?? 0, light.dimLevel ?? 0.25, light.reflectedOnly ? 1 : 0, light.z ?? 0];
		}));
		try {
			M._test_local_gpu_lib_collect(ctx);
			const result = call(M._test_local_gpu_lib_trace_lights, BigInt(pTree), pLights, lights.length, width, height, samples, bounces, smoothing, wallHeight, antialias, floor, Math.min(ceiling, 1e9));
			const values = parseJsonValues(readString(result));
			if (values.length !== 1) {
				throw new Error(`test_local_gpu: expected one result from the script, got ${values.length}`);
			}
			return values[0];
		} finally {
			M._free(pTree);
		}
	},
	/** The canvas `testLightAdaptive` and `traceLights` draw their picture on; a page may put it into its document. */
	canvas,
	/**
	 * The picture that is on `cover.canvas`, as numbers.
	 *
	 * @returns {{ width: number, height: number, data: Uint8Array }} `data` holds four bytes per
	 *   pixel (red, green, blue, 255), row after row, starting with the BOTTOM row of the picture
	 */
	readPicture() {
		const { width, height } = canvas;
		const data = new Uint8Array(width * height * 4);
		// the script leaves the canvas as what is drawn to and read from
		gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
		return { width, height, data };
	},
	/**
	 * How much of each of several round targets the walls hide from a round source.
	 *
	 * A target is an upright cylinder: a circle on the map, from its bottom up to its top. What
	 * is hidden of it is a share of what a point of the source sees of it: of the cone of all
	 * lines of sight from that point to the target.
	 *
	 * Only walls and surfaces that stop movement hide anything: an object of the tree whose
	 * `w.move` is 0 (Foundry's value for a wall that lets movement through, and for an open door)
	 * is left out, and a one-way wall (`w.dir` 1 or 2) hides only what is looked at from the side
	 * it acts from. A wall hides what is seen through it between its bottom and its top; a look
	 * that passes over or under it is free. An object without `w` is a wall that stops movement
	 * from both sides, as deep and as high as the map goes.
	 *
	 * For each target, the source is looked from at `points` points, spread evenly along its
	 * diameter that lies across the line from source to that target (the first point is one end
	 * of that diameter, the last the other), all at the height of `source`. From each point the
	 * target fills a cone of lines of sight. On the map the cone lies between the two directions
	 * that just touch the target circle, and it is swept in directions at most 0.05 degrees
	 * apart. In each direction the target is seen from a lowest to a highest line of sight: from
	 * its bottom to its top, and over its top onto the far edge where the point looks down on it.
	 * Between those two, `heights` rays are spread evenly by angle. A ray that a wall or a surface
	 * stops before it reaches the target counts as blocked, and it counts for as much of the
	 * cone as lies round it.
	 *
	 * @param {string} treeJson
	 * @param {[number, number, number]} source centre of the source, at the height it looks from
	 * @param {[number, number, number, number?, number?][]} targets per target the centre on the
	 *   map, its bottom and its top, and its diameter; a target without a top is flat, a disc at
	 *   its one height, and one without a diameter is `targetDiameter` wide
	 * @param {number} sourceDiameter in map units
	 * @param {number} targetDiameter of every target that names none, in map units
	 * @param {number} points how many points of the source to look from (at least 1)
	 * @param {number} [heights] how many rays to send up and down in each direction, 1 to 24 (1
	 *   if left out, which is the line of sight half way between the lowest and the highest)
	 * @param {boolean} [keep] true to have `view.frame` show these results as the cover test
	 *   from now on: of each target the view from the point of the source that sees most of it
	 * @returns {{ target: object, top: number, radius: number, heights: number, lineA: object, lineB: object, obstructed: number, best: number, points: object[] }[]}
	 *   one result per target, in the order of `targets`. `target`: its centre, at its bottom;
	 *   `top`: its top; `radius`: half its diameter; `heights`: how many rays were sent up and
	 *   down; `lineA` and `lineB`: the ends of the source's diameter used for it; `obstructed`:
	 *   the smallest share of the target that any of the points cannot see, 0 to 1; `best`:
	 *   which of the points that is, counted from 0; `points`: per point `at`, `rayA` and
	 *   `rayB` (the two touching rays, on the map), `rays` (sent), `blocked` (stopped),
	 *   `obstructed` (the share of the cone the blocked rays stand for) and `runs`: stretches
	 *   of neighbouring directions in which the same rays are blocked, each
	 *   `{ blocked, share, mask, from, to }`: `mask` has one bit per ray of a direction, the
	 *   lowest first, set where that ray is stopped; `share` is what the blocked rays stand for
	 *   in the first direction (`blocked` is true when all are); `from` and `to` are on the
	 *   target circle
	 */
	testCover(treeJson, source, targets, sourceDiameter, targetDiameter, points, heights = 1, keep = false) {
		const pTree = allocString(treeJson);
		fresh();
		const pSource = floats(source);
		// the targets one after the other, five floats each
		const pTargets = floats(targets.flatMap(([x, y, z, top = z, diameter = targetDiameter]) => [x, y, z, top, diameter]));
		try {
			M._test_local_gpu_lib_collect(ctx);
			const result = call(M._test_local_gpu_lib_test_cover, BigInt(pTree), pSource, pTargets, targets.length, sourceDiameter, points, heights, keep ? 1 : 0);
			const values = parseJsonValues(readString(result));
			if (values.length !== 1) {
				throw new Error(`test_local_gpu: expected one result array from the script, got ${values.length}`);
			}
			return values[0];
		} finally {
			M._free(pTree);
		}
	},
	/**
	 * Where the light of the picture on `cover.canvas` counts as lit. The script reads the picture
	 * and keeps the answer for `litAt`.
	 *
	 * @param {number} dimLevel how bright dim light looks next to bright light, 0 to 1
	 * @param {number} share the share of that from which a place counts as lit
	 * @returns {{ width: number, height: number, image: Uint8ClampedArray }|null} `image` holds
	 *   four bytes per pixel, top row first: red and solid where a place is lit, nothing
	 *   elsewhere; null while there is no picture
	 */
	litMap(dimLevel, share) {
		const { width, height } = canvas;
		if (!(width > 0 && height > 0)) return null;
		fresh();
		const ptr = room(width * height * 4);
		const pixels = call(M._test_local_gpu_lib_read_lit, dimLevel, share, BigInt(ptr));
		if (pixels !== width * height) return null;
		return { width, height, image: new Uint8ClampedArray(M.HEAPU8.slice(ptr, ptr + pixels * 4).buffer) };
	},
	/**
	 * How bright the light `litMap` read makes a place of the map.
	 * @returns {number} 0 not lit, 1 as dim light, 2 as bright light; 0 outside the picture, and
	 *   -1 while nothing was read
	 */
	litAt(x, y) {
		return call(M._test_local_gpu_lib_lit_at, x, y);
	},
	/**
	 * Takes the walls and the flat surfaces that can be in the way of a line of sight; `sees`
	 * and the mirror functions work on them until the next call.
	 *
	 * @param {object[]} walls each `{ ax, ay, bx, by, sight, dir, threshold, bottom, top,
	 *   metallicLeft, smoothnessLeft, metallicRight, smoothnessRight }`: its two ends, what
	 *   Foundry's Edge says of it for sight, the heights it stands between (-Infinity and
	 *   Infinity where it names none), and what its two faces are like. A face that is fully
	 *   metallic and fully smooth is a mirror. A wall is known afterwards by its place in this list
	 * @param {object[]} surfaces the flat surfaces that stop sight, `{ z, t }` each
	 * @param {{x: number, y: number, width: number, height: number}} [rect] a rectangle whose
	 *   four sides end every line of sight, as walls do
	 * @returns {boolean} true when nothing has a height: every line of sight is then as on a flat map
	 */
	setSight(walls, surfaces = [], rect = null) {
		fresh();
		const pWalls = doubles(walls.flatMap((wall) => [wall.ax, wall.ay, wall.bx, wall.by, wall.sight, wall.dir, wall.threshold, wall.bottom, wall.top,
			wall.metallicLeft, wall.smoothnessLeft, wall.metallicRight, wall.smoothnessRight]));
		const triangles = trianglesOf(surfaces);
		const { x = 0, y = 0, width = 0, height: tall = 0 } = rect ?? {};
		return call(M._test_local_gpu_lib_set_sight, pWalls, walls.length, doubles(triangles), triangles.length / 7, x, y, width, tall) === 1;
	},
	/**
	 * True when sight gets from one place to one of some others: on a straight line through the
	 * room, or, with `chain` above 0, by way of up to that many mirrors in a row.
	 * @param {{x: number, y: number, z: number}} from z being the height
	 * @param {{x: number, y: number, z: number}[]} places
	 * @param {number} [chain]
	 */
	sees(from, places, chain = 0) {
		fresh();
		return call(M._test_local_gpu_lib_sight_clear, from.x, from.y, from.z, doubles(places.flatMap((place) => [place.x, place.y, place.z])), places.length, chain) === 1;
	},
	/** The walls with a face that mirrors that stand at a height, as their places in the list `setSight` was given. */
	mirrorsAt(eye) {
		return Array.from(resultInts(call(M._test_local_gpu_lib_sight_mirrors, eye)));
	},
	/**
	 * The places a mirror is looked at for being seen from a place: one in front of each of
	 * the equal pieces the mirror is cut into. None when the place faces a side that does not mirror.
	 * @returns {{x: number, y: number}[]}
	 */
	mirrorProbes(origin, mirror) {
		const count = call(M._test_local_gpu_lib_mirror_probes, origin.x, origin.y, mirror);
		const numbers = resultDoubles(count * 2);
		return Array.from({ length: count }, (_, i) => ({ x: numbers[i * 2], y: numbers[i * 2 + 1] }));
	},
	/**
	 * The views a place has in a mirror. Each stretch of neighbouring places of `mirrorProbes`
	 * that are seen is a part of the mirror with a view of its own: from the place mirrored at
	 * the wall, through that part, as far as the walls that stand at the height `eye` let it.
	 *
	 * @param {{x: number, y: number}} origin the place looked from
	 * @param {number} mirror the wall, as its place in the list `setSight` was given
	 * @param {boolean[]} seen of each place `mirrorProbes` named, whether it is seen
	 * @param {number} reach how far a line of the view is followed at most
	 * @param {number} eye the height the view is worked out at
	 * @returns {{ number: number, behind: {x: number, y: number}, outline: number[] }[]} per
	 *   view that sees anything: which of the parts of the mirror it is, the mirrored place, and
	 *   the corners of its outline, x and y in turn
	 */
	mirrorViews(origin, mirror, seen, reach, eye) {
		fresh();
		const count = call(M._test_local_gpu_lib_mirror_views, origin.x, origin.y, mirror, bytes(seen.map((flag) => (flag ? 1 : 0))), seen.length, reach, eye);
		const numbers = resultDoubles(count);
		const views = [];
		for (let at = 0; at < count; at += 4 + numbers[at + 3]) {
			views.push({ number: numbers[at], behind: { x: numbers[at + 1], y: numbers[at + 2] }, outline: Array.from(numbers.subarray(at + 4, at + 4 + numbers[at + 3])) });
		}
		return views;
	},
	/**
	 * The places of a token another token looks at: the middle of it and four places half way
	 * out to its corners, each near its head and at half its height.
	 * @param {{x: number, y: number}} centre the middle of the token on the map
	 * @param {number} w how wide it is, @param {number} h how high on the map
	 * @param {number} bottom where it stands, @param {number} top where its head is
	 * @returns {{x: number, y: number, z: number}[]}
	 */
	tokenPlaces(centre, w, h, bottom, top) {
		const count = call(M._test_local_gpu_lib_token_places, centre.x, centre.y, w, h, bottom, top);
		const numbers = resultDoubles(count * 3);
		return Array.from({ length: count }, (_, i) => ({ x: numbers[i * 3], y: numbers[i * 3 + 1], z: numbers[i * 3 + 2] }));
	},
	/**
	 * How the map lies on the screen, but for the zoom, when its x axis runs `tilt` (an angle)
	 * up from level and its y axis as far down: a step of (x, y) on the map is a step of
	 * (a x + c y, b x + d y) on the screen. `up` is the step on the map that is one unit
	 * straight up on the screen; `across` the direction on the map that runs farthest to the
	 * right on the screen.
	 */
	lie(tilt) {
		fresh();
		const ptr = room(36);
		call(M._test_local_gpu_lib_iso_lie, tilt, BigInt(ptr));
		const [a, b, c, d, det, upX, upY, acrossX, acrossY] = M.HEAPF32.subarray(ptr / 4, ptr / 4 + 9);
		return { a, b, c, d, det, up: { x: upX, y: upY }, across: { x: acrossX, y: acrossY } };
	},
	/**
	 * What stands on a map that lies on the screen as `lie(tilt)` says, as shapes to draw, in
	 * the order to draw them in. Each is `{ what, flag, numbers }`:
	 *  - `bodySide` (flag 1 when the token is selected): the outline of a token from its feet
	 *    to its head, the corners of a polygon;
	 *  - `bodyTop` (same flag): its top, the middle of a circle and its radius;
	 *  - `floor`: a triangle of a flat surface above the ground, where it lies;
	 *  - `wall` (flag 1 for a mirror, plus 2 for a wall without a top): the four corners of a
	 *    wall from its bottom to its top;
	 *  - `lamp`: a light: the place it is over, the place it is seen at, and its color.
	 *
	 * @param {number} tilt
	 * @param {number} ground the height the map lies at
	 * @param {number} tall how high a wall without a top is drawn
	 * @param {object[]} tokens `{ x, y, radius, bottom, top, picked }` each
	 * @param {object[]} walls `{ a, b, bottom, top, mirror }` each
	 * @param {object[]} surfaces `{ z, t }` each
	 * @param {object[]} lights `{ x, y, z, color, strength }` each
	 */
	standing(tilt, ground, tall, tokens, walls, surfaces, lights) {
		fresh();
		const triangles = trianglesOf(surfaces);
		const count = call(M._test_local_gpu_lib_iso_shapes, tilt, ground, tall, floats(tokenNumbers(tokens)), tokens.length, floats(wallNumbers(walls)), walls.length,
			floats(triangles), triangles.length / 7, floats(lightNumbers(lights)), lights.length);
		const numbers = resultFloats(count);
		const shapes = [];
		for (let at = 0; at < count; at += 3 + numbers[at + 2]) {
			shapes.push({ what: ['bodySide', 'bodyTop', 'floor', 'wall', 'lamp'][numbers[at]], flag: numbers[at + 1], numbers: numbers.subarray(at + 3, at + 3 + numbers[at + 2]) });
		}
		return shapes;
	},
	/**
	 * The scene in perspective (view3d.das): a camera, what it sees as triangles and lines, and
	 * what the mouse is on. A place on the screen is given from -1 to 1 both ways, x to the right
	 * and y up.
	 */
	view: {
		/**
		 * Takes the scene: `{ floor, viewedBase, tall, area, lightArea, all, levels, surfaces,
		 * walls }` with the rectangles as `{ x, y, width, height }`, `levels` each `{ viewed, base,
		 * plane, color, floors }`, `floors` and `surfaces` each `{ z, t }`, and `walls` each
		 * `{ a, b, bottom, top, mirror }` (see `View3D` of the module for what they mean).
		 */
		scene(scene) {
			const rect = (r) => (r ? [r.x, r.y, r.width, r.height] : []);
			const flat = ({ z, t }) => ({ z, t: Array.from(t) });
			const pText = allocString(JSON.stringify({ floor: scene.floor, viewedBase: scene.viewedBase, tall: scene.tall,
				area: rect(scene.area), lightArea: rect(scene.lightArea), all: rect(scene.all),
				levels: scene.levels.map((level) => ({ viewed: level.viewed ? 1 : 0, base: level.base, plane: level.plane ? 1 : 0, color: level.color ?? [1, 1, 1], floors: level.floors.map(flat) })),
				surfaces: scene.surfaces.map(flat), walls: wallNumbers(scene.walls) }));
			try {
				M._test_local_gpu_lib_collect(ctx);
				call(M._test_local_gpu_lib_view_scene, BigInt(pText));
			} finally {
				M._free(pText);
			}
		},
		/** Shows the view: the camera looks at a place of the ground, from far enough to see what a flat view of the given zoom shows on a screen of the given height. */
		start(x, y, screenHeight, zoom) {
			call(M._test_local_gpu_lib_view_start, x, y, screenHeight, zoom);
		},
		stop() {
			call(M._test_local_gpu_lib_view_stop);
		},
		/**
		 * Works out a frame.
		 *
		 * @param {object} screen `lies`: how the map lies in the picture of the frame, `{ a, b, c,
		 *   d, tx, ty }` of the transform from the map to the screen; `width` and `height` of the
		 *   screen; `aspect`: how much wider than high the view is; `zoom`, `least` and `pivot`:
		 *   the zoom of the flat view, the least it can be, and the place it looks at; `cover`:
		 *   true to show the cover test `testCover` kept
		 * @param {object[]} tokens `{ x, y, radius, bottom, top, picked, shows }` each; `shows` is
		 *   what its top shows: 0 the picture of the frame at its place, 1 its own picture, 2 a color
		 * @param {object[]} lights `{ x, y, z, color, strength }` each
		 * @param {{picture: boolean, light: boolean}[]} levels per level of the scene, whether
		 *   its own picture and the light traced for it are there to show
		 * @returns {object} `matrix`: the camera, sixteen numbers for a shader; `vertices`: ten
		 *   numbers per vertex, valid until the next call of the library; `draws`: each `{ first,
		 *   count, lines, lit, shows, ref, light, glass }`, a run of vertices to draw in one go
		 *   (`lit`: a floor of a level that is not viewed; `shows` 1: the picture of level or
		 *   token number `ref`; `light`: the level whose traced light it shows, or -1; `glass`:
		 *   see-through); `follow`: where the flat view is to move to, `{ x, y, scale }`, or null;
		 *   `pictureArea` and `lightArea`: the rectangles of a level's picture and of the pictures
		 *   of the light, as a shader takes them
		 */
		frame(screen, tokens, lights, levels) {
			fresh();
			const { lies, pivot } = screen;
			const pInputs = floats([lies.a, lies.b, lies.c, lies.d, lies.tx, lies.ty, screen.width, screen.height, screen.aspect, screen.zoom, screen.least, pivot.x, pivot.y, screen.cover ? 1 : 0]);
			const count = call(M._test_local_gpu_lib_view_frame, pInputs, floats(tokenNumbers(tokens)), tokens.length, floats(lightNumbers(lights)), lights.length,
				floats(levels.flatMap((level) => [level.picture ? 1 : 0, level.light ? 1 : 0])));
			const at = Number(M._test_local_gpu_lib_view_head(ctx)) / 4;
			const head = M.HEAPF32.subarray(at, at + 32 + count * 8);
			const draws = [];
			for (let i = 0; i < count; i++) {
				const [first, size, lines, lit, shows, ref, light, glass] = head.subarray(32 + i * 8, 40 + i * 8);
				draws.push({ first, count: size, lines: lines === 1, lit: lit === 1, shows, ref, light, glass: glass === 1 });
			}
			const verts = Number(M._test_local_gpu_lib_view_verts(ctx)) / 4;
			return { matrix: head.slice(0, 16), draws, vertices: M.HEAPF32.subarray(verts, verts + head[17] * 10),
				follow: head[18] === 1 ? { x: head[19], y: head[20], scale: head[21] } : null,
				pictureArea: head.slice(22, 26), lightArea: head.slice(26, 30) };
		},
		/** The left button went down at a place on the screen: what it takes hold of is moved at the height it was taken hold at. */
		press(sx, sy) {
			call(M._test_local_gpu_lib_view_press, sx, sy);
		},
		release() {
			call(M._test_local_gpu_lib_view_release);
		},
		/** Moves the camera over the ground, so that the ground that was under the mouse stays under it. */
		drag(fromX, fromY, toX, toY) {
			call(M._test_local_gpu_lib_view_drag, fromX, fromY, toX, toY);
		},
		/** Turns the camera round the place it looks at and tilts it, by how far the mouse went in pixels. */
		turn(dx, dy) {
			call(M._test_local_gpu_lib_view_turn, dx, dy);
		},
		/** Brings the camera closer or takes it away by what the wheel says; `across` is the diagonal of the scene. */
		zoom(delta, across) {
			call(M._test_local_gpu_lib_view_zoom, delta, across);
		},
		/** The place on the scene the mouse is at, `{ x, y }`; null for the sky and while the view is not shown. */
		sceneAt(sx, sy) {
			fresh();
			const ptr = room(8);
			return call(M._test_local_gpu_lib_view_scene_at, sx, sy, BigInt(ptr)) ? { x: M.HEAPF32[ptr / 4], y: M.HEAPF32[ptr / 4 + 1] } : null;
		},
		/** Where on the screen a place on the ground is seen, from 0 to 1 both ways, x to the right and y down; null when it is behind the camera. */
		screenAt(x, y) {
			fresh();
			const ptr = room(8);
			return call(M._test_local_gpu_lib_view_screen_at, x, y, BigInt(ptr)) ? { x: M.HEAPF32[ptr / 4], y: M.HEAPF32[ptr / 4 + 1] } : null;
		},
		/** The place on the ground the camera looks at. */
		lookedAt() {
			fresh();
			const ptr = room(8);
			call(M._test_local_gpu_lib_view_looked_at, BigInt(ptr));
			return { x: M.HEAPF32[ptr / 4], y: M.HEAPF32[ptr / 4 + 1] };
		},
	},
	/** Size of the wasm memory in bytes. It only ever grows, so a rising number means a leak. */
	memoryBytes() {
		return M.HEAPU8.length;
	},
	/** Frees the script instance and everything it allocated; `test` must not be called afterwards. */
	destroy() {
		M._test_local_gpu_lib_destroy(ctx);
	},
};

export default cover;
