// Tokens see by way of mirrors.
//
// A face of a wall that is fully metallic and fully smooth is a mirror (see settings.mjs,
// SURFACE). What a token sees in a mirror is what it would see standing behind the mirror, as
// far behind it as it stands in front, looking through the mirror as through a window: the
// line from that place through a point of the mirror runs on, in front of the mirror, exactly
// where the mirrored line of sight runs. So each part of a mirror a token can see gives the
// token a second viewpoint, the token's place mirrored at the wall, whose view starts at that
// part of the mirror and is stopped by the walls in front of it. Distances count from the
// mirrored place, which makes them the length of the way by the mirror: a token's sight range
// and the reach of its light perception hold along that way.
//
// Mirrors work in a row. A viewpoint behind a mirror sees mirrors as the token does, and each
// part of a mirror it sees gives a further viewpoint: its own place mirrored at that wall,
// looking through that part. Nothing else has to be carried along the row, since the view a
// further viewpoint starts from is already narrowed to what all the mirrors before it let
// through. How many mirrors a line of sight may take in a row is the setting `mirrorChain`;
// two mirrors facing each other would go on for ever otherwise.
//
// A viewpoint is a vision source of the token's own kind (Foundry's PointVisionSource, or the
// one a system puts in its place, as pf2e does), set up with the token's vision data at the
// mirrored place. Its line of sight is worked out here (`viewThrough`), not by Foundry: after a
// mirror or two the mirrored place lies far outside the scene, and Foundry works out views
// from places inside it only. The outline found here is handed to the source as its `los`
// polygon, and Foundry's own functions cut from it the two other shapes a vision source has:
// `shape`, the part within sight range, and `light`, the part within reach of light
// perception.
//
// The source is then added to the vision sources of the canvas (canvas.effects.visionSources),
// next to the token's own, and Foundry treats it as it treats any vision source: it draws its
// shapes into the vision mask and the explored fog, it draws what the token's vision mode adds
// to a view (the brightening and the colors of darkvision, by the way along the mirrors), and
// it asks it when it decides whether a token or another thing is shown. Two things are left to
// do here:
//  - The viewpoints have to be right before Foundry draws from them. Foundry draws its
//    lighting and its vision mask anew in one go, some time after a token's own view has
//    changed, so the viewpoints are looked over just before that, every frame (`keepUp`,
//    called from a ticker that runs ahead of Foundry's perception update). Looking over is a
//    comparison of a few numbers while nothing has changed.
//  - Foundry leaves a vision source out when it tests a place inside the scene and the source
//    lies outside it, as mirrored places often do. CanvasVisibility#testVisibility therefore
//    also asks the token's sight and light perception (the detection modes of
//    CONFIG.Canvas.detectionModes, so a system's own rules hold) from each viewpoint: `sees`,
//    which the wrapper on Foundry's function in wrappers.mjs asks.
//
// Whether one place can be seen from another by way of mirrors is a question of its own, asked
// about any two tokens, whether or not they are the ones a user sees with (`sightBetween`). It
// needs no views: the place looked from is mirrored at each mirror of a row in turn, which
// gives the one way the line of sight can take by those mirrors, and that way is followed.
//
// The scene has height (see heights.mjs), and a mirror is as high as its wall. A view is a flat
// shape, as all of Foundry's are, so it is worked out level, at the height the token looks
// from: with the walls that stand at that height, of which those with a mirroring face are its
// mirrors. This is how Wall Height has Foundry work out the token's own view. A single line of
// sight is followed through the room (`sightBetween`): a mirror stands upright, so the line
// climbs or falls evenly along its whole way by the mirrors, it has to meet each mirror between
// the mirror's bottom and its top, and it passes over and under walls as any line of sight
// does (see sight.mjs).
//
// The Foundry types named here are the ones of the pf2e system's declarations
// (github.com/foundryvtt/pf2e, types/foundry): PointVisionSource in
// client/canvas/sources/point-vision-source.d.mts, CanvasVisibility in
// client/canvas/groups/visibility.d.mts, PointSourcePolygon in
// client/canvas/geometry/shapes/source-polygon.d.mts.

import { tokenHeights } from './heights.mjs';
import { value } from './settings.mjs';
import { stopped } from './sight.mjs';

