// What can be switched and set for the view. Everything is kept per browser (client scope),
// but whether the light is path traced and how high a wall without a top throws light back:
// that is the lighting of the scene, the same for every user, so it is kept with the world and
// only a GM can set it.
// The switches are the toggle tools of the view's scene controls; the numbers are edited in the
// dialog behind its "Settings" tool, and in Foundry's module settings.

export const MODULE_ID = 'cover-quadtree-view';

/** The name of the canvas layer, which is also the name of its set of scene controls. */
export const LAYER = 'coverView';

/** The switches, with what they start as. */
export const TOGGLES = { show: true, cover: true, lights: false, cells: true, isometric: false };

/** The switches that are kept with the world. */
const WORLD = ['lights'];

/**
 * What a wall says of its two faces in its flags of this module, each from 0 to 1, with what
 * holds while it says nothing. A face that is not metallic scatters the light it gets to all
 * sides, a metallic face mirrors it, and smoothness is how sharp the mirror is. The sides are
 * the ones the wall's direction names.
 */
export const SURFACE = { metallicLeft: 0, smoothnessLeft: 0, metallicRight: 0, smoothnessRight: 0 };

/** The numbers, with what they start as and what they may be. */
export const NUMBERS = {
	samples: { initial: 32, min: 1, max: 1024, integer: true },
	bounces: { initial: 2, min: 0, max: 16, integer: true },
	smoothing: { initial: 3, min: 0, max: 6, integer: true },
	antialias: { initial: 4, min: 1, max: 4, integer: true },
	// in grid squares, for walls that name no top; part of how the scene is lit, so it is kept
	// with the world
	wallHeight: { initial: 2, min: 0, max: 100, integer: false, world: true },
	// in shares of how bright dim light looks; part of what tokens see, so kept with the world
	litLevel: { initial: 0.5, min: 0.05, max: 1, integer: false, world: true },
	// how many mirrors a line of sight may take one after the other
	mirrorChain: { initial: 3, min: 1, max: 8, integer: true, world: true },
	pictureWidth: { initial: 1024, min: 64, max: 4096, integer: true },
	points: { initial: 5, min: 1, max: 200, integer: true },
	// at how many heights a target is looked at, from its feet to its head
	heights: { initial: 6, min: 1, max: 24, integer: true },
	// 0 stands for "as wide as the token"
	sourceDiameter: { initial: 0, min: 0, max: 100000, integer: false },
	targetDiameter: { initial: 0, min: 0, max: 100000, integer: false },
};

/**
 * What PF2E Visioner asks this module, where that module is active (see wrappers.mjs). Each can
 * be switched off; all are kept with the world.
 */
export const VISIONER = { visionerLight: true, visionerSight: true, visionerCover: true };

/** The value of a switch or a number. */
export const value = (key) => game.settings.get(MODULE_ID, key);

/** Sets a switch or a number; `onChange` of `registerSettings` hears of it. */
export const setValue = (key, to) => game.settings.set(MODULE_ID, key, to);

/**
 * Registers the switches and the numbers.
 * @param {(key: string) => void} onChange called with the name of whichever of them changed
 */
export function registerSettings(onChange) {
	const { BooleanField, NumberField } = foundry.data.fields;
	for (const [key, initial] of Object.entries(TOGGLES)) {
		game.settings.register(MODULE_ID, key, {
			scope: WORLD.includes(key) ? 'world' : 'client',
			config: false,
			type: new BooleanField({ initial }),
			default: initial,
			onChange: () => onChange(key),
		});
	}
	for (const [key, initial] of Object.entries(VISIONER)) {
		game.settings.register(MODULE_ID, key, {
			name: `COVERQV.Setting.${key}.Name`,
			hint: `COVERQV.Setting.${key}.Hint`,
			scope: 'world',
			config: true,
			type: new BooleanField({ initial }),
			default: initial,
			onChange: () => onChange(key),
		});
	}
	for (const [key, { initial, min, max, integer, world }] of Object.entries(NUMBERS)) {
		game.settings.register(MODULE_ID, key, {
			name: `COVERQV.Setting.${key}.Name`,
			hint: `COVERQV.Setting.${key}.Hint`,
			scope: world ? 'world' : 'client',
			config: true,
			type: new NumberField({ nullable: false, required: true, initial, min, max, integer }),
			default: initial,
			onChange: () => onChange(key),
		});
	}
}
