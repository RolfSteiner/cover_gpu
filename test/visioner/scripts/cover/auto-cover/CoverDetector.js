// PF2E Visioner's cover detector as far as the module uses it: how much of a target walls hide,
// and the cover that share makes by Visioner's thresholds.
export class CoverDetector {
	_estimateWallCoveragePercent(p1, target) { return visionerStub.percent; }
	// as Visioner: from the middle of the attacker, with thresholds of 50 and 70
	_detectBetweenTokensCore(attacker, target) {
		return this._evaluateWallsCover(attacker.center, target.center, null, null, null, target);
	}
	_evaluateWallsCover(p1, p2, elevationRange, attackerSpan, targetSpan, target) {
		const percent = this._estimateWallCoveragePercent(p1, target, elevationRange, attackerSpan, targetSpan);
		return percent >= 70 ? 'greater' : (percent >= 50 ? 'standard' : 'none');
	}
}
const coverDetector = new CoverDetector();
export default coverDetector;