/** A mirror is looked at for being seen at one place every this many scene pixels along it. */
const STEP = 20;

/** How far in front of a mirror a place is taken to see whether the seer sees that place of it. */
const OFF = 2;

/** The most viewpoints one token is given, whatever the mirrors would allow. */
const MOST = 48;

/** A view is followed along a line at least every this much of a turn, in radians (half a degree). */
const FINE = Math.PI / 360;

/** How far to either side of the end of a wall a view is followed as well, in radians. */
const BESIDE = 0.0001;

/** Foundry's CONST.EDGE_SENSE_TYPES. */
const LIMITED = 10;
const PROXIMITY = 30;

/** The most rows of mirrors that are tried for one line of sight between two places. */
const MOST_ROWS = 4000;

/** The kinds of seeing that go by a line of sight, which a mirror can turn. */
const BY_SIGHT = ['basicSight', 'lightPerception'];

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

/**
 * The outline of what is seen from `behind` through the part of a mirror from `a` to `b`: the
 * area in front of the mirror that lines from `behind` through that part reach before a wall
 * stops them. A wall stops sight by what Foundry's Edge says of it, the way Foundry's own
 * views read it: not from the side a one-way wall does not act from, not when a proximity or
 * distance wall is within or beyond its threshold, and a limited wall only as the second in a
 * line.
 *
 * @param {{x: number, y: number}} behind where the lines start: the seer's place mirrored at the wall
 * @param {{x: number, y: number}} a one end of the part of the mirror
 * @param {{x: number, y: number}} b its other end
 * @param {object[]} walls `{ id, ax, ay, bx, by, sight, dir, threshold }`, the mirror among them:
 *   the walls that stand at the height the view is worked out at
 * @param {string} mirrorId the wall the mirror is on, which does not stop its own view
 * @param {number} reach how far a line is followed at most
 * @returns {number[]|null} the corners of the outline, x and y in turn; null when there is none
 */
export function viewThrough(behind, a, b, walls, mirrorId, reach) {
	const turnA = Math.atan2(a.y - behind.y, a.x - behind.x);
	let span = Math.atan2(b.y - behind.y, b.x - behind.x) - turnA;
	while (span > Math.PI) span -= 2 * Math.PI;
	while (span <= -Math.PI) span += 2 * Math.PI;
	if (Math.abs(span) < 1e-6) return null;
	// where a direction lies between the two ends of the part: 0 at a, 1 at b
	const share = (x, y) => {
		let turn = Math.atan2(y - behind.y, x - behind.x) - turnA;
		while (turn > Math.PI) turn -= 2 * Math.PI;
		while (turn <= -Math.PI) turn += 2 * Math.PI;
		return turn / span;
	};

	// the walls that can stop this view at all
	const stops = [];
	for (const wall of walls) {
		if (wall.id === mirrorId || !wall.sight) continue;
		const side = (wall.ay - behind.y) * (wall.bx - behind.x) - (wall.ax - behind.x) * (wall.by - behind.y);
		if (side === 0) continue;
		// Foundry's Edge#orientPoint, and a one-way wall does not act from the side it names
		if (wall.dir && wall.dir === (side < 0 ? 1 : 2)) continue;
		if (wall.sight >= PROXIMITY && wall.threshold > 0) {
			const wx = wall.bx - wall.ax;
			const wy = wall.by - wall.ay;
			const along = Math.min(1, Math.max(0, ((behind.x - wall.ax) * wx + (behind.y - wall.ay) * wy) / (wx * wx + wy * wy || 1)));
			const apart = Math.hypot(behind.x - wall.ax - wx * along, behind.y - wall.ay - wy * along);
			if (wall.sight === PROXIMITY ? apart < wall.threshold : apart > wall.threshold) continue;
		}
		stops.push(wall);
	}

	// the directions to follow: evenly across the part, and just to either side of every wall end
	const shares = [0, 1];
	const beside = BESIDE / Math.abs(span);
	const even = Math.max(1, Math.ceil(Math.abs(span) / FINE));
	for (let i = 1; i < even; i++) shares.push(i / even);
	for (const wall of stops) {
		for (const [x, y] of [[wall.ax, wall.ay], [wall.bx, wall.by]]) {
			const at = share(x, y);
			if (at > 0 && at < 1) shares.push(Math.max(0, at - beside), at, Math.min(1, at + beside));
		}
	}
	shares.sort((p, q) => p - q);

	const mx = b.x - a.x;
	const my = b.y - a.y;
	const near = [];
	const far = [];
	let last = -1;
	for (const at of shares) {
		if (at === last) continue;
		last = at;
		const turn = turnA + span * at;
		const dx = Math.cos(turn);
		const dy = Math.sin(turn);
		// where the line passes the mirror: the view starts there
		const through = cross(dx, dy, mx, my);
		if (through === 0) continue;
		const start = cross(a.x - behind.x, a.y - behind.y, mx, my) / through;
		let stop = reach;
		let firstLimited = Infinity;
		let secondLimited = Infinity;
		for (const wall of stops) {
			const wx = wall.bx - wall.ax;
			const wy = wall.by - wall.ay;
			const den = cross(dx, dy, wx, wy);
			if (den === 0) continue;
			const t = cross(wall.ax - behind.x, wall.ay - behind.y, wx, wy) / den;
			if (t <= start + 0.01 || t >= stop) continue;
			const s = cross(wall.ax - behind.x, wall.ay - behind.y, dx, dy) / den;
			if (s < 0 || s > 1) continue;
			if (wall.sight === LIMITED) {
				if (t < firstLimited) {
					secondLimited = firstLimited;
					firstLimited = t;
				} else if (t < secondLimited) secondLimited = t;
			} else stop = t;
		}
		stop = Math.min(stop, secondLimited);
		if (!(stop > start)) continue;
		near.push(behind.x + dx * start, behind.y + dy * start);
		far.push(behind.x + dx * stop, behind.y + dy * stop);
	}
	if (far.length < 4) return null;
	// along the mirror at the first line, out along the far ends, and back to the mirror at the last
	return [near[0], near[1], ...far, near[near.length - 2], near[near.length - 1]];
}

