// Lines of sight and views in mirrors worked out in plain JavaScript, as the module did before
// the script library took them over (src/sight.das). library.html checks the library against
// these.

/** Foundry's CONST.EDGE_SENSE_TYPES. */
const LIMITED = 10;
const PROXIMITY = 30;

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

/** True when a place on the map lies in one of the triangles of `t` (six numbers each). */
function inTriangles(x, y, t) {
	for (let i = 0; i + 5 < t.length; i += 6) {
		const s1 = cross(t[i + 2] - t[i], t[i + 3] - t[i + 1], x - t[i], y - t[i + 1]);
		const s2 = cross(t[i + 4] - t[i + 2], t[i + 5] - t[i + 3], x - t[i + 2], y - t[i + 3]);
		const s3 = cross(t[i] - t[i + 4], t[i + 1] - t[i + 5], x - t[i + 4], y - t[i + 5]);
		if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
	}
	return false;
}

/**
 * True when a wall or a flat surface stops sight on the straight stretch from p to q.
 *
 * @param {{x: number, y: number, z: number}} p where the stretch starts, z being its height
 * @param {{x: number, y: number, z: number}} q where it ends
 * @param {object[]} walls `{ id, ax, ay, bx, by, sight, dir, threshold, bottom, top }` each
 * @param {object[]} surfaces `{ z, t }` each, the flat surfaces that stop sight. As in
 *   Scene#testSurfaceCollision of Foundry, a surface is the floor of what is above it: a stretch
 *   that starts on it and goes up is not stopped by it, one that comes up to end on it is
 * @param {string[]} [ends] walls the stretch starts or ends on, which are not in its way
 * @returns {boolean}
 */
export function stopped(p, q, walls, surfaces = [], ends = []) {
	const dx = q.x - p.x;
	const dy = q.y - p.y;
	const dz = q.z - p.z;
	let limited = 0;
	for (const wall of walls) {
		if (!wall.sight || ends.includes(wall.id)) continue;
		const wx = wall.bx - wall.ax;
		const wy = wall.by - wall.ay;
		const den = cross(dx, dy, wx, wy);
		if (den === 0) continue;
		const t = cross(wall.ax - p.x, wall.ay - p.y, wx, wy) / den;
		if (t <= 1e-6 || t >= 1 - 1e-6) continue;
		const s = cross(wall.ax - p.x, wall.ay - p.y, dx, dy) / den;
		if (s < 0 || s > 1) continue;
		// over the wall, or under it
		const z = p.z + dz * t;
		if (z < wall.bottom || z > wall.top) continue;
		// Foundry's Edge#orientPoint, and a one-way wall does not act from the side it names
		const side = (wall.ay - p.y) * (wall.bx - p.x) - (wall.ax - p.x) * (wall.by - p.y);
		if (wall.dir && wall.dir === (side < 0 ? 1 : 2)) continue;
		if (wall.sight >= PROXIMITY && wall.threshold > 0) {
			const along = Math.min(1, Math.max(0, ((p.x - wall.ax) * wx + (p.y - wall.ay) * wy) / (wx * wx + wy * wy || 1)));
			const apart = Math.hypot(p.x - wall.ax - wx * along, p.y - wall.ay - wy * along);
			if (wall.sight === PROXIMITY ? apart < wall.threshold : apart > wall.threshold) continue;
		}
		if (wall.sight !== LIMITED || ++limited > 1) return true;
	}
	if (dz === 0) return false;
	const low = Math.min(p.z, q.z);
	const high = Math.max(p.z, q.z);
	for (const surface of surfaces) {
		if (!(surface.z > low && surface.z <= high)) continue;
		const t = (surface.z - p.z) / dz;
		if (inTriangles(p.x + dx * t, p.y + dy * t, surface.t)) return true;
	}
	return false;
}

/** A view is followed along a line at least every this much of a turn, in radians (half a degree). */
const FINE = Math.PI / 360;

/** How far to either side of the end of a wall a view is followed as well, in radians. */
const BESIDE = 0.0001;

/** The most rows of mirrors that are tried for one line of sight between two places. */
const MOST_ROWS = 4000;

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
