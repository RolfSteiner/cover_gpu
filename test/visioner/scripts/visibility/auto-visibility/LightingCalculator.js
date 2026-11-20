// PF2E Visioner's lighting calculator as far as the module uses it: one object for all, and
// its answer to how bright a place is.
export class LightingCalculator {
	static #instance = null;
	static getInstance() { return (LightingCalculator.#instance ??= new LightingCalculator()); }
	getLightLevelAt(position, token) {
		const illumination = visionerStub.light;
		return { level: ['darkness', 'dim', 'bright'][illumination], illumination, lightIllumination: [0, 0.5, 1][illumination], ...(visionerStub.extras ?? {}) };
	}
	// as Visioner's own code calls it: on the object, by name
	levelFor(token) { return this.getLightLevelAt(token.center, token); }
}
