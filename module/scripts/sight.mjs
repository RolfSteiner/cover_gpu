// Lines of sight through a scene that has height.
//
// Foundry works out what a token sees as an outline on the map: a flat shape, cut off by every
// wall that counts for the token. With heights that is not the whole of it. A token looks over
// a wall that ends below the line from its eyes to what it looks at, and under one that begins
// above that line, and a floor or a roof between the two is in the way though no wall is. So a
// single line of sight is followed as it runs through the room: from a place at a height to
// another place at another height, past the walls where they stand at the height the line has
// there, and through the flat surfaces it crosses on its way up or down.
//
// The following is done by the script library (src/sight.das, see there for how a wall stops
// sight), and so is everything about mirrors that is geometry. This file reads from the scene
// what can be in the way, hands it to the library when it is first asked after a change, and
// passes the questions on: `Obstacles`. The walls are those of the viewed level with their
// heights (see heights.mjs), and the surfaces those that stop sight; the four sides of the
// canvas end every line of sight, as they end Foundry's views.
//
// The Foundry types named here are the ones of the pf2e system's declarations
// (github.com/foundryvtt/pf2e, types/foundry): Edge in client/canvas/geometry/edges/edge.d.mts.

import { surfaceList } from './heights.mjs';
import { wallEffect } from './quadtree.mjs';

/**
 * The walls of the viewed level as the library takes them for lines of sight (`setSight`):
 * what Foundry's Edge of each says of sight, the heights it stands between, and what its two
 * faces are like, with the id of its document.
 * @returns {object[]}
 */
function sceneWalls() {
	const walls = [];
	for (const wall of canvas.walls?.placeables ?? []) {
		const document = wall.document;
		const [ax, ay, bx, by] = document.c;
		if (ax === bx && ay === by) continue;
		const { sight, dir, sightThreshold, bottom, top, metallicLeft, smoothnessLeft, metallicRight, smoothnessRight } = wallEffect(document);
		walls.push({ id: document.id, ax, ay, bx, by, sight, dir, threshold: sightThreshold, bottom, top, metallicLeft, smoothnessLeft, metallicRight, smoothnessRight });
	}
	return walls;
}

/** What can be in the way of a line of sight on the viewed scene, as the script library knows it. */
export class Obstacles {
	/** Counts the changes of walls and surfaces. */
	#count = 0;

	/** The script library; null until it is loaded, and until then nothing is seen and nothing is in the way. */
	#cover = null;

	/** What the library was last given: the count it was read at, the ids of the walls in the order given, and whether nothing has a height. */
	#given = null;

	/** A number that moves on with every change of a wall or a surface. */
	get count() {
		return this.#count;
	}

	/** To be called when a wall or a region was added, changed or removed. */
	changed() {
		this.#count++;
	}

	/** Takes the script library (lib/test_local_gpu_api.js). */
	use(cover) {
		this.#cover = cover;
		this.#given = null;
	}

	/** The library, with the walls and surfaces as they are now; null while there is no library. */
	#fresh() {
		if (!this.#cover) return null;
		if (this.#given?.at !== this.#count) {
			const walls = canvas.walls ? sceneWalls() : [];
			const flat = this.#cover.setSight(walls, surfaceList().filter((surface) => surface.sight), canvas.walls ? canvas.dimensions?.rect : null);
			this.#given = { at: this.#count, ids: walls.map((wall) => wall.id), flat };
		}
		return this.#cover;
	}

	/** The ids of the walls, by the place the library knows each wall by. */
	get ids() {
		return this.#fresh() ? this.#given.ids : [];
	}

	/** True while no wall names a height and no surface stops sight, and while there is no library to ask. */
	get flat() {
		return this.#fresh() ? this.#given.flat : true;
	}

	/**
	 * True when sight gets from one place to one of some others, each `{ x, y, z }` with z its
	 * height in scene pixels: on a straight line through the room, or, with `chain` above 0, by
	 * way of up to that many mirrors in a row.
	 */
	sees(from, places, chain = 0) {
		return this.#fresh()?.sees(from, places, chain) ?? false;
	}

	/** The places of a token another token looks at (`tokenPlaces` of the library). */
	tokenPlaces(centre, w, h, bottom, top) {
		return this.#cover?.tokenPlaces(centre, w, h, bottom, top) ?? [];
	}

	/** The mirrors that stand at a height, each as the place the library knows its wall by. */
	mirrorsAt(eye) {
		return this.#fresh()?.mirrorsAt(eye) ?? [];
	}

	/** The places a mirror is looked at for being seen from `origin` (`mirrorProbes` of the library). */
	mirrorProbes(origin, mirror) {
		return this.#fresh()?.mirrorProbes(origin, mirror) ?? [];
	}

	/** The views `origin` has in a mirror (`mirrorViews` of the library). */
	mirrorViews(origin, mirror, seen, reach, eye) {
		return this.#fresh()?.mirrorViews(origin, mirror, seen, reach, eye) ?? [];
	}
}
