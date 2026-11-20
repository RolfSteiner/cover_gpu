// The path traced light of the scene's light sources, drawn where Foundry draws its own light.
//
// Foundry lights a scene in canvas.effects (an EffectsCanvasGroup; the pf2e system uses the same
// group and adds to it). Its illumination layer is multiplied onto the scene: a baseline, which
// is the color an unlit place keeps (canvas.colors.background, by the scene's darkness level),
// and over it one mesh per light source that raises the color up to canvas.colors.bright. The
// colors of the lights and what they change about the background are two more layers.
//
// With path tracing switched on, the meshes of the point light sources are taken out of those
// three layers and one picture is put into the illumination layer in their place: the script's
// picture of the light, added to the baseline, black for no light up to canvas.colors.bright
// for the brightest.
//
// A light source with an animation (a torch that flickers, a light that pulses) is the one
// exception. Its animation is in its meshes: Foundry moves them a little every frame, which a
// picture that is traced when the lighting changes cannot follow. So such a source keeps its
// meshes, and Foundry draws the light that comes straight from it, animated as ever; the
// picture holds of it only what the walls throw back, which stays still.
//
// Everything else stays Foundry's and works as before: the baseline and the
// scene's global light, darkness sources, what tokens with vision add, the masking of what a
// token cannot see, fog of war, and what the pf2e system changes for darkvision.
//
// What a token can see goes by where there is light, and Foundry knows that from the shapes of
// its light sources, which hold the light that comes straight from a source only. The light the
// walls throw back is added to it in the two places Foundry asks:
//  - the vision mask (canvas.visibility.vision.light, the areas "visible because of light
//    sources"): a second picture goes in there, filled where the traced light counts as lit;
//  - canvas.effects.testInsideLight, which the light perception of tokens goes by (the pf2e
//    system's too): it also says yes for a place that picture has filled (`isLit`; the wrapper
//    on Foundry's function is in wrappers.mjs).
// A place counts as lit when its traced light looks at least as bright as the setting
// `litLevel` says, in shares of how bright dim light looks.
//
// The Foundry types named here are the ones of the pf2e system's declarations
// (github.com/foundryvtt/pf2e, types/foundry): EffectsCanvasGroup in
// client/canvas/groups/effects.d.mts, CanvasIlluminationEffects in
// client/canvas/layers/effects/illumination-effects.d.mts, PointLightSource and its data in
// client/canvas/sources.

import { value } from './settings.mjs';

/** The layers of canvas.effects a light source has a mesh in. */
const MESHES = ['background', 'illumination', 'coloration'];

/** How long the lighting has to stay as it is before the picture is drawn in full, in ms. */
const SETTLE = 250;

const errorText = (error) => (error && error.message ? error.message : String(error));

/** A color of Foundry's (`[r, g, b]` from 0 to 1) less another, as the number PIXI tints with. */
function difference(top, bottom) {
	const part = (i) => Math.round(255 * Math.min(Math.max(top[i] - bottom[i], 0), 1));
	return (part(0) << 16) | (part(1) << 8) | part(2);
}

export class PathTracedLighting {
	/** @param {() => void} onTraced called after a picture was drawn or taken away */
	constructor(onTraced) {
		this.#onTraced = onTraced;
	}

	#onTraced;

	/** The script library, the walls as the JSON text it reads, and the bounds of their root cell. */
	#cover = null;

	#treeJson = '';

	#root = null;

	/** The sprite that shows the script's canvas, and the texture made for the size of the picture. */
	#sprite = null;

	#texture = null;

	/** What the picture was traced from, as text: it is traced again when this changes. */
	#inputs = '';

	/** `{ count, walls, ms, error, traced, draft }` of the last picture, or null while switched off. */
	#info = null;

	/** True while a look at the light sources is waiting for the next frame. */
	#queued = false;

	/** When the lighting last changed, and the timer of the full picture that follows a quick one. */
	#changedAt = -Infinity;

	#settling = null;

	/** True while the picture stands in for the meshes of Foundry's light sources. */
	#placed = false;

	/**
	 * Where the traced light counts as lit, or null while there is no picture:
	 * `{ width, height, lit, canvas, context, texture, sprite }`. `lit` holds per pixel of the
	 * picture, top row first, how bright the place is: 0 not lit, 1 as dim light, 2 as bright
	 * light. The canvas is filled where a place is lit, for the sprite that goes into Foundry's
	 * vision mask.
	 */
	#mask = null;

	/** True while the lit places are in Foundry's vision mask. */
	#inVision = false;

	/** What the last picture was made of, for a label; null while path tracing is switched off. */
	get info() {
		return this.#info;
	}

