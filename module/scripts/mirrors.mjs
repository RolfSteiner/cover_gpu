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
// mirrored place. Its line of sight is worked out by the script library (`viewThrough` of
// src/sight.das), not by Foundry: after a mirror or two the mirrored place lies far outside the
// scene, and Foundry works out views from places inside it only. The outline found there is
// handed to the source as its `los` polygon, and Foundry's own functions cut from it the two
// other shapes a vision source has:
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
// about any two tokens, whether or not they are the ones a user sees with (`seesBetween`; the
// library's `byMirrors`). It needs no views: the place looked from is mirrored at each mirror
// of a row in turn, which gives the one way the line of sight can take by those mirrors, and
// that way is followed.
//
// All of that geometry is the library's. What is done here is what only Foundry can do or be
// told: asking a view of Foundry's whether it holds a place of a mirror, making the vision
// sources, and asking the detection modes.
//
// The scene has height (see heights.mjs), and a mirror is as high as its wall. A view is a flat
// shape, as all of Foundry's are, so it is worked out level, at the height the token looks
// from: with the walls that stand at that height, of which those with a mirroring face are its
// mirrors. This is how Wall Height has Foundry work out the token's own view. A single line of
// sight is followed through the room: a mirror stands upright, so the line
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

/** The most viewpoints one token is given, whatever the mirrors would allow. */
const MOST = 48;

/** The kinds of seeing that go by a line of sight, which a mirror can turn. */
const BY_SIGHT = ['basicSight', 'lightPerception'];

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
			return this.#obstacles.sees(from, places, value('mirrorChain'));
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
	 * Makes, or sets up again, a viewpoint behind a mirror: of a token's vision source `real`,
	 * at the place and with the outline the library worked out for one part of the mirror.
	 * @returns {object|null} the vision source of the viewpoint, or null where it sees nothing
	 */
	#view(real, { behind, outline }, key, old) {
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
		const chain = value('mirrorChain');
		for (const real of reals) {
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
			const mirrors = this.#obstacles.mirrorsAt(eye);
			const ids = this.#obstacles.ids;
			const reach = (canvas.dimensions.maxR ?? Math.hypot(canvas.dimensions.rect.width, canvas.dimensions.rect.height)) * 8;
			const keys = [];
			// the viewpoints of everything `seer` sees mirrored, and of what those see, `row` mirrors deep
			const look = (seer, name, row, through) => {
				for (const mirror of mirrors) {
					// a viewpoint is behind the mirror it looks through, and does not see itself in it
					if (mirror === through) continue;
					const origin = seer.origin ?? seer.data;
					// the places of the mirror the seer sees: those its view holds
					const seen = this.#obstacles.mirrorProbes(origin, mirror).map((at) => seer.los.contains(at.x, at.y));
					for (const view of this.#obstacles.mirrorViews(origin, mirror, seen, reach, eye)) {
						if (keys.length >= MOST) break;
						const key = `${name}.${ids[mirror]}.${view.number}`;
						const source = this.#view(real, view, key, this.#views.get(key)?.source);
						if (!source) continue;
						wanted.set(key, { source });
						keys.push(key);
						if (row < chain) look(source, key, row + 1, mirror);
					}
				}
			};
			look(real, `${real.sourceId}.mirror`, 1, null);
			if (keys.length) changed = true;
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
