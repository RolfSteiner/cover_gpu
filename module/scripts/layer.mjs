// The view, drawn on the canvas of the scene. It works on the walls of the scene as they sit in
// game.canvas.walls.quadtree, and every calculation is done by the GPU build of the script
// (../lib/test_local_gpu_api.js):
//  - rays: what a ray crosses (bounding boxes and walls);
//  - a cover test: how much of every other token the walls hide from the selected token;
//  - the light of the scene's own light sources, path traced by the script. That is not drawn
//    here but where Foundry draws its own lighting (see lighting.mjs), and for every user;
//    this layer loads the library and the walls for it and labels it. With it goes what
//    tokens see in walls that are mirrors (see mirrors.mjs).
//
// The walls come with what Foundry's Edge says about each of them (see quadtree.mjs). The
// cover test counts the walls that stop movement only, and the path traced light follows what
// each wall does to light. Rays work on every wall, whatever it does.
//
// All of it happens in a scene that has height (see heights.mjs): a wall stands between its
// bottom and its top, a token from its feet to its head, and the surfaces of regions are floors
// and roofs. The cover test looks from the height the selected token looks from at the whole
// height of each other token; a ray of the view lies level on the floor of the viewed level.
//
// The scene can be looked at from the side: the switch "isometric" turns the whole canvas, map
// and tokens and lighting with it, so that what lies to the right on the map runs up to the
// right on the screen and what lies below runs down to the right (`#applyPerspective`). Every
// height then has a direction on the screen, straight up, and the view draws what it knows the
// height of standing: the walls from their bottom to their top, the floors and roofs where
// they lie, the tokens of the cover test from feet to head, and each traced light at its
// height.
//
// The view itself is for the GM. It is shown whichever set of scene controls is active, and its
// marks can be dragged there too: each mark takes the mouse for itself before the active layer
// sees it. Only placing a new ray needs the tool of the view's own controls. Results that were
// tables in the page this replaces are short labels next to the things here.

import { floorHeight, perUnit, surfaceList, tokenHeights } from './heights.mjs';
import { loadLibrary } from './library.mjs';
import { PathTracedLighting } from './lighting.mjs';
import { MirrorVision } from './mirrors.mjs';
import { quadtreeJson } from './quadtree.mjs';
import { LAYER, NUMBERS, value, setValue } from './settings.mjs';
import { Obstacles } from './sight.mjs';
import { refreshVisioner, visionerHooks } from './wrappers.mjs';

const { InteractionLayer } = foundry.canvas.layers;

// one color per ray number, repeating after eight
const SERIES = [0x3987e5, 0xd95926, 0x199e70, 0xc98500, 0xd55181, 0x0ca30c, 0x9085e9, 0xe66767];
const INK = 0xf0efec;
const MUTED = 0xc3c2b7;
const CELL = 0x8d8c86;
const DARK = 0x1a1a19;
const LIGHT = 0xffc440;
const BLOCKED = 0xe66767;
const MIRROR = 0x8fd3ff;

// How far around its centre a mark takes the mouse, in pixels on screen.
const REACH = 14;

// By how much the canvas is turned for the isometric view: its x axis runs this far up from
// level on the screen, its y axis as far down.
const TILT = Math.PI / 6;
const FLOOR = 0x8fd3ff;

const wallKey = (ax, ay, bx, by) => [ax, ay, bx, by].join(',');
const distance = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const errorText = (error) => (error && error.message ? error.message : String(error));

/** A color part of the way from one to another, each as the number PIXI takes. */
function between(from, to, share) {
	const part = (shift) => Math.round(((from >> shift) & 255) + (((to >> shift) & 255) - ((from >> shift) & 255)) * share);
	return (part(16) << 16) | (part(8) << 8) | part(0);
}

export class CoverViewLayer extends InteractionLayer {
	/** @inheritDoc */
	static get layerOptions() {
		return foundry.utils.mergeObject(super.layerOptions, { name: LAYER, zIndex: 950 });
	}

	/**
	 * The layer's set of scene controls: the tool that places rays, switches, and two buttons.
	 * @override
	 */
	static prepareSceneControls() {
		let order = 0;
		const tool = (name, icon, more = {}) => [name, { name, title: `COVERQV.Tool.${name}`, icon, order: order++, ...more }];
		const toggle = (name, icon) => tool(name, icon, { toggle: true, active: value(name), onChange: (_event, active) => setValue(name, active) });
		return {
			name: LAYER,
			order: 20,
			title: 'COVERQV.Control',
			layer: LAYER,
			icon: 'fa-solid fa-lightbulb',
			visible: game.user.isGM,
			onChange: (_event, active) => {
				if (active) canvas[LAYER].activate();
			},
			tools: Object.fromEntries([
				// not called "select": the canvas reads a tool of that name as "drag a selection box"
				tool('move', 'fa-solid fa-arrows-up-down-left-right'),
				tool('ray', 'fa-solid fa-arrow-right-long'),
				toggle('show', 'fa-solid fa-display'),
				toggle('cover', 'fa-solid fa-shield-halved'),
				toggle('lights', 'fa-solid fa-sun'),
				toggle('cells', 'fa-solid fa-border-all'),
				toggle('isometric', 'fa-solid fa-cube'),
				tool('settings', 'fa-solid fa-sliders', { button: true, onChange: () => canvas[LAYER].editSettings() }),
				tool('clear', 'fa-solid fa-trash', { button: true, onChange: () => canvas[LAYER].clear() }),
			]),
			activeTool: 'move',
		};
	}

	/** The script library, once it is loaded. */
	#cover = null;

	/** The pending or finished load of the library. */
	#loading = null;

	/** The tree all results were calculated on, as the JSON text the script reads. */
	#treeJson = '';

	/**
	 * The scene as a whole, as the path traced light takes it: that tree with the walls of the
	 * levels that are not viewed, and the surfaces of every level.
	 */
	#lightJson = '';

	/** The bounds of the root cell of that tree. */
	#root = null;

	/** Every cell of the tree: `{ bounds, depth }`. */
	#cells = [];

