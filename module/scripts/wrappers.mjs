// Every place where this module changes what a function of Foundry, or of another module,
// answers. All of them are made through libWrapper (github.com/ruipin/fvtt-lib-wrapper), which
// puts the wrappers of all modules on one function in a row and reports the ones that get in
// each other's way. A wrapper here always asks the function it wraps first and then adds to
// its answer from what this module knows; the one exception says so.
//
// Foundry itself:
//  - EffectsCanvasGroup#testInsideLight, "is this place in light": also yes where the path
//    traced light counts as lit. The light perception of tokens goes by it.
//  - CanvasVisibility#testVisibility, "can this place, or this token, be seen": also yes when a
//    token sees it in a mirror (see mirrors.mjs for why Foundry does not always find that out
//    by itself), and when a token sees another over or under the walls between them (see
//    sight.mjs: Foundry's views are flat shapes, which a wall cuts off whatever stands behind it).
//
// PF2E Visioner (github.com/roileaf/pf2e-visioner), where it is active. Visioner works out, for
// every pair of tokens, how well the one perceives the other and what cover it has from it,
// and it does so from three answers of its own, each of which gets a wrapper:
//  - LightingCalculator#getLightLevelAt, how bright a place is (darkness, dim or bright): never
//    darker than the path traced light makes the place. Magical darkness and a level set by a
//    rule element stay as Visioner has them.
//  - VisionAnalyzer#hasLineOfSight, whether one token has a line of sight to another: also yes
//    when it has one over or under the walls between them, or by way of mirrors.
//  - CoverDetector#_estimateWallCoveragePercent, how much of a target walls hide from a place,
//    which Visioner turns into no, standard or greater cover by its own thresholds: the answer
//    of this module's cover test (the walls that stop movement, see layer.mjs). This is the one
//    wrapper that puts its answer in place of Visioner's, which is asked only while this
//    module has none. Visioner asks with the middle of the attacking token and no word of the
//    token itself, but the cover test looks from several places across the attacker, as the
//    view of this module shows it, and a look from the middle alone hides more. So
//    CoverDetector#_detectBetweenTokensCore, which works on one attacker and one target at a
//    time, gets a wrapper that only notes whose turn it is, and the answer is the one the view
//    shows for that pair.
// The three objects are Visioner's own, one of each for the whole module. They are not within
// reach of a path from the global scope, which is what libWrapper goes by, so they are fetched
// from Visioner's script files and hung up under `coverQuadtreeView.visioner` for it.

import { LAYER, MODULE_ID, value } from './settings.mjs';

/** PF2E Visioner, and where its three objects come from: the file, and how the file hands the object out. */
const VISIONER = 'pf2e-visioner';
const PARTS = {
	lighting: ['scripts/visibility/auto-visibility/LightingCalculator.js', (file) => file.LightingCalculator.getInstance()],
	vision: ['scripts/visibility/auto-visibility/VisionAnalyzer.js', (file) => file.VisionAnalyzer.getInstance()],
	cover: ['scripts/cover/auto-cover/CoverDetector.js', (file) => file.default],
};

/** Visioner's names and numbers for how bright a place is, darkest first. */
const LEVELS = ['darkness', 'dim', 'bright'];
const THRESHOLDS = [0, 0.5, 1];

const layer = () => canvas?.[LAYER] ?? null;

/** What of PF2E Visioner asks this module, once `wrapVisioner` has run: some of 'light', 'sight' and 'cover'. */
let hooked = [];
export const visionerHooks = () => hooked;

/** Registers one wrapper, and says so in the console when it cannot be. */
function wrap(target, fn, type = 'WRAPPER') {
	try {
		libWrapper.register(MODULE_ID, target, fn, type);
		return true;
	} catch (error) {
		console.error(`${MODULE_ID}: could not wrap ${target}`, error);
		return false;
	}
}

/** True when libWrapper is there; tells the GM once when it is not. */
function available() {
	if (globalThis.libWrapper) return true;
	if (game.user?.isGM) ui.notifications?.error(game.i18n.localize('COVERQV.NoLibWrapper'), { permanent: true });
	return false;
}

/**
 * The wrappers on Foundry's own functions. To be called once, in the setup hook: by then a
 * system has put its own classes into CONFIG.Canvas.groups, and the wrappers go on those.
 */