	/**
	 * Takes the library and the walls to trace on, and traces anew.
	 * @param {object} cover the script library (lib/test_local_gpu_api.js)
	 * @param {string} treeJson the walls, as quadtreeJson gives them
	 * @param {{x: number, y: number, width: number, height: number}} root what the picture covers
	 */
	setWalls(cover, treeJson, root) {
		this.#cover = cover;
		this.#treeJson = treeJson;
		this.#root = root;
		this.#read(true);
	}

	/**
	 * To be called whenever Foundry has set up or drawn its lighting anew. Foundry has put the
	 * meshes of its light sources back then, so the picture takes their place again at once;
	 * whether the picture is still right is looked at once, before the next frame.
	 */
	changed() {
		this.#place();
		if (this.#queued || !this.#cover) return;
		this.#queued = true;
		requestAnimationFrame(() => {
			this.#queued = false;
			if (this.#read()) this.#onTraced();
		});
	}

	/** To be called whenever Foundry has drawn its vision mask anew: it may have made the mask's parts anew as well. */
	visionChanged() {
		this.#placeVision();
	}

	/**
	 * True when the traced light at a place of the scene counts as lit. False while there is no
	 * picture.
	 * @param {{x: number, y: number}} point
	 */
	isLit(point) {
		const mask = this.#mask;
		if (!mask || !this.#info?.traced || !this.#root) return false;
		const x = Math.floor(((point.x - this.#root.x) / this.#root.width) * mask.width);
		const y = Math.floor(((point.y - this.#root.y) / this.#root.height) * mask.height);
		if (x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.lit[y * mask.width + x] > 0) return true;
		// the light that comes straight from an animated source is not in the picture
		return this.#sources().some((source) => source.isAnimated && source.shape?.contains?.(point.x, point.y));
	}

	/**
	 * How bright the traced light makes a place of the scene: 0 not lit, 1 as dim light, 2 as
	 * bright light; null while there is no picture. The light that comes straight from an
	 * animated source is not in the picture, and so not in this.
	 * @param {{x: number, y: number}} point
	 * @returns {0|1|2|null}
	 */
	lightLevelAt(point) {
		const mask = this.#mask;
		if (!mask || !this.#info?.traced || !this.#root) return null;
		const x = Math.floor(((point.x - this.#root.x) / this.#root.width) * mask.width);
		const y = Math.floor(((point.y - this.#root.y) / this.#root.height) * mask.height);
		if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
		return mask.lit[y * mask.width + x];
	}

	/** Follows a change of a switch or a number the picture depends on. */
	optionChanged() {
		if (this.#read(true)) this.#onTraced();
	}

	/** Hands the lighting back to Foundry and frees the picture; `setWalls` starts it again. */
	tearDown() {
		clearTimeout(this.#settling);
		this.#info = null;
		this.#inputs = '';
		this.#cover = null;
		this.#place();
		this.#sprite?.destroy();
		this.#sprite = null;
		this.#texture?.destroy(true);
		this.#texture = null;
		// Foundry destroys its vision mask with everything in it when it takes a scene down,
		// which may have been before this
		if (this.#mask?.sprite && !this.#mask.sprite.destroyed) this.#mask.sprite.destroy({ texture: true, baseTexture: true });
		this.#mask = null;
	}

	/**
	 * The point light sources Foundry lights the viewed level with: ambient lights and the lights
	 * tokens carry (PointLightSource). The scene's global light has no place or reach, and is
	 * left to Foundry.
	 * @returns {PointLightSource[]}
	 */
	#sources() {
		const sources = [];
		for (const source of canvas.effects?.lightSources ?? []) {
			if (!source.active || !(source.data.radius > 0)) continue;
			// the walls are those of the viewed level, so a light of another level is left out
			if (source.level?.isView === false) continue;
			sources.push(source);
		}
		return sources;
	}

	/** A light source as the script takes it. */
	#describe(source) {
		const data = source.data;
		// the opacity of a light's color says how much of the color its light has
		const strength = Math.min(Math.max(data.alpha ?? 0.5, 0), 1);
		const color = source.colorRGB ? Array.from(source.colorRGB, (c) => 1 + (c - 1) * strength) : [1, 1, 1];
		return { x: data.x, y: data.y, radius: data.radius, bright: Math.min(Math.abs(data.bright ?? 0), data.radius), color,
			walls: data.walls !== false, angle: data.angle ?? 360, rotation: data.rotation ?? 0, attenuation: data.attenuation ?? 0.5,
			externalRadius: data.externalRadius ?? 0,
			// an animated source keeps its own meshes for the light that comes straight from it
			reflectedOnly: Boolean(source.isAnimated),
			// how far dim light is on the way from unlit to bright, as Foundry weighs it
			dimLevel: canvas.environment?.weights?.dim ?? CONFIG.Canvas.lightLevels?.dim ?? 0.25 };
	}

	/**
	 * Path traces the light of the light sources as they are now, when anything the picture
	 * depends on has changed, or when `anyway` is set. Lighting that keeps changing (a token
	 * with a torch on its way, a light being dragged) gets a quick picture each time, smaller
	 * and of fewer paths, and the full picture once it has come to rest.
	 * @returns {boolean} true when a picture was drawn, or path tracing was switched off
	 */
	#read(anyway = false) {
		if (!this.#cover || !this.#treeJson) return false;
		const sources = value('lights') ? this.#sources().map((source) => this.#describe(source)) : null;
		const width = value('pictureWidth');
		const picture = { width, height: Math.max(1, Math.round((width * this.#root.height) / this.#root.width)),
			samples: value('samples'), bounces: value('bounces'), smoothing: value('smoothing'),
			wallHeight: value('wallHeight') * (canvas.dimensions?.size ?? 100), antialias: value('antialias') };
		const inputs = sources ? JSON.stringify([sources, picture, value('litLevel')]) : '';
		if (!anyway && inputs === this.#inputs) return false;
		this.#inputs = inputs;
		clearTimeout(this.#settling);
		const now = performance.now();
		const hurried = now - this.#changedAt < SETTLE;
		this.#changedAt = now;
		if (!sources) {
			this.#info = null;
			this.#place();
			return true;
		}
		if (hurried && !anyway) {
			const half = Math.max(64, Math.round(picture.width / 2));
			this.#trace(sources, { ...picture, width: half, height: Math.max(1, Math.round((half * this.#root.height) / this.#root.width)),
				samples: Math.max(8, Math.round(picture.samples / 4)), smoothing: Math.max(0, picture.smoothing - 1),
				antialias: Math.min(2, picture.antialias) }, true);
			this.#settling = setTimeout(() => {
				this.#trace(sources, picture, false);
				this.#onTraced();
			}, SETTLE);
		} else this.#trace(sources, picture, false);
		return true;
	}

	#trace(sources, picture, draft) {
		const info = { count: sources.length, walls: 0, ms: 0, error: '', traced: false, draft };
		const started = performance.now();
		try {
			info.walls = this.#cover.traceLights(this.#treeJson, sources, picture).walls;
			info.traced = true;
		} catch (error) {
			info.error = errorText(error);
		}
		info.ms = performance.now() - started;
		this.#info = info;
		if (info.traced) {
			this.#show();
			this.#readLit(sources);
		}
		this.#place();
		// what tokens can see has changed with the light
		if (canvas.ready) canvas.perception?.update({ refreshVision: true });
	}

	/**
	 * Works out from the picture the script has just drawn where its light counts as lit, and
	 * fills the picture for the vision mask there. Foundry draws its vision mask in red.
	 */
	#readLit(sources) {
		const { width, height, data } = this.#cover.readPicture();
		// how bright dim light looks in the picture, and the share of it that counts as lit
		const dimLevel = sources[0]?.dimLevel ?? 0.25;
		const least = Math.max(1, Math.round(255 * dimLevel * value('litLevel')));
		// half way from how bright dim light looks to how bright bright light does
		const bright = Math.round(255 * (dimLevel + 1) / 2);
		let mask = this.#mask;
		if (!mask || mask.width !== width || mask.height !== height) {
			const made = document.createElement('canvas');
			made.width = width;
			made.height = height;
			mask = this.#mask = { width, height, lit: new Uint8Array(width * height), canvas: made,
				context: made.getContext('2d'), texture: mask?.texture ?? null, sprite: mask?.sprite ?? null };
		}
		const image = mask.context.createImageData(width, height);
		for (let y = 0; y < height; y++) {
			// the script's picture comes bottom row first
			let from = (height - 1 - y) * width * 4;
			let to = y * width;
			for (let x = 0; x < width; x++, from += 4, to++) {
				const most = Math.max(data[from], data[from + 1], data[from + 2]);
				const lit = most >= least;
				mask.lit[to] = most >= bright ? 2 : (lit ? 1 : 0);
				if (lit) {
					image.data[to * 4] = 255;
					image.data[to * 4 + 3] = 255;
				}
			}
		}
		mask.context.putImageData(image, 0, 0);
		this.#maskSprite();
		mask.texture.baseTexture.update();
	}

	/**
	 * The sprite that shows the canvas of `#mask`. It is made anew when the size of the picture
	 * has changed, for which a texture is made, and when Foundry has destroyed it: Foundry
	 * destroys its vision mask with everything in it when it makes the mask anew.
	 */
	#maskSprite() {
		const mask = this.#mask;
		const alive = mask.sprite && !mask.sprite.destroyed ? mask.sprite : null;
		const base = alive ? mask.texture?.baseTexture : null;
		if (base && base.realWidth === mask.width && base.realHeight === mask.height) return alive;
		const texture = new PIXI.Texture(new PIXI.BaseTexture(mask.canvas, { scaleMode: PIXI.SCALE_MODES.LINEAR }));
		mask.sprite = alive ?? new PIXI.Sprite(texture);
		mask.sprite.texture = texture;
		if (alive) mask.texture?.destroy(true);
		mask.texture = texture;
		return mask.sprite;
	}

	/** Makes the sprite show what the script has just drawn on its canvas. */
	#show() {
		const canvasElement = this.#cover.canvas;
		const base = this.#texture?.baseTexture;
		// a texture is made for one size of picture
		if (!base || base.realWidth !== canvasElement.width || base.realHeight !== canvasElement.height) {
			const texture = new PIXI.Texture(new PIXI.BaseTexture(canvasElement, { scaleMode: PIXI.SCALE_MODES.LINEAR }));
			this.#sprite ??= new PIXI.Sprite(texture);
			this.#sprite.texture = texture;
			this.#texture?.destroy(true);
			this.#texture = texture;
		} else base.update();
	}

	/**
	 * Puts the picture into Foundry's illumination layer in place of the meshes of the point
	 * light sources, or, when there is no picture to show, hands the lighting back to Foundry.
	 * Foundry puts all its meshes back each time it draws its lighting anew, so this runs after
	 * each such time (see `changed`).
	 */
	#place() {
		this.#placeVision();
		const lights = canvas.effects?.illumination?.lights;
		const place = Boolean(lights && this.#sprite && this.#info?.traced && this.#root);
		// noted first: asking Foundry for its lighting comes straight back here
		const placed = this.#placed;
		this.#placed = place;
		if (place) {
			for (const source of this.#sources()) {
				if (source.isAnimated) continue;
				for (const name of MESHES) {
					const mesh = source.layers?.[name]?.mesh;
					mesh?.parent?.removeChild(mesh);
				}
			}
			const sprite = this.#sprite;
			// Added to the baseline, the picture takes a place from the color Foundry leaves an
			// unlit place (black in the picture) up to the color of its bright light (white).
			sprite.blendMode = PIXI.BLEND_MODES.ADD;
			sprite.tint = difference(canvas.colors?.bright?.rgb ?? [1, 1, 1], canvas.colors?.background?.rgb ?? [0, 0, 0]);
			sprite.position.set(this.#root.x, this.#root.y);
			sprite.width = this.#root.width;
			sprite.height = this.#root.height;
			sprite.zIndex = 1e9;
			if (sprite.parent !== lights) lights.addChild(sprite);
		} else {
			this.#sprite?.parent?.removeChild(this.#sprite);
			// Foundry puts the meshes of its light sources back when it draws its lighting anew
			if (placed && canvas.ready) canvas.perception?.update({ refreshLighting: true });
		}
	}

	/**
	 * Puts the picture of where the traced light counts as lit into Foundry's vision mask, next
	 * to the shapes of the light sources, and takes it out again when there is no picture to go
	 * by. (That such places also count as lit when Foundry tests one is the wrapper on
	 * testInsideLight in wrappers.mjs, which asks `isLit`.)
	 */
	#placeVision() {
		const light = canvas.visibility?.vision?.light;
		const mask = this.#mask;
		const place = Boolean(mask && this.#info?.traced && this.#root);
		if (place && light) {
			const sprite = this.#maskSprite();
			// as the shapes of the light sources in there: the most of what is there and this
			sprite.blendMode = PIXI.BLEND_MODES.MAX_COLOR ?? PIXI.BLEND_MODES.NORMAL;
			sprite.position.set(this.#root.x, this.#root.y);
			sprite.width = this.#root.width;
			sprite.height = this.#root.height;
			if (sprite.parent !== light) {
				light.addChild(sprite);
				if (canvas.masks?.vision) canvas.masks.vision.renderDirty = true;
			}
		} else if (mask?.sprite && !mask.sprite.destroyed && mask.sprite.parent) {
			mask.sprite.parent.removeChild(mask.sprite);
			if (canvas.masks?.vision) canvas.masks.vision.renderDirty = true;
		}
		// what tokens perceive by light has changed when the lit places came or went
		if (this.#inVision && !place && canvas.ready) canvas.perception?.update({ refreshVision: true });
		this.#inVision = place;
	}
}