	/**
	 * Every wall of the tree once, by its key: `{ key, a, b, r, mirror, bottom, top }`, the last
	 * two being the heights it stands between, in scene pixels, where it names them.
	 */
	#walls = new Map();

	/** The flat surfaces of the scene, as `surfaceList` gives them. */
	#surfaces = [];

	/** The scene the placed things belong to. */
	#scene = null;

	/** `{ number, a, b, boxes, walls, error }`; boxes and walls map a wall key to a count. */
	#rays = [];

	/** The path traced light of the scene's light sources. PF2E Visioner goes by it where it is hooked in. */
	#lighting = new PathTracedLighting(() => {
		this.#redraw();
		refreshVisioner();
	});

	/** The answers `coverShare` has given on the walls as they are, by what was asked. */
	#shares = new Map();

	/** What can be in the way of a line of sight: the walls with their heights, and floors and roofs. */
	#obstacles = new Obstacles();

	/** What tokens see in walls that are mirrors. */
	#mirrors = new MirrorVision(this.#obstacles);

	/** True once a failure of `seenOver` was reported, so that one that repeats is reported once. */
	#sightFailed = false;

	/**
	 * The cover test of the selected token, or null while none is selected:
	 * `{ name, s, bottom, eye, ds, top, targets: [{ id, name, p, bottom, head, da, top, result }], ms, error }`.
	 * `eye` is the height the source looks from, `bottom` and `head` the heights a token stands
	 * between, in scene pixels; `top` is how far above its middle a label goes, on the map.
	 */
	#coverTest = null;

	/** What the cover test was calculated from, as text: it is calculated again when this changes. */
	#coverInputs = '';

	/** True while a look at the tokens is waiting for the next frame. */
	#tokensQueued = false;

	/** What Delete removes: the thing of a mark of the selected ray, `{ kind, ray }`. */
	#selected = null;

	/** What is being dragged: the thing, and where the mouse last was. */
	#held = null;

	/** The display objects of the layer, by what they show. */
	#parts = null;

	/** The labels in use, by a key that says what they belong to. */
	#labels = new Map();

	/** The marks in use, the same way. */
	#marks = new Map();

	/** The zoom everything was last drawn for. */
	#drawnZoom = 0;

	/* -------------------------------------------- */
	/*  Drawing and the tree                        */
	/* -------------------------------------------- */

	/** @override */
	async _draw(options) {
		await super._draw(options);
		const scene = canvas.scene?.id ?? null;
		if (scene !== this.#scene) {
			// what was placed on one scene means nothing on another
			this.#scene = scene;
			this.#rays = [];
			this.#selected = null;
		}
		this.#coverTest = null;
		this.#coverInputs = '';
		const add = (child) => this.addChild(child);
		const parts = {
			cells: add(new PIXI.Graphics()),
			walls: add(new PIXI.Graphics()),
			cover: add(new PIXI.Graphics()),
			rays: add(new PIXI.Graphics()),
			marks: add(new PIXI.Container()),
			labels: add(new PIXI.Container()),
		};
		this.#parts = parts;
		this.#labels = new Map();
		this.#marks = new Map();
		this.#held = null;
		// everything has to be drawn again, even on an unchanged tree
		this.#treeJson = '';
		this.#lightJson = '';
		// ahead of Foundry's perception update, which runs at the priority Foundry names PERCEPTION
		const perception = PIXI.UPDATE_PRIORITY.PERCEPTION ?? PIXI.UPDATE_PRIORITY.NORMAL + 2;
		canvas.app?.ticker?.remove(this.#beforePerception, this);
		canvas.app?.ticker?.add(this.#beforePerception, this, perception + 0.5);
		this.#applyPerspective();
		this.#showOrHide();
	}

	/** @override */
	async _tearDown(options) {
		canvas.app?.ticker?.remove(this.#beforePerception, this);
		this.#lighting.tearDown();
		this.#mirrors.tearDown();
		this.#parts = null;
		this.#labels = new Map();
		this.#marks = new Map();
		this.#held = null;
		return super._tearDown(options);
	}

	/** @override */
	_activate() {
		this.#showOrHide();
	}

	/** @override */
	_deactivate() {
		// An inactive layer hands no mouse events to its children. This one does, so that its
		// marks can be dragged while another set of scene controls is active.
		this.interactiveChildren = true;
		this.#showOrHide();
	}

	/**
	 * Shows the view to a GM while it is switched on or its own controls are active. The script
	 * library is loaded the first time the view is shown, or the path traced light is wanted,
	 * which may be for any user.
	 */
	#showOrHide() {
		this.visible = game.user.isGM && (value('show') || this.active);
		// PF2E Visioner's cover asks the script library, whether or not anything of the view is shown
		if (!this.visible && !value('lights') && !visionerHooks().includes('cover')) return;
		this.#load().then(() => {
			this.refreshTree();
			// a view that was hidden has not followed the tokens
			this.#readTokens();
			this.#redraw();
		});
	}

	#load() {
		this.#loading ??= loadLibrary()
			.then((cover) => {
				this.#cover = cover;
			})
			.catch((error) => {
				console.error(error);
				ui.notifications.error(game.i18n.format('COVERQV.LoadFailed', { error: errorText(error) }), { permanent: true });
			});
		return this.#loading;
	}

	/**
	 * Takes the walls as they are in the quadtree now. Does nothing while the tree is the one
	 * the results were calculated on; otherwise everything is calculated and drawn again.
	 */
	refreshTree() {
		if (!this.#cover || !this.#parts || !canvas.scene || !canvas.walls?.quadtree) return;
		const json = quadtreeJson(canvas.walls.quadtree, surfaceList());
		// Light gets everywhere. Foundry has only the walls of the viewed level on the canvas; the
		// others are read from the scene, and each wall ends where its levels end.
		const elsewhere = [...(canvas.scene.walls ?? [])].filter((document) => document.viewed === false);
		const lightJson = quadtreeJson(canvas.walls.quadtree, surfaceList(true), { others: elsewhere, withinLevels: true });
		if (json === this.#treeJson && lightJson === this.#lightJson) return;
		const tree = JSON.parse(json);
		const root = tree.nodes[tree.root].bounds;
		if (!(root.width > 0 && root.height > 0)) return;
		this.#treeJson = json;
		this.#lightJson = lightJson;
		this.#surfaces = tree.surfaces ?? [];
		this.#root = root;
		this.#shares.clear();
		this.#cells = [];
		this.#walls = new Map();
		const walk = (index, depth) => {
			const node = tree.nodes[index];
			this.#cells.push({ bounds: node.bounds, depth });
			for (const o of node.objects) {
				const key = wallKey(o.t.a.x, o.t.a.y, o.t.b.x, o.t.b.y);
				const mirror = (o.w.metallicLeft >= 0.99 && o.w.smoothnessLeft >= 0.99) || (o.w.metallicRight >= 0.99 && o.w.smoothnessRight >= 0.99);
				if (!this.#walls.has(key)) this.#walls.set(key, { key, a: o.t.a, b: o.t.b, r: o.r, mirror, bottom: o.w.bottom, top: o.w.top });
			}
			for (const child of node.nodes) walk(child, depth + 1);
		};
		walk(tree.root, 0);
		for (const ray of this.#rays) this.#runRay(ray);
		this.#readTokens(true);
		this.#lighting.setWalls(this.#cover, lightJson, root);
		this.#redraw();
	}

	/**
	 * Turns the canvas for the isometric view, or back. The stage is turned and sheared, which
	 * together lay its two axes a third of a right angle up and down from level, at their full
	 * length. Foundry keeps to the place and the zoom of the stage and leaves the rest alone.
	 * @returns {boolean} true when the canvas was turned
	 */
	#applyPerspective() {
		const stage = canvas.stage;
		if (!stage) return false;
		const tilt = value('isometric') ? TILT : 0;
		if (stage.rotation === -tilt && stage.skew.x === tilt) return false;
		stage.rotation = -tilt;
		stage.skew.set(tilt, 0);
		if (canvas.ready) {
			// Foundry draws what it keeps of the scene on the screen anew, and puts the HUD in place
			canvas.pan?.();
			canvas.perception?.update({ refreshLighting: true, refreshVision: true });
		}
		return true;
	}

	/**
	 * How the scene lies on the screen, but for the zoom: a step of (x, y) on the scene is a step
	 * of (a x + c y, b x + d y) on the screen. `up` is the step on the scene that is one unit
	 * straight up on the screen, which is where a height of 1 goes in the isometric view (and
	 * what "above" a place means for a label in either view); `across` is the direction on the
	 * scene that runs farthest to the right on the screen.
	 */
	get #lie() {
		const tilt = value('isometric') ? TILT : 0;
		const a = Math.cos(tilt);
		const b = -Math.sin(tilt);
		const c = Math.sin(2 * tilt);
		const d = Math.cos(2 * tilt);
		const det = a * d - b * c;
		const wide = Math.hypot(a, c);
		return { a, b, c, d, det, up: { x: c / det, y: -a / det }, across: { x: a / wide, y: c / wide } };
	}

	/** True once there is a tree to calculate on. */
	get #usable() {
		return Boolean(this.#cover && this.#parts && this.#treeJson);
	}

	/* -------------------------------------------- */
	/*  Calculations                                */
	/* -------------------------------------------- */

	/** How often each wall appears in a list the script returns (once per cell that stores it). */
	#countByWall(hits) {
		const counts = new Map();
		for (const hit of hits) {
			const o = hit.t.origin;
			const key = wallKey(o.x, o.y, o.x + hit.t.dir.x, o.y + hit.t.dir.y);
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		return counts;
	}

	#runRay(ray) {
		ray.error = '';
		let result = { boxHits: [], wallHits: [] };
		try {
			// level, on the floor of the viewed level: it meets the walls that stand there
			const z = floorHeight();
			result = this.#cover.test(this.#treeJson, [ray.a.x, ray.a.y, z], [ray.b.x, ray.b.y, z]);
		} catch (error) {
			ray.error = errorText(error);
		}
		ray.boxes = this.#countByWall(result.boxHits);
		ray.walls = this.#countByWall(result.wallHits);
	}

	/* -------------------------------------------- */
	/*  The cover test of the selected token        */
	/* -------------------------------------------- */

	/**
	 * To be called whenever a token may have been selected, moved, resized, added or removed.
	 * Such news comes many times a frame; the tokens are looked at once, before the next frame.
	 */
	tokensChanged() {
		if (this.#tokensQueued || !this.#usable) return;
		this.#tokensQueued = true;
		requestAnimationFrame(() => {
			this.#tokensQueued = false;
			if (this.#readTokens()) this.#redraw();
		});
	}

	/**
	 * Sets up the cover test from the tokens as they are now: the selected token (the first, if
	 * several are) is the source, every other token of the scene a target. A token counts as a
	 * circle around its centre, as wide as the token unless a diameter is set for all of them,
	 * that stands from the token's feet to its head; the source looks from the height the token
	 * looks from. Calculates the test when anything it depends on has changed, or when `anyway`
	 * is set.
	 * @returns {boolean} true when the test was calculated again
	 */
	#readTokens(anyway = false) {
		if (!this.#usable) return false;
		// nothing is tested for a hidden view
		const source = value('cover') && this.visible ? canvas.tokens?.controlled[0] : null;
		let test = null;
		if (source) {
			const describe = (token, diameter) => {
				// while a token is dragged, its preview is where it is being dragged to
				const shown = token._preview ?? token;
				const centre = shown.center;
				const size = Math.min(token.w, token.h);
				const heights = tokenHeights(shown);
				return { id: token.id, name: token.document.name, p: { x: Math.round(centre.x), y: Math.round(centre.y) },
					bottom: Math.round(heights.bottom), head: Math.round(heights.top), eye: Math.round(heights.eye),
					diameter: value(diameter) > 0 ? value(diameter) : size, top: Math.max(token.h, value(diameter)) / 2 };
			};
			const s = describe(source, 'sourceDiameter');
			test = { name: s.name, s: s.p, bottom: s.bottom, eye: s.eye, ds: s.diameter, top: s.top, targets: [], ms: 0, error: '' };
			for (const token of canvas.tokens.placeables) {
				if (token === source || token.isPreview) continue;
				const t = describe(token, 'targetDiameter');
				test.targets.push({ id: t.id, name: t.name, p: t.p, bottom: t.bottom, head: t.head, da: t.diameter, top: t.top, result: null });
			}
		}
		const inputs = test ? JSON.stringify([test.s, test.eye, test.ds, value('points'), value('heights'),
			test.targets.map((target) => [target.id, target.p, target.bottom, target.head, target.da])]) : '';
		if (!anyway && inputs === this.#coverInputs) return false;
		this.#coverInputs = inputs;
		this.#coverTest = test;
		if (test) this.#runCoverTest();
		return true;
	}

	/** The script takes one diameter for all targets of a call, so targets of one size share a call. */
	#runCoverTest() {
		const test = this.#coverTest;
		const bySize = new Map();
		for (const target of test.targets) {
			if (!bySize.has(target.da)) bySize.set(target.da, []);
			bySize.get(target.da).push(target);
		}
		const started = performance.now();
		try {
			for (const [da, targets] of bySize) {
				const results = this.#cover.testCover(this.#treeJson, [test.s.x, test.s.y, test.eye], targets.map((target) => [target.p.x, target.p.y, target.bottom, target.head]),
					test.ds, da, value('points'), value('heights'));
				targets.forEach((target, order) => {
					target.result = results[order];
				});
			}
		} catch (error) {
			test.error = errorText(error);
		}
		test.ms = performance.now() - started;
	}

	/* -------------------------------------------- */
	/*  The light of the scene's light sources      */
	/* -------------------------------------------- */

	/** To be called whenever Foundry has set up or drawn its lighting anew. */
	lightsChanged() {
		this.#lighting.changed();
		this.#mirrors.keepUp();
	}

	/**
	 * Called every frame, just before Foundry draws its lighting and its vision mask anew where
	 * it has to: what tokens see in mirrors is looked over first, so that Foundry draws from it.
	 */
	#beforePerception() {
		this.#mirrors.keepUp();
	}

	/**
	 * To be called whenever Foundry has drawn its vision mask anew, while it is still drawing it.
	 * @param {CanvasVisibility} [visibility]
	 */
	visionChanged(visibility) {
		this.#lighting.visionChanged();
		this.#mirrors.keepUp();
	}

	/** To be called at once when a wall or a region was added, changed or removed. */
	wallsChanged() {
		this.#obstacles.changed();
		this.#mirrors.wallsChanged();
	}

	/** How many viewpoints behind mirrors the tokens that see have right now. */
	get mirrorViews() {
		return this.#mirrors.count;
	}

	/** True when the path traced light at a place of the scene counts as lit. */
	isLit(point) {
		return this.#lighting.isLit(point);
	}

	/** How bright the path traced light makes a place: 0, 1 (dim) or 2 (bright); null while it is not traced. */
	lightLevelAt(point) {
		return this.#lighting.lightLevelAt(point);
	}

	/** True when a token that sees, sees a place in a mirror; the arguments are those of CanvasVisibility#testVisibility. */
	seenInMirrors(visibility, points, options) {
		return this.#mirrors.sees(visibility, points, options);
	}

	/**
	 * Where one token looks from and the places of another it looks at, each `{ x, y, z }` with z
	 * the height in scene pixels: the middle of the other and four places half way out to its
	 * corners, each near its head and at half its height.
	 * @returns {{from: object, places: object[]}|null} null where a token has no place
	 */
	#looks(observer, target) {
		const from = observer?.center;
		const to = target?.center;
		if (!from || !to) return null;
		const w = (target.w ?? 0) / 4;
		const h = (target.h ?? 0) / 4;
		const body = tokenHeights(target);
		const places = [];
		for (const share of [0.9, 0.5]) {
			const z = body.bottom + (body.top - body.bottom) * share;
			places.push({ x: to.x, y: to.y, z }, { x: to.x - w, y: to.y - h, z }, { x: to.x + w, y: to.y - h, z }, { x: to.x + w, y: to.y + h, z }, { x: to.x - w, y: to.y + h, z });
		}
		return { from: { x: from.x, y: from.y, z: tokenHeights(observer).eye }, places };
	}

	/**
	 * True when one token has a line of sight to another by way of mirrors: from where it looks
	 * from to one of the places of the other `#looks` names.
	 * @param {Token} observer
	 * @param {Token} target
	 */
	seesByMirrors(observer, target) {
		const looks = this.#looks(observer, target);
		return looks ? this.#mirrors.seesBetween(looks.from, looks.places) : false;
	}

	/**
	 * True when one token has a straight line of sight to another through the room: no wall
	 * stands in it at the height the line has there, and no floor or roof lies across it. A
	 * token sees a taller one over a wall this way, which no flat view can show.
	 * @param {Token} observer
	 * @param {Token} target
	 */
	seesOver(observer, target) {
		const looks = this.#looks(observer, target);
		if (!looks) return false;
		try {
			return looks.places.some((place) => this.#obstacles.clear(looks.from, place));
		} catch (error) {
			console.error(error);
			return false;
		}
	}

	/**
	 * True when a token that sees has a straight line of sight through the room to a token
	 * Foundry found hidden; the arguments are those of CanvasVisibility#testVisibility. Foundry
	 * decides by the flat view of each token that sees, which a wall cuts off whatever stands
	 * behind it. Here the token's sight and its light perception are asked again (the detection
	 * modes of CONFIG.Canvas.detectionModes, so a system's own rules hold): what each says of
	 * the two tokens themselves, of the range and of the angle, and in place of the flat view
	 * the line from where the seeing token looks from to the other. Light perception also wants
	 * the other to stand in light. On a scene without heights the flat view is all there is, and
	 * this says no.
	 */
	seenOver(points, options) {
		const object = options?.object;
		if (object?.document?.documentName !== 'Token') return false;
		try {
			if (this.#obstacles.flat) return false;
			const modes = CONFIG.Canvas.detectionModes;
			const level = canvas.scene?.levels?.get?.(object.document.level) ?? canvas.level;
			const per = perUnit();
			for (const source of canvas.effects?.visionSources ?? []) {
				const seer = source.object;
				if (!source.active || source.mirrored || source.isBlinded || !seer?.document || seer === object) continue;
				const looks = this.#looks(seer, object);
				if (!looks) continue;
				for (const id of ['basicSight', 'lightPerception']) {
					const mode = seer.document.detectionModes?.[id];
					const asked = modes?.[id];
					if (!mode?.enabled || !asked || asked._canDetect?.(source, object, level) === false) continue;
					for (const place of looks.places) {
						const test = { point: { x: place.x, y: place.y, elevation: place.z / per }, level, los: new Map() };
						if (asked._testRange?.(source, mode, object, test) === false || asked._testAngle?.(source, mode, object, test) === false) continue;
						if (id === 'lightPerception' && !canvas.effects.testInsideLight(test.point)) continue;
						if (this.#obstacles.clear(looks.from, place)) return true;
					}
				}
			}
		} catch (error) {
			if (!this.#sightFailed) console.error('cover-quadtree-view: looking over walls failed', error);
			this.#sightFailed = true;
		}
		return false;
	}

	/**
	 * How much of a token the walls and surfaces that stop movement hide: the cover test of the
	 * script, as the view shows it for the selected token. The token looked at is a circle, as
	 * wide as the token unless a diameter is set for all targets, that stands from the token's
	 * feet to its head. With `source`, the token looked from, the look is from the places across
	 * that token the setting `points` asks for, at the height that token looks from, and the
	 * answer is that of the place with the best view; without, it is from the one place `from`,
	 * at the elevation it names, or else level with the head of the token looked at. Answers are
	 * kept while the walls stay as they are.
	 * @param {{x: number, y: number, elevation?: number}} from where the looking token's middle is
	 * @param {Token} token the token looked at
	 * @param {Token} [source] the token looked from
	 * @returns {number|null} the hidden share, 0 to 1; null while there is no answer to give
	 */
	coverShare(from, token, source = null) {
		const centre = token?.center;
		if (!this.#usable || !centre || !Number.isFinite(from?.x) || !Number.isFinite(from?.y)) return null;
		const diameter = value('targetDiameter') > 0 ? value('targetDiameter') : Math.min(token.w, token.h);
		if (!(diameter > 0)) return null;
		// as `#readTokens` sets the selected token up: a circle as wide as the token, at whole places
		const across = source ? (value('sourceDiameter') > 0 ? value('sourceDiameter') : Math.min(source.w ?? 0, source.h ?? 0) || 0) : 0;
		const points = across > 0 ? value('points') : 1;
		const body = tokenHeights(token);
		const eye = source ? tokenHeights(source).eye : (Number.isFinite(from.elevation) ? from.elevation * perUnit() : body.top);
		const s = [Math.round(from.x), Math.round(from.y), Math.round(eye)];
		const t = [Math.round(centre.x), Math.round(centre.y), Math.round(body.bottom), Math.round(body.top)];
		const key = [...s, ...t, diameter, across, points, value('heights')].join();
		if (!this.#shares.has(key)) {
			let share = null;
			try {
				share = this.#cover.testCover(this.#treeJson, s, [t], across, diameter, points, value('heights'))[0]?.obstructed ?? null;
			} catch (error) {
				console.error(error);
			}
			if (this.#shares.size > 4000) this.#shares.clear();
			this.#shares.set(key, share);
		}
		return this.#shares.get(key);
	}

	/** Told by wrappers.mjs that PF2E Visioner now asks this module (see `visionerHooks` there). */
	visionerHooked() {
		this.#showOrHide();
	}

	/* -------------------------------------------- */
	/*  Drawing                                     */
	/* -------------------------------------------- */

	/**
	 * One pixel on screen, in scene pixels. Lines, marks and labels are sized in it, so that
	 * they stay the same on screen at any zoom; `zoomChanged` draws them again after a zoom.
	 */
	get #unit() {
		return 1 / (canvas.stage?.scale.x || 1);
	}

	/** Called when the canvas was panned or zoomed. */
	zoomChanged() {
		if (this.visible && canvas.stage.scale.x !== this.#drawnZoom) this.#redraw();
	}

	/** Puts a label at a place, reusing the one that was there for the same thing. */
	#label(used, key, text, x, y) {
		const u = this.#unit;
		let label = this.#labels.get(key);
		if (!label) {
			// drawn at twice the size it is shown at, so that it stays sharp
			const style = CONFIG.canvasTextStyle.clone();
			style.fontSize = 28;
			style.strokeThickness = 4;
			label = this.#parts.labels.addChild(new foundry.canvas.containers.PreciseText(text, style));
			label.anchor.set(0.5, 1);
			this.#labels.set(key, label);
		}
		if (label.text !== text) label.text = text;
		// upright on the screen however the scene lies on it, a little above its place
		const { a, b, c, d, det, up } = this.#lie;
		const size = u / 2 / det;
		label.transform.setFromMatrix(new PIXI.Matrix(d * size, -b * size, -c * size, a * size, x + up.x * 10 * u, y + up.y * 10 * u));
		used.add(key);
	}

	/**
	 * A mark is a thing that can be dragged: it takes the mouse within `area`, whichever layer
	 * is active. `draw`, if given, draws it. The mark of a thing is kept from one drawing to
	 * the next, so that a drag goes on while everything is drawn again under it.
	 */
	#mark(used, key, thing, area, draw) {
		let mark = this.#marks.get(key);
		if (!mark) {
			mark = this.#parts.marks.addChild(new PIXI.Graphics());
			mark.eventMode = 'static';
			mark.cursor = 'grab';
			mark.on('pointerdown', (event) => this.#onMarkDown(event, mark));
			mark.on('globalpointermove', (event) => this.#onMarkMove(event, mark));
			mark.on('pointerup', () => this.#onMarkUp(mark));
			mark.on('pointerupoutside', () => this.#onMarkUp(mark));
			this.#marks.set(key, mark);
		}
		mark.thing = thing;
		mark.hitArea = area;
		mark.clear();
		draw?.(mark);
		used.add(key);
	}

	#redraw() {
		const parts = this.#parts;
		// nobody sees a hidden view, and for any user but the GM it is always hidden
		if (!parts || !this.#root || !this.visible) return;
		const u = this.#unit;
		this.#drawnZoom = canvas.stage.scale.x;
		const root = this.#root;
		const test = this.#coverTest;
		const lights = this.#lighting.info;
		const round = { cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND };
		const line = (g, a, b) => g.moveTo(a.x, a.y).lineTo(b.x, b.y);
		const dot = (g, p, radius, color, alpha = 1) => g.lineStyle(0).beginFill(color, alpha).drawCircle(p.x, p.y, radius).endFill();
		const labels = new Set();
		const marks = new Set();

		// --- the quadtree: its cells and the bounding boxes of the walls
		parts.cells.clear();
		if (value('cells')) {
			for (const cell of this.#cells) {
				parts.cells.lineStyle({ width: (cell.depth === 0 ? 2 : 1) * u, color: CELL, alpha: 0.7 })
					.drawRect(cell.bounds.x, cell.bounds.y, cell.bounds.width, cell.bounds.height);
			}
			parts.cells.lineStyle(0);
			for (const w of this.#walls.values()) {
				parts.cells.beginFill(INK, 0.06).drawRect(w.r.x, w.r.y, Math.max(w.r.width, u), Math.max(w.r.height, u)).endFill();
			}
		}

		// --- walls: a crossed bounding box is outlined in the ray's color, a crossed wall is
		// drawn in it
		parts.walls.clear();
		for (const w of this.#walls.values()) {
			const boxBy = this.#rays.filter((ray) => ray.boxes.has(w.key));
			const wallBy = this.#rays.filter((ray) => ray.walls.has(w.key));
			// one stroke per ray, widest first, so that a mark several rays reach shows them all
			boxBy.forEach((ray, order) => {
				parts.walls.lineStyle({ width: (2 + 4 * (boxBy.length - 1 - order)) * u, color: this.#color(ray), ...round })
					.drawRect(w.r.x, w.r.y, Math.max(w.r.width, u), Math.max(w.r.height, u));
			});
			if (wallBy.length) {
				wallBy.forEach((ray, order) => {
					parts.walls.lineStyle({ width: (4 + 4 * (wallBy.length - 1 - order)) * u, color: this.#color(ray), ...round });
					line(parts.walls, w.a, w.b);
				});
			} else {
				// a wall with a face that mirrors stands out
				parts.walls.lineStyle({ width: (w.mirror ? 3 : 2) * u, color: w.mirror ? MIRROR : MUTED, ...round });
				line(parts.walls, w.a, w.b);
			}
		}

		// --- the isometric view: what has a height stands. Walls are drawn from the back of the
		// screen to the front, so that the nearer ones lie over the farther.
		const isometric = value('isometric');
		const lie = this.#lie;
		const floor = floorHeight();
		const lifted = (p, z) => ({ x: p.x + lie.up.x * (z - floor), y: p.y + lie.up.y * (z - floor) });
		if (isometric) {
			parts.walls.lineStyle(0);
			for (const surface of this.#surfaces) {
				if (!(surface.z > floor)) continue;
				for (let i = 0; i + 5 < surface.t.length; i += 6) {
					const corners = [0, 2, 4].flatMap((k) => { const at = lifted({ x: surface.t[i + k], y: surface.t[i + k + 1] }, surface.z); return [at.x, at.y]; });
					parts.walls.beginFill(FLOOR, 0.16).drawPolygon(corners).endFill();
				}
			}
			// a wall without a top is drawn as high as it throws light back
			const tall = (value('wallHeight') || 2) * (canvas.dimensions?.size ?? 100);
			const depth = (w) => lie.b * (w.a.x + w.b.x) + lie.d * (w.a.y + w.b.y);
			for (const w of [...this.#walls.values()].sort((p, q) => depth(p) - depth(q))) {
				const bottom = Number.isFinite(w.bottom) ? w.bottom : floor;
				const open = !Number.isFinite(w.top);
				const top = open ? Math.max(bottom, floor) + tall : w.top;
				const corners = [lifted(w.a, bottom), lifted(w.b, bottom), lifted(w.b, top), lifted(w.a, top)].flatMap((at) => [at.x, at.y]);
				const color = w.mirror ? MIRROR : MUTED;
				parts.walls.lineStyle({ width: u, color, alpha: open ? 0.45 : 0.9, ...round }).beginFill(color, open ? 0.1 : 0.22).drawPolygon(corners).endFill();
			}
		}
		// a token as it stands: its circle again at a height, and its two sides as the screen shows them
		const standing = (g, p, radius, bottom, top) => {
			const head = lifted(p, top);
			g.drawCircle(head.x, head.y, radius);
			for (const side of [-1, 1]) {
				const edge = { x: p.x + lie.across.x * radius * side, y: p.y + lie.across.y * radius * side };
				line(g, lifted(edge, bottom), lifted(edge, top));
			}
		};

		// --- cover test: per target the diameter of the source used for it, and per point of
		// that diameter one triangle per run of rays, to where the run meets the target
		parts.cover.clear();
		if (test) {
			parts.cover.lineStyle({ width: 1.5 * u, color: INK }).drawCircle(test.s.x, test.s.y, test.ds / 2);
			if (isometric) {
				standing(parts.cover, test.s, test.ds / 2, test.bottom, test.eye);
				for (const target of test.targets) standing(parts.cover, target.p, target.da / 2, target.bottom, target.head);
			}
			const dots = [];
			for (const target of test.targets) {
				parts.cover.lineStyle({ width: 1.5 * u, color: INK }).drawCircle(target.p.x, target.p.y, target.da / 2);
				const result = target.result;
				if (!result) continue;
				for (const q of result.points) {
					parts.cover.lineStyle(0);
					for (const run of q.runs) {
						// from free to hidden, by how much of the target's height is hidden in this run
						const share = run.share ?? (run.blocked ? 1 : 0);
						parts.cover.beginFill(between(LIGHT, BLOCKED, share), 0.25 + 0.15 * share)
							.drawPolygon([q.at.x, q.at.y, run.from.x, run.from.y, run.to.x, run.to.y]).endFill();
					}
					if (q.rays) {
						parts.cover.lineStyle({ width: u, color: MUTED, alpha: 0.6 });
						for (const ray of [q.rayA, q.rayB]) line(parts.cover, ray.origin, { x: ray.origin.x + ray.dir.x, y: ray.origin.y + ray.dir.y });
					}
					dots.push(q.at);
				}
				parts.cover.lineStyle({ width: 2 * u, color: INK, ...round });
				line(parts.cover, result.lineA, result.lineB);
			}
			for (const at of dots) dot(parts.cover, at, 3 * u, INK);
			const sourceText = test.error
				? game.i18n.format('COVERQV.Label.Error', { error: test.error })
				: game.i18n.format('COVERQV.Label.Source', { name: test.name, targets: test.targets.length, ms: test.ms.toFixed(1) });
			this.#label(labels, 'source', sourceText, test.s.x, test.s.y - test.top);
			for (const target of test.targets) {
				const share = target.result ? (target.result.obstructed * 100).toFixed(1) + '%' : '?';
				this.#label(labels, 'target ' + target.id, game.i18n.format('COVERQV.Label.Target', { name: target.name, share }), target.p.x, target.p.y - target.top);
			}
		}

		// --- rays: dashed, solid while selected; the line of a ray can be dragged as well
		parts.rays.clear();
		const reach = REACH * u;
		for (const ray of this.#rays) {
			const picked = this.#selected?.ray === ray;
			parts.rays.lineStyle({ width: (picked ? 3 : 2) * u, color: this.#color(ray), ...round });
			if (picked) line(parts.rays, ray.a, ray.b);
			else this.#dashes(parts.rays, ray.a, ray.b, 7 * u, 5 * u);
			const length = distance(ray.a, ray.b) || 1;
			const across = { x: (-(ray.b.y - ray.a.y) / length) * reach * 0.6, y: ((ray.b.x - ray.a.x) / length) * reach * 0.6 };
			this.#mark(marks, `ray ${ray.number} line`, { kind: 'rayLine', ray }, new PIXI.Polygon([
				ray.a.x + across.x, ray.a.y + across.y, ray.b.x + across.x, ray.b.y + across.y,
				ray.b.x - across.x, ray.b.y - across.y, ray.a.x - across.x, ray.a.y - across.y]));
		}

		// --- the marks, drawn over everything, and their labels
		const ring = (g, p, radius, fill, edge, width) => g.lineStyle({ width: width * u, color: edge }).beginFill(fill).drawCircle(p.x, p.y, radius * u).endFill();
		for (const ray of this.#rays) {
			const picked = this.#selected?.ray === ray;
			for (const end of ['a', 'b']) {
				this.#mark(marks, `ray ${ray.number} ${end}`, { kind: 'rayEnd', ray, end }, new PIXI.Circle(ray[end].x, ray[end].y, reach),
					(g) => ring(g, ray[end], picked ? 7 : 6, this.#color(ray), DARK, 2));
			}
			const text = ray.error
				? game.i18n.format('COVERQV.Label.Error', { error: ray.error })
				: game.i18n.format('COVERQV.Label.Ray', { number: ray.number, walls: ray.walls.size, boxes: ray.boxes.size });
			this.#label(labels, 'ray ' + ray.number, text, ray.a.x + (ray.b.x - ray.a.x) * 0.62, ray.a.y + (ray.b.y - ray.a.y) * 0.62 + 6 * u);
		}
		if (lights && isometric && !lights.error) {
			// each traced light at its height, on a stem down to the floor under it
			for (const light of lights.lights ?? []) {
				const at = lifted(light, light.z);
				const [r, g, b] = (light.color ?? [1, 1, 1]).map((part) => Math.round(255 * Math.min(Math.max(part, 0), 1)));
				parts.rays.lineStyle({ width: u, color: LIGHT, alpha: 0.8 });
				line(parts.rays, light, at);
				dot(parts.rays, light, 2 * u, LIGHT, 0.8);
				parts.rays.lineStyle({ width: u, color: DARK }).beginFill((r << 16) | (g << 8) | b).drawCircle(at.x, at.y, 5 * u).endFill();
			}
		}
		if (lights) {
			const text = lights.error
				? game.i18n.format('COVERQV.Label.Error', { error: lights.error })
				: game.i18n.format(lights.draft ? 'COVERQV.Label.LightsDraft' : 'COVERQV.Label.Lights', { lights: lights.count, walls: lights.walls, ms: lights.ms.toFixed(1) });
			// inside the top edge of the scene, where the picture begins
			this.#label(labels, 'lights', text, root.x + root.width / 2, root.y + 44 * u);
		}
		for (const [key, label] of this.#labels) {
			if (labels.has(key)) continue;
			label.destroy();
			this.#labels.delete(key);
		}
		for (const [key, mark] of this.#marks) {
			if (marks.has(key)) continue;
			if (this.#held?.mark === mark) this.#held = null;
			mark.destroy();
			this.#marks.delete(key);
		}
	}

	#color(ray) {
		return SERIES[(ray.number - 1) % SERIES.length];
	}

	#dashes(g, a, b, dash, gap) {
		const length = distance(a, b);
		if (length === 0) return;
		const dx = (b.x - a.x) / length;
		const dy = (b.y - a.y) / length;
		for (let at = 0; at < length; at += dash + gap) {
			const end = Math.min(at + dash, length);
			g.moveTo(a.x + dx * at, a.y + dy * at).lineTo(a.x + dx * end, a.y + dy * end);
		}
	}

	/* -------------------------------------------- */
	/*  Moving and removing: the marks              */
	/* -------------------------------------------- */

	/** The place of a mouse event on the scene, in whole units. */
	#place(event, which = 'origin') {
		const p = event.interactionData?.[which] ?? event.getLocalPosition(canvas.stage);
		return { x: Math.round(p.x), y: Math.round(p.y) };
	}

	/**
	 * A mark was pressed. The event stops here, so that the active layer does not act on it
	 * as well: the left button picks the mark up, the right button removes its thing.
	 */
	#onMarkDown(event, mark) {
		event.stopPropagation();
		if (!this.#usable) return;
		if (event.button === 2) this.#remove(mark.thing);
		if (event.button !== 0) return;
		this.#selected = mark.thing;
		this.#held = { thing: mark.thing, mark, last: this.#place(event) };
		this.#redraw();
	}

	#onMarkMove(event, mark) {
		if (this.#held?.mark === mark) this.#moveHeld(this.#place(event));
	}

	#onMarkUp(mark) {
		if (this.#held?.mark === mark) this.#held = null;
	}

	/** Moves what is being dragged to p and calculates it again. */
	#moveHeld(p) {
		const held = this.#held;
		if (!held || !this.#usable || (p.x === held.last.x && p.y === held.last.y)) return;
		const { thing } = held;
		if (thing.kind === 'rayEnd') {
			thing.ray[thing.end] = p;
			this.#runRay(thing.ray);
		} else if (thing.kind === 'rayLine') {
			const dx = p.x - held.last.x;
			const dy = p.y - held.last.y;
			thing.ray.a = { x: thing.ray.a.x + dx, y: thing.ray.a.y + dy };
			thing.ray.b = { x: thing.ray.b.x + dx, y: thing.ray.b.y + dy };
			this.#runRay(thing.ray);
		}
		held.last = p;
		this.#redraw();
	}

	#addRay(a, b) {
		// a new ray takes the lowest number no ray uses, and the color that goes with it
		const used = new Set(this.#rays.map((ray) => ray.number));
		let number = 1;
		while (used.has(number)) number++;
		const ray = { number, a, b, boxes: new Map(), walls: new Map(), error: '' };
		this.#rays.push(ray);
		this.#runRay(ray);
		return ray;
	}

	/** Removes the ray the thing of a mark belongs to. */
	#remove(thing) {
		if (this.#rays.includes(thing.ray)) this.#rays.splice(this.#rays.indexOf(thing.ray), 1);
		this.#selected = null;
		this.#held = null;
		this.#redraw();
	}

	/** Removes every ray. The cover test follows the tokens and stays. */
	clear() {
		this.#rays = [];
		this.#selected = null;
		this.#held = null;
		this.#redraw();
	}

	/* -------------------------------------------- */
	/*  Placing: the ray tool of the view's controls */
	/* -------------------------------------------- */

	// These reach the layer only while its own controls are active, and only for a press on
	// the open map: a press on a mark stops at the mark.

	/** @override */
	_onClickLeft(event) {
		if (!this.#usable) return;
		// a click on the open map selects nothing
		this.#selected = null;
		this.#redraw();
	}

	/** @override */
	_onDragLeftStart(event) {
		if (!this.#usable) return;
		if (game.activeTool !== 'ray') return;
		// a drag on the open map draws a new ray, whose far end follows the mouse
		const p = this.#place(event);
		const thing = { kind: 'rayEnd', ray: this.#addRay(p, p), end: 'b', fresh: true };
		this.#selected = thing;
		this.#held = { thing, mark: null, last: p };
		this.#redraw();
	}

	/** @override */
	_onDragLeftMove(event) {
		if (this.#held && !this.#held.mark) this.#moveHeld(this.#place(event, 'destination'));
	}

	/** @override */
	_onDragLeftDrop(event) {
		const held = this.#held;
		if (!held || held.mark) return;
		this.#held = null;
		// a new ray that never got any length was a click, not a ray
		if (held.thing.fresh && distance(held.thing.ray.a, held.thing.ray.b) < 1) this.#remove(held.thing);
	}

	/** @override */
	_onDragLeftCancel(event) {
		this._onDragLeftDrop(event);
	}

	/** @override */
	_onDeleteKey(event) {
		if (!this.#selected || !this.#usable) return false;
		this.#remove(this.#selected);
		return true;
	}

	/* -------------------------------------------- */
	/*  Switches and numbers                        */
	/* -------------------------------------------- */

	/** Follows a change of one of the switches or numbers of settings.mjs. */
	optionChanged(key) {
		if (key === 'isometric') this.#applyPerspective();
		// either may be the first reason to load the library
		if (key === 'show' || (key === 'lights' && !this.#cover)) {
			this.#showOrHide();
			return;
		}
		if (!this.#usable) return;
		if (['lights', 'samples', 'bounces', 'smoothing', 'antialias', 'wallHeight', 'litLevel', 'pictureWidth'].includes(key)) this.#lighting.optionChanged();
		// the viewpoints behind mirrors are made anew as after a change of walls
		if (key === 'mirrorChain') this.#mirrors.wallsChanged();
		// PF2E Visioner goes by all of these where it is hooked in
		if (['lights', 'litLevel', 'mirrorChain', 'points', 'heights', 'sourceDiameter', 'targetDiameter', 'visionerLight', 'visionerSight', 'visionerCover'].includes(key)) refreshVisioner();
		if (['cover', 'points', 'heights', 'sourceDiameter', 'targetDiameter'].includes(key)) this.#readTokens(true);
		this.#redraw();
	}

	/** Asks for the numbers in a dialog and takes over the ones that are valid. */
	async editSettings() {
		const fields = Object.entries(NUMBERS).map(([key, { min, max, integer }]) => `
			<div class="form-group">
				<label for="cover-view-${key}">${game.i18n.localize(`COVERQV.Setting.${key}.Name`)}</label>
				<div class="form-fields">
					<input id="cover-view-${key}" type="number" name="${key}" value="${value(key)}" min="${min}" max="${max}" step="${integer ? 1 : 'any'}">
				</div>
				<p class="hint">${game.i18n.localize(`COVERQV.Setting.${key}.Hint`)}</p>
			</div>`);
		const entered = await foundry.applications.api.DialogV2.input({
			window: { title: 'COVERQV.SettingsTitle', icon: 'fa-solid fa-sliders' },
			content: fields.join(''),
			rejectClose: false,
		});
		if (!entered) return;
		for (const [key, { min, max, integer }] of Object.entries(NUMBERS)) {
			const number = Number(entered[key]);
			if (entered[key] === '' || entered[key] === null || !Number.isFinite(number) || number < min || number > max) continue;
			if (integer && !Number.isInteger(number)) continue;
			if (number !== value(key)) await setValue(key, number);
		}
	}
}