/**
 * True when sight gets from one place to another by way of mirrors, up to `chain` of them in a
 * row. For a row of mirrors there is one way the line of sight can take: the place looked from,
 * mirrored at each mirror of the row in turn, lies in a straight line with the place looked at
 * and with the point of the last mirror the line of sight comes off; from there back, each
 * point on a mirror lies in a line with the mirrored place of the mirrors before it. The way is
 * good when each of those points is on its mirror, on a face that mirrors and between the
 * mirror's bottom and its top, and nothing stops sight on any stretch of it. Along the way the
 * line climbs or falls evenly from the height it starts at to the height it ends at.
 *
 * @param {{x: number, y: number, z: number}} from the place looked from, z being its height
 * @param {{x: number, y: number, z: number}} to the place looked at
 * @param {object[]} walls as `stopped` of sight.mjs takes them, with `left` and `right` telling
 *   which faces mirror
 * @param {number} chain the most mirrors in a row
 * @param {object[]} [surfaces] the flat surfaces that stop sight, as `stopped` takes them
 * @returns {boolean}
 */
export function sightBetween(from, to, walls, chain, surfaces = []) {
	const mirrors = walls.filter((wall) => wall.sight && (wall.left || wall.right));
	if (!mirrors.length) return false;

	// the way by a row of mirrors, given the mirrored places: found from its end, then followed
	const good = (row) => {
		const points = [];
		let goal = to;
		for (let i = row.length - 1; i >= 0; i--) {
			const { mirror, image } = row[i];
			const dx = goal.x - image.x;
			const dy = goal.y - image.y;
			const wx = mirror.bx - mirror.ax;
			const wy = mirror.by - mirror.ay;
			const den = cross(dx, dy, wx, wy);
			if (den === 0) return false;
			const t = cross(mirror.ax - image.x, mirror.ay - image.y, wx, wy) / den;
			const s = cross(mirror.ax - image.x, mirror.ay - image.y, dx, dy) / den;
			if (t <= 0 || t >= 1 || s < 0 || s > 1) return false;
			goal = { x: image.x + dx * t, y: image.y + dy * t };
			points.unshift(goal);
		}
		// how high the line is at each turn: by how much of the way lies behind it
		const turns = [from, ...points, to];
		const behind = [0];
		for (let i = 1; i < turns.length; i++) behind.push(behind[i - 1] + Math.hypot(turns[i].x - turns[i - 1].x, turns[i].y - turns[i - 1].y));
		const whole = behind[behind.length - 1] || 1;
		const way = turns.map((turn, i) => ({ x: turn.x, y: turn.y, z: from.z + ((to.z - from.z) * behind[i]) / whole }));
		for (let i = 0; i < row.length; i++) {
			if (way[i + 1].z < row[i].mirror.bottom || way[i + 1].z > row[i].mirror.top) return false;
		}
		// the mirrors a stretch starts and ends on are not in its way
		for (let i = 0; i + 1 < way.length; i++) {
			if (stopped(way[i], way[i + 1], walls, surfaces, [row[i - 1]?.mirror.id, row[i]?.mirror.id])) return false;
		}
		return true;
	};

	let tried = 0;
	const look = (image, row) => {
		for (const mirror of mirrors) {
			if (mirror.id === row[row.length - 1]?.mirror.id) continue;
			if (++tried > MOST_ROWS) return false;
			// the mirror has to turn a mirroring face to where the line of sight comes from
			const side = (mirror.ay - image.y) * (mirror.bx - image.x) - (mirror.ax - image.x) * (mirror.by - image.y);
			if (side === 0 || !(side > 0 ? mirror.left : mirror.right)) continue;
			const wx = mirror.bx - mirror.ax;
			const wy = mirror.by - mirror.ay;
			const along = ((image.x - mirror.ax) * wx + (image.y - mirror.ay) * wy) / (wx * wx + wy * wy);
			const next = { x: 2 * (mirror.ax + wx * along) - image.x, y: 2 * (mirror.ay + wy * along) - image.y };
			const longer = [...row, { mirror, image: next }];
			if (good(longer)) return true;
			if (longer.length < chain && look(next, longer)) return true;
		}
		return false;
	};
	return look(from, []);
}

