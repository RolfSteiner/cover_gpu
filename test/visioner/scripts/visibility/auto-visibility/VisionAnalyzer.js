// PF2E Visioner's vision analyzer as far as the module uses it.
export class VisionAnalyzer {
	static #instance = null;
	static getInstance() { return (VisionAnalyzer.#instance ??= new VisionAnalyzer()); }
	hasLineOfSight(observer, target) { return visionerStub.lineOfSight; }
	canSee(observer, target) { return this.hasLineOfSight(observer, target); }
}