export function wrapFoundry() {
	if (!available()) return;
	wrap('CONFIG.Canvas.groups.effects.groupClass.prototype.testInsideLight', function (wrapped, point, options = {}) {
		if (wrapped(point, options)) return true;
		// A caller that asks about some light sources only (options.condition) gets Foundry's
		// answer alone: reflected light is from no one source.
		if (typeof options !== 'object' || options?.condition) return false;
		return layer()?.isLit(point) ?? false;
	});
	wrap('CONFIG.Canvas.groups.visibility.groupClass.prototype.testVisibility', function (wrapped, points, options = {}) {
		if (wrapped(points, options)) return true;
		const view = layer();
		return Boolean(view && (view.seenInMirrors(this, points, options) || view.seenOver(points, options)));
	});
}

/**
 * The wrappers on PF2E Visioner. To be called once, in the ready hook, when Visioner has set
 * itself up. Does nothing where Visioner is not active.
 */
export async function wrapVisioner() {
	if (!game.modules.get(VISIONER)?.active || !globalThis.libWrapper) return;
	const parts = {};
	for (const [name, [file, pick]] of Object.entries(PARTS)) {
		try {
			// the address Visioner's own scripts load the file by, so that it is the same file
			parts[name] = pick(await import(new URL(`../../${VISIONER}/${file}`, import.meta.url).href));
		} catch (error) {
			console.error(`${MODULE_ID}: could not get at PF2E Visioner's ${name} (${file})`, error);
		}
	}
	globalThis.coverQuadtreeView = { ...globalThis.coverQuadtreeView, visioner: parts };
	hooked = [];

	if (parts.lighting && wrap('coverQuadtreeView.visioner.lighting.getLightLevelAt', function (wrapped, position, token) {
		const result = wrapped(position, token);
		if (!value('visionerLight') || !result) return result;
		// darkness that is someone's doing is not lit up by light thrown about
		if (result.modified || result.isDarknessSource || result.magicalDarkness || result.greaterMagicalDarkness) return result;
		const point = position ?? token?.center;
		const traced = point ? layer()?.lightLevelAt(point) : null;
		if (traced === null || traced === undefined || !(traced > (result.illumination ?? 0))) return result;
		return { ...result, level: LEVELS[traced], illumination: traced, lightIllumination: THRESHOLDS[traced], pathTraced: true };
	})) hooked.push('light');

	if (parts.vision && wrap('coverQuadtreeView.visioner.vision.hasLineOfSight', function (wrapped, observer, target) {
		const seen = wrapped(observer, target);
		// `undefined` is Visioner's "lines of sight are switched off"
		if (seen !== false || !value('visionerSight')) return seen;
		const view = layer();
		return view && (view.seesOver(observer, target) || view.seesByMirrors(observer, target)) ? true : seen;
	})) hooked.push('sight');

	// the attackers Visioner is working on, innermost last
	const attackers = [];
	if (parts.cover) {
		wrap('coverQuadtreeView.visioner.cover._detectBetweenTokensCore', function (wrapped, attacker, ...more) {
			attackers.push(attacker);
			try {
				return wrapped(attacker, ...more);
			} finally {
				attackers.pop();
			}
		});
	}
	if (parts.cover && wrap('coverQuadtreeView.visioner.cover._estimateWallCoveragePercent', function (wrapped, from, target, ...more) {
		const share = value('visionerCover') ? layer()?.coverShare(from, target, attackers[attackers.length - 1]) : null;
		return share === null || share === undefined ? wrapped(from, target, ...more) : share * 100;
	}, 'MIXED')) hooked.push('cover');

	console.log(`${MODULE_ID}: hooked into PF2E Visioner: ${hooked.join(', ') || 'nothing'}`);
	// cover needs the script library, which the layer loads when it hears of this
	layer()?.visionerHooked();
	refreshVisioner();
}

/**
 * Has PF2E Visioner work everything out again: what it knows of light, sight and cover is kept,
 * and what this module tells it has changed. Does nothing where Visioner is not there, and for
 * anyone but a GM, who is the one Visioner works for.
 */
export const refreshVisioner = foundry.utils.debounce(() => {
	if (!game.user?.isGM || !globalThis.coverQuadtreeView?.visioner) return;
	const system = globalThis.pf2eVisioner?.services?.autoVisibilitySystem;
	try {
		system?.clearLightCache?.();
		system?.recalculateAllVisibility?.();
	} catch (error) {
		console.warn(`${MODULE_ID}: PF2E Visioner would not work things out again`, error);
	}
}, 300);