/**
 * The vision source class of a mirrored viewpoint, made from the class of the token's own
 * vision source. Its line of sight is the outline it is given in `outline`; the two shapes cut
 * from it are made as its class makes them.
 */
const classes = new Map();
function mirroredClass(Base) {
	if (!classes.has(Base)) {
		classes.set(Base, class MirroredVisionSource extends Base {
			/** Tells a viewpoint behind a mirror from a token's own vision source. */
			mirrored = true;

			/** The corners of the line of sight, x and y in turn; set before the source is initialized. */
			outline = [];

			/** @override */
			_createShapes() {
				this._updateVisionMode();
				// a polygon of the class Foundry's views are of, with all a view carries but its points
				const Polygon = this._getPolygonBackend();
				const los = new Polygon();
				los.initialize(this.origin, this._getPolygonConfiguration());
				los.points = [...this.outline];
				los.bounds = los.getBounds();
				this.los = los;
				this.light = this._createLightPolygon();
				this.shape = this._createRestrictedPolygon();
			}
		});
	}
	return classes.get(Base);
}

export class MirrorVision {
	/** @param {Obstacles} obstacles the walls and surfaces of the scene (sight.mjs) */
	constructor(obstacles) {
		this.#obstacles = obstacles;
	}

	#obstacles;

	/** The mirrored viewpoints in use, by a key of token, walls and parts of the walls: `{ source }`. */
	#views = new Map();

	/** What the viewpoints of a token's vision source were made from, by the id of that source. */
	#made = new Map();

	/** True once a failure was reported, so that one that repeats every frame is reported once. */
	#failed = false;

	/** How many mirrored viewpoints there are right now. */
	get count() {
		return this.#views.size;
	}

	/** To be called when a wall or a surface was added, changed or removed, after the obstacles were told. */
	wallsChanged() {
		if (canvas.ready) canvas.perception?.update({ refreshVision: true });
	}

	/**
	 * Brings the mirrored viewpoints up to date with the tokens that see and with the walls. To
	 * be called before Foundry draws its lighting and its vision mask anew; when it finds
	 * something to change, it asks Foundry to draw both, in case Foundry was not about to or
	 * has just done so.
	 */
	keepUp() {
		try {
			const changed = this.#update();
			if (changed && canvas.ready) canvas.perception?.update({ refreshVision: true, refreshLighting: true });
		} catch (error) {
			this.#report(error);
		}
	}

