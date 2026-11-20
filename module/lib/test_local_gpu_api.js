// JavaScript wrapper over test_local_gpu_lib.wasm (static/test_local_gpu.das built with
// `daslang -lib`): the same functions as test_local_api.js, with the ray tests run on the
// graphics card through WebGL 2.
//
//   import { cover } from './test_local_gpu_api.js';
//   const { boxHits, wallHits } = cover.test(treeJson, [0, 0, 0], [6000, 4600, 0]);
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
	 * Tests the segment from `a` to `b` against the objects of the tree in `treeJson`.
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
	 * a ray every 0.05 degrees, and adds the walls those rays find.
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
	 * The call returns when the picture is drawn.
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
	 * and the light that walls throw back. The picture is made for a screen (gamma 2.2), so it
	 * can be shown as it is; the brightest light of one source is white, and more light than
	 * that is white too. The call returns when the picture is drawn.
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
	 * @param {object[]} lights per source: `x`, `y`; `radius`, how far its light reaches, and
	 *   `bright`, how far its bright light does (the rest is dim, half as bright), in map units;
	 *   `color`, `[r, g, b]` from 0 to 1 (white if left out); `walls`, false for a source that
	 *   shines through walls; `angle`, the width of its cone in degrees (360 or left out: all
	 *   round) and `rotation`, where the cone points, in degrees clockwise from straight down;
	 *   `attenuation`, how soft its edges are, 0 to 1 (0.5 if left out); `externalRadius`, the
	 *   size of the source itself, which counts for proximity and distance walls; `dimLevel`,
	 *   how bright its dim light looks next to its bright light, 0 to 1 (0.25 if left out, as
	 *   in Foundry); `reflectedOnly`, true for a source of which the picture is to hold only
	 *   the light that walls throw back, because what comes straight from it is drawn elsewhere
	 * @param {{ width: number, height: number, samples: number, bounces: number, smoothing: number, wallHeight: number }} picture
	 *   as for `testLightAdaptive`, and `smoothing`: how many times the light the walls throw
	 *   back is smoothed to take the noise of path tracing out of it, 0 to 6 (3 if left out;
	 *   0 leaves the noise in). Smoothing never spreads light through a wall. `wallHeight`: how
	 *   high the walls stand, in map units. The light a wall throws back spreads upwards too, so
	 *   it thins out along the floor: a half is left one wall height away, a fifth two heights
	 *   away. 0, or left out, stands for a flat map, where reflected light carries all the way.
	 *   `antialias`: at how many places of a pixel's side the light that comes straight from the
	 *   sources is taken, 1 to 4 (1 if left out). Above 1 the edges of shadows and of the reach
	 *   of a source come out smooth and not in steps; 3 takes nine places per pixel.
	 * @returns {{ lights: number, walls: number }} how many sources, and how many walls that
	 *   act on light, took part
	 */
	traceLights(treeJson, lights, picture) {
		const { width = 0, height = 0, samples = 0, bounces = 0, smoothing = 3, wallHeight = 0, antialias = 1 } = picture || {};
		// a source whose light reaches nowhere takes no part
		lights = lights.filter((light) => light.radius > 0);
		if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
			canvas.width = width;
			canvas.height = height;
		}
		const pTree = allocString(treeJson);
		// sixteen floats per source, as the path tracer of the script reads them
		const pLights = M._malloc(Math.max(1, lights.length * 64));
		lights.forEach((light, index) => {
			const { color = [1, 1, 1], angle = 360, rotation = 0, attenuation = 0.5, dimLevel = 0.25 } = light;
			const middle = ((rotation + 90) * Math.PI) / 180;
			const cone = angle >= 360 ? [0, 0, -2] : [Math.cos(middle), Math.sin(middle), Math.cos((angle * Math.PI) / 360)];
			// the same curve Foundry puts the setting through before its shaders get it
			const soft = (Math.cos(Math.PI * Math.pow(Math.min(Math.max(attenuation, 0), 1), 1.5)) - 1) / -2;
			M.HEAPF32.set([light.x, light.y, light.radius, light.bright ?? 0, color[0], color[1], color[2], light.walls === false ? 0 : 1,
				cone[0], cone[1], cone[2], soft, light.externalRadius ?? 0, Math.pow(Math.min(Math.max(dimLevel, 0), 1), 2.2), light.reflectedOnly ? 1 : 0, 0], pLights / 4 + index * 16);
		});
		try {
			M._test_local_gpu_lib_collect(ctx);
			const result = M._test_local_gpu_lib_trace_lights(ctx, BigInt(pTree), BigInt(pLights), lights.length, width, height, samples, bounces, smoothing, wallHeight, antialias);
			const error = M._test_local_gpu_lib_last_error(ctx);
			if (error) throw new Error(`test_local_gpu: ${readString(error)}`);
			const values = parseJsonValues(readString(result));
			if (values.length !== 1) {
				throw new Error(`test_local_gpu: expected one result from the script, got ${values.length}`);
			}
			return values[0];
		} finally {
			M._free(pTree);
			M._free(pLights);
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
	 * Only walls that stop movement hide anything: an object of the tree whose `w.move` is 0
	 * (Foundry's value for a wall that lets movement through, and for an open door) is left
	 * out, and a one-way wall (`w.dir` 1 or 2) hides only what is looked at from the side it
	 * acts from. An object without `w` is a wall that stops movement from both sides.
	 *
	 * For each target, the source is looked from at `points` points, spread evenly along its
	 * diameter that lies across the line from source to that target (the first point is one end
	 * of that diameter, the last the other). From each point, the sector between the two rays
	 * that just touch the target circle is swept with rays at most 0.05 degrees apart; a ray a
	 * wall crosses before it reaches the circle counts as blocked.
	 *
	 * @param {string} treeJson
	 * @param {[number, number, number]} source centre of the source
	 * @param {[number, number, number][]} targets centres of the targets
	 * @param {number} sourceDiameter in map units
	 * @param {number} targetDiameter of every target, in map units
	 * @param {number} points how many points of the source to look from (at least 1)
	 * @returns {{ target: object, lineA: object, lineB: object, obstructed: number, points: object[] }[]}
	 *   one result per target, in the order of `targets`. `target`: its centre; `lineA` and
	 *   `lineB`: the ends of the source's diameter used for it; `obstructed`: the smallest share
	 *   of the target that any of the points cannot see, 0 to 1; `points`: per point `at`,
	 *   `rayA` and `rayB` (the two touching rays), `rays` (sent), `blocked` (stopped by a wall),
	 *   `obstructed` (blocked / rays) and `runs`: stretches of neighbouring rays that end the
	 *   same way, each `{ blocked, from, to }` with `from` and `to` on the target circle
	 */
	testCover(treeJson, source, targets, sourceDiameter, targetDiameter, points) {
		const pTree = allocString(treeJson);
		const pSource = allocFloat3(source);
		// the targets one after the other, 12 bytes each (at least one byte, so the pointer is real)
		const pTargets = M._malloc(Math.max(1, targets.length * 12));
		targets.forEach(([x, y, z], index) => M.HEAPF32.set([x, y, z], pTargets / 4 + index * 3));
		try {
			M._test_local_gpu_lib_collect(ctx);
			const result = M._test_local_gpu_lib_test_cover(ctx, BigInt(pTree), BigInt(pSource), BigInt(pTargets), targets.length,
				sourceDiameter, targetDiameter, points);
			const error = M._test_local_gpu_lib_last_error(ctx);
			if (error) throw new Error(`test_local_gpu: ${readString(error)}`);
			const values = parseJsonValues(readString(result));
			if (values.length !== 1) {
				throw new Error(`test_local_gpu: expected one result array from the script, got ${values.length}`);
			}
			return values[0];
		} finally {
			M._free(pTree);
			M._free(pSource);
			M._free(pTargets);
		}
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