	/** Takes the mirrored viewpoints away, and with them what they added to Foundry's test. */
	tearDown() {
		// destroying a vision source also takes it from those of the canvas
		for (const { source } of this.#views.values()) source.destroy?.();
		this.#views = new Map();
		this.#made = new Map();
	}

	/**
	 * True when sight gets from one place to one of some others by way of mirrors. Mirrors
	 * count while the light is path traced, as they do for what tokens see.
	 * @param {{x: number, y: number, z: number}} from z being the height, in scene pixels
	 * @param {{x: number, y: number, z: number}[]} places
	 */
	seesBetween(from, places) {
		if (!value('lights') || !canvas.walls) return false;
		try {
			const { walls, surfaces } = this.#obstacles;
			const chain = value('mirrorChain');
			return places.some((to) => sightBetween(from, to, walls, chain, surfaces));
		} catch (error) {
			this.#report(error);
			return false;
		}
	}

	#report(error) {
		if (this.#failed) return;
		this.#failed = true;
		console.error('cover-quadtree-view: looking into mirrors failed', error);
	}

	/**
	 * The parts of a mirror a vision source sees: `[from, to]` each, as shares of the way from
	 * the wall's first end to its second. Empty when the source faces a side that does not
	 * mirror, or sees nothing of it. The source is a token's own, or a viewpoint behind another
	 * mirror, whose view is what that mirror shows.
	 */
	#windows(seer, mirror) {
		const o = seer.origin ?? seer.data;
		const dx = mirror.bx - mirror.ax;
		const dy = mirror.by - mirror.ay;
		// Foundry's Edge#orientPoint: above 0 is its "right", from where the wall's left face is seen
		const side = (mirror.ay - o.y) * (mirror.bx - o.x) - (mirror.ax - o.x) * (mirror.by - o.y);
		if (side === 0 || !(side > 0 ? mirror.left : mirror.right)) return [];
		const length = Math.hypot(dx, dy);
		const pieces = Math.min(64, Math.max(6, Math.ceil(length / STEP)));
		const windows = [];
		let open = null;
		for (let i = 0; i < pieces; i++) {
			const at = { x: mirror.ax + (dx * (i + 0.5)) / pieces, y: mirror.ay + (dy * (i + 0.5)) / pieces };
			const far = Math.hypot(o.x - at.x, o.y - at.y) || 1;
			const seen = seer.los.contains(at.x + ((o.x - at.x) / far) * OFF, at.y + ((o.y - at.y) / far) * OFF);
			if (seen) {
				open ??= [i / pieces, 0];
				open[1] = (i + 1) / pieces;
			} else if (open) {
				windows.push(open);
				open = null;
			}
		}
		if (open) windows.push(open);
		return windows;
	}

	/**
	 * Makes, or sets up again, the viewpoint in one part of a mirror: of a token's vision source
	 * `real`, as seen by `seer`, which is that source itself or a viewpoint of it behind another
	 * mirror.
	 * @returns {object|null} the vision source of the viewpoint, or null where it sees nothing
	 */
	#view(real, seer, mirror, [from, to], walls, key, old) {
		const o = seer.origin ?? seer.data;
		const dx = mirror.bx - mirror.ax;
		const dy = mirror.by - mirror.ay;
		const along = ((o.x - mirror.ax) * dx + (o.y - mirror.ay) * dy) / (dx * dx + dy * dy);
		// the seer's place mirrored at the wall
		const behind = { x: Math.round(2 * (mirror.ax + dx * along) - o.x), y: Math.round(2 * (mirror.ay + dy * along) - o.y) };
		const a = { x: mirror.ax + dx * from, y: mirror.ay + dy * from };
		const b = { x: mirror.ax + dx * to, y: mirror.ay + dy * to };
		const reach = (canvas.dimensions.maxR ?? Math.hypot(canvas.dimensions.rect.width, canvas.dimensions.rect.height)) * 8;
		const outline = viewThrough(behind, a, b, walls, mirror.id, reach);
		if (!outline) return null;

		const Source = mirroredClass(real.constructor);
		const source = old instanceof Source ? old : new Source({ sourceId: key, object: real.object });
		if (old && old !== source) old.destroy?.();
		source.outline = outline;
		Object.assign(source.blinded, real.blinded);
		// all round: the outline is what narrows this view, and the token's own body is not there
		source.initialize({ ...real.data, x: behind.x, y: behind.y, angle: 360, externalRadius: 0, preview: false, disabled: false });
		if (!(source.los?.points?.length >= 6)) {
			source.destroy?.();
			return null;
		}
		// among the vision sources of the canvas, as a token's own is after it was set up
		source.add();
		return source;
	}

	/**
	 * Brings the viewpoints up to date with the vision sources of the canvas and the walls.
	 * @returns {boolean} true when a viewpoint was made, set up again or taken away
	 */
	#update() {
		const wanted = new Map();
		const made = new Map();
		let changed = false;
		// the viewpoints are among the vision sources themselves, and are not tokens' own
		const reals = value('lights') ? [...(canvas.effects?.visionSources ?? [])].filter((source) => !source.mirrored) : [];
		const all = reals.length ? this.#obstacles.walls : [];
		const anyMirror = all.some((wall) => wall.sight && (wall.left || wall.right));
		const chain = value('mirrorChain');
		for (const real of anyMirror ? reals : []) {
			if (!real.active || real.isBlinded || !real.los || !real.object) continue;
			// the view is worked out level, at the height the token looks from
			const eye = tokenHeights(real.object).eye;
			const stamp = `${real.updateId}|${this.#obstacles.count}|${chain}|${eye}`;
			const before = this.#made.get(real.sourceId);
			if (before?.stamp === stamp) {
				// nothing has changed for this source: its viewpoints stay as they are
				for (const key of before.keys) wanted.set(key, this.#views.get(key));
				made.set(real.sourceId, before);
				continue;
			}
			changed = true;
			const walls = all.filter((wall) => eye >= wall.bottom && eye <= wall.top);
			const mirrors = walls.filter((wall) => wall.sight && (wall.left || wall.right));
			const keys = [];
			// the viewpoints of everything `seer` sees mirrored, and of what those see, `row` mirrors deep
			const look = (seer, name, row, through) => {
				for (const mirror of mirrors) {
					// a viewpoint is behind the mirror it looks through, and does not see itself in it
					if (mirror.id === through) continue;
					this.#windows(seer, mirror).forEach((window, number) => {
						if (keys.length >= MOST) return;
						const key = `${name}.${mirror.id}.${number}`;
						const source = this.#view(real, seer, mirror, window, walls, key, this.#views.get(key)?.source);
						if (!source) return;
						wanted.set(key, { source });
						keys.push(key);
						if (row < chain) look(source, key, row + 1, mirror.id);
					});
				}
			};
			look(real, `${real.sourceId}.mirror`, 1, null);
			made.set(real.sourceId, { stamp, keys });
		}
		for (const [key, view] of this.#views) {
			if (wanted.get(key)?.source === view.source) continue;
			view.source.destroy?.();
			changed = true;
		}
		this.#views = wanted;
		this.#made = made;
		return changed;
	}

	/**
	 * True when one of the mirrored viewpoints sees a place by sight or by light perception.
	 * This is the part of CanvasVisibility#testVisibility that asks the vision sources, asked
	 * of the viewpoints; the arguments are that function's.
	 */
	sees(visibility, points, options) {
		if (!this.#views.size) return false;
		try {
			return this.#asks(visibility, points, options);
		} catch (error) {
			this.#report(error);
			return false;
		}
	}

	#asks(visibility, points, options) {
		const config = visibility._createVisibilityTestConfig(Array.isArray(points) ? points : [points], options);
		const modes = CONFIG.Canvas.detectionModes;
		for (const { source } of this.#views.values()) {
			if (source.isBlinded) continue;
			const token = source.object?.document;
			for (const id of BY_SIGHT) {
				const mode = token?.detectionModes?.[id];
				if (mode && modes[id]?.testVisibility(source, mode, config) === true) return true;
			}
		}
		return false;
	}
}
