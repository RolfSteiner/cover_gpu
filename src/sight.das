options gen2 = false
module sight public

require math

// Lines of sight through a map that has height, and what is seen by way of mirrors.
//
// The walls and the flat surfaces that can be in the way are kept here between calls (see
// setWalls and addFlat): a line of sight is asked about many times for each time a wall changes.
// Everything is worked out in double precision, as the places of a scene are handed in.
//
// A wall stops sight by what Foundry's Edge says of it: not from the side a one-way wall does
// not act from, not when a proximity or distance wall is within or beyond its threshold, and a
// limited wall only as the second on one line. Those three go by places on the map. A wall
// stands from its bottom to its top, and a line of sight passes over and under it. A flat
// surface is the floor of what is above it, as in Scene#testSurfaceCollision of Foundry: a
// stretch that starts on it and goes up is not stopped by it, one that comes up to end on it is.
//
// A face of a wall that is fully metallic and fully smooth is a mirror. What is seen in a part
// of a mirror is what would be seen from behind the mirror, as far behind it as the place
// looked from is in front, looking through that part as through a window (see viewThrough).
// Whether one place is seen from another by way of mirrors needs no views: for a row of mirrors
// there is one way the line of sight can take (see byMirrors).

// Foundry's CONST.EDGE_SENSE_TYPES.
let private LIMITED = 10
let private PROXIMITY = 30

// A face counts as a mirror from this much metallic and smoothness on.
let private MIRROR = 0.99lf

// A view is followed along a line at least every this much of a turn, in radians (half a degree).
let private FINE = 0.008726646259971648lf

// How far to either side of the end of a wall a view is followed as well, in radians.
let private BESIDE = 0.0001lf

// The most rows of mirrors that are tried for one line of sight between two places.
let private MOST_ROWS = 4000

// The most mirrors a line of sight takes in a row, whatever is asked for.
let private MOST_CHAIN = 8

// A mirror is looked at for being seen at one place every this many map units along it.
let private STEP = 20.0lf

// How far in front of a mirror a place is taken to see whether that place of it is seen.
let private OFF = 2.0lf

// Farther than any line is followed.
let private NEVER = 1000000000000000000000000000000.0lf

let private HALF_TURN = 3.141592653589793lf

// One wall as a line of sight meets it: its two ends, what Foundry's Edge says of it for
// sight (its EDGE_SENSE_TYPES value, its EDGE_DIRECTIONS value and its threshold in map units),
// the heights it stands between, and which of its faces mirror.
struct SightWall
	ax: double
	ay: double
	bx: double
	by: double
	sight: int
	dir: int
	threshold: double
	bottom: double
	top: double
	left: bool
	right: bool

// A turn of a line of sight at a mirror: the wall, and the place looked from mirrored at it and
// at every mirror before it.
struct Turn
	mirror: int
	x: double
	y: double

var private walls: array<SightWall>

// The triangles of the flat surfaces that stop sight, seven numbers each: the height, then the
// x and y of three corners.
var private flats: array<double>

def private cross2(ax, ay, bx, by: double) : double
	return ax * by - ay * bx

def private hypot2(x, y: double) : double
	return sqrt(x * x + y * y)

def private nonZero(value: double) : double
	return value == 0.0lf ? 1.0lf : value

// An angle brought to more than minus a half turn and at most a half turn.
def private wrapped(turn: double) : double
	var at = turn
	while at > HALF_TURN
		at -= 2.0lf * HALF_TURN
	while at <= -HALF_TURN
		at += 2.0lf * HALF_TURN
	return at

// Forgets every wall and every surface.
def clearSight
	clear(walls)
	clear(flats)

// Adds a wall. `faces` says how metallic and how smooth its left face is, then its right face.
def addWall(ax, ay, bx, by: double; sight, dir: int; threshold, bottom, top: double; metallicLeft, smoothnessLeft, metallicRight, smoothnessRight: double)
	push(walls, SightWall(ax = ax, ay = ay, bx = bx, by = by, sight = sight, dir = dir, threshold = threshold, bottom = bottom, top = top,
		left = metallicLeft >= MIRROR && smoothnessLeft >= MIRROR, right = metallicRight >= MIRROR && smoothnessRight >= MIRROR))

// Adds one triangle of a flat surface that stops sight.
def addFlat(z, x0, y0, x1, y1, x2, y2: double)
	push(flats, z)
	push(flats, x0)
	push(flats, y0)
	push(flats, x1)
	push(flats, y1)
	push(flats, x2)
	push(flats, y2)

// True while no wall names a height and no surface stops sight: every line of sight is then as
// on a flat map.
def isFlat : bool
	if !empty(flats)
		return false
	for wall in walls
		if wall.bottom > -NEVER || wall.top < NEVER
			return false
	return true

// True when a place on the map lies in the triangle that starts at flats[i].
def private inFlat(x, y: double; i: int) : bool
	let s1 = cross2(flats[i + 2] - flats[i], flats[i + 3] - flats[i + 1], x - flats[i], y - flats[i + 1])
	let s2 = cross2(flats[i + 4] - flats[i + 2], flats[i + 5] - flats[i + 3], x - flats[i + 2], y - flats[i + 3])
	let s3 = cross2(flats[i] - flats[i + 4], flats[i + 1] - flats[i + 5], x - flats[i + 4], y - flats[i + 5])
	return (s1 >= 0.0lf && s2 >= 0.0lf && s3 >= 0.0lf) || (s1 <= 0.0lf && s2 <= 0.0lf && s3 <= 0.0lf)

// True when a proximity or distance wall lets through what sets off at (px, py).
def private beyondThreshold(wall: SightWall; px, py: double) : bool
	if wall.sight < PROXIMITY || wall.threshold <= 0.0lf
		return false
	let wx = wall.bx - wall.ax
	let wy = wall.by - wall.ay
	let along = min(1.0lf, max(0.0lf, ((px - wall.ax) * wx + (py - wall.ay) * wy) / nonZero(wx * wx + wy * wy)))
	let apart = hypot2(px - wall.ax - wx * along, py - wall.ay - wy * along)
	return wall.sight == PROXIMITY ? apart < wall.threshold : apart > wall.threshold

// On which side of a wall a place lies, as Foundry's Edge#orientPoint tells it: above 0 is the
// wall's "right", from where its left face is seen.
def private sideOf(wall: SightWall; px, py: double) : double
	return (wall.ay - py) * (wall.bx - px) - (wall.ax - px) * (wall.by - py)

// True when a wall or a flat surface stops sight on the straight stretch from p to q. endA and
// endB are walls the stretch starts or ends on, which are not in its way (-1 for none).
def stopped(px, py, pz, qx, qy, qz: double; endA, endB: int) : bool
	let dx = qx - px
	let dy = qy - py
	let dz = qz - pz
	var limited = 0
	for wall, index in walls, count()
		if wall.sight == 0 || index == endA || index == endB
			continue
		let wx = wall.bx - wall.ax
		let wy = wall.by - wall.ay
		let den = cross2(dx, dy, wx, wy)
		if den == 0.0lf
			continue
		let t = cross2(wall.ax - px, wall.ay - py, wx, wy) / den
		if t <= 0.000001lf || t >= 1.0lf - 0.000001lf
			continue
		let s = cross2(wall.ax - px, wall.ay - py, dx, dy) / den
		if s < 0.0lf || s > 1.0lf
			continue
		// over the wall, or under it
		let z = pz + dz * t
		if z < wall.bottom || z > wall.top
			continue
		// a one-way wall does not act from the side it names
		if wall.dir != 0 && wall.dir == (sideOf(wall, px, py) < 0.0lf ? 1 : 2)
			continue
		if beyondThreshold(wall, px, py)
			continue
		if wall.sight != LIMITED
			return true
		limited ++
		if limited > 1
			return true
	if dz == 0.0lf
		return false
	let low = min(pz, qz)
	let high = max(pz, qz)
	for k in range(length(flats) / 7)
		let z = flats[k * 7]
		if !(z > low && z <= high)
			continue
		let t = (z - pz) / dz
		if inFlat(px + dx * t, py + dy * t, k * 7 + 1)
			return true
	return false

// True when the way by a row of mirrors from `from` to `to` is good. The way is found from its
// end: the place looked from, mirrored at each mirror of the row in turn, lies in a straight
// line with the place looked at and with the point of the last mirror the line of sight comes
// off; from there back, each point on a mirror lies in a line with the mirrored place of the
// mirrors before it. Each of those points has to be on its mirror, between the mirror's bottom
// and its top, and nothing may stop sight on any stretch. Along the way the line climbs or
// falls evenly from the height it starts at to the height it ends at.
def private goodRow(fx, fy, fz, tx, ty, tz: double; row: array<Turn>) : bool
	let n = length(row)
	var wayX: double[10]
	var wayY: double[10]
	var wayZ: double[10]
	var behind: double[10]
	var goalX = tx
	var goalY = ty
	for back in range(n)
		let i = n - 1 - back
		let mirror = walls[row[i].mirror]
		let dx = goalX - row[i].x
		let dy = goalY - row[i].y
		let wx = mirror.bx - mirror.ax
		let wy = mirror.by - mirror.ay
		let den = cross2(dx, dy, wx, wy)
		if den == 0.0lf
			return false
		let t = cross2(mirror.ax - row[i].x, mirror.ay - row[i].y, wx, wy) / den
		let s = cross2(mirror.ax - row[i].x, mirror.ay - row[i].y, dx, dy) / den
		if t <= 0.0lf || t >= 1.0lf || s < 0.0lf || s > 1.0lf
			return false
		goalX = row[i].x + dx * t
		goalY = row[i].y + dy * t
		wayX[i + 1] = goalX
		wayY[i + 1] = goalY
	wayX[0] = fx
	wayY[0] = fy
	wayX[n + 1] = tx
	wayY[n + 1] = ty
	// how high the line is at each turn: by how much of the way lies behind it
	behind[0] = 0.0lf
	for i in range(1, n + 2)
		behind[i] = behind[i - 1] + hypot2(wayX[i] - wayX[i - 1], wayY[i] - wayY[i - 1])
	let whole = nonZero(behind[n + 1])
	for i in range(n + 2)
		wayZ[i] = fz + (tz - fz) * behind[i] / whole
	for i in range(n)
		let mirror = walls[row[i].mirror]
		if wayZ[i + 1] < mirror.bottom || wayZ[i + 1] > mirror.top
			return false
	// the mirrors a stretch starts and ends on are not in its way
	for i in range(n + 1)
		let endA = i > 0 ? row[i - 1].mirror : -1
		let endB = i < n ? row[i].mirror : -1
		if stopped(wayX[i], wayY[i], wayZ[i], wayX[i + 1], wayY[i + 1], wayZ[i + 1], endA, endB)
			return false
	return true

// Tries every mirror as the next of the row, and every row that goes on from there. (ix, iy) is
// the place looked from, mirrored at the mirrors of the row so far.
def private lookOn(fx, fy, fz, tx, ty, tz, ix, iy: double; var row: array<Turn>; chain: int; var tried: int&) : bool
	let before = empty(row) ? -1 : row[length(row) - 1].mirror
	for mirror, index in walls, count()
		if mirror.sight == 0 || !(mirror.left || mirror.right) || index == before
			continue
		tried ++
		if tried > MOST_ROWS
			return false
		// the mirror has to turn a mirroring face to where the line of sight comes from
		let side = sideOf(mirror, ix, iy)
		if side == 0.0lf || !(side > 0.0lf ? mirror.left : mirror.right)
			continue
		let wx = mirror.bx - mirror.ax
		let wy = mirror.by - mirror.ay
		let along = ((ix - mirror.ax) * wx + (iy - mirror.ay) * wy) / (wx * wx + wy * wy)
		let nx = 2.0lf * (mirror.ax + wx * along) - ix
		let ny = 2.0lf * (mirror.ay + wy * along) - iy
		push(row, Turn(mirror = index, x = nx, y = ny))
		if goodRow(fx, fy, fz, tx, ty, tz, row)
			return true
		if length(row) < chain && lookOn(fx, fy, fz, tx, ty, tz, nx, ny, row, chain, tried)
			return true
		pop(row)
	return false

// True when sight gets from one place to another by way of mirrors, up to `chain` of them in a
// row.
def byMirrors(fx, fy, fz, tx, ty, tz: double; chain: int) : bool
	var inscope row: array<Turn>
	var tried = 0
	return lookOn(fx, fy, fz, tx, ty, tz, fx, fy, row, clamp(chain, 1, MOST_CHAIN), tried)

// The walls with a face that mirrors that stand at the height `eye` and stop sight: their
// places in the list of walls.
def mirrorsAt(eye: double; var found: array<int>)
	clear(found)
	for wall, index in walls, count()
		if wall.sight != 0 && (wall.left || wall.right) && eye >= wall.bottom && eye <= wall.top
			push(found, index)

// The places a mirror is looked at for being seen from (ox, oy): one in front of the middle of
// each of as many equal pieces of it as it takes to have one every STEP, x and y in turn.
// Nothing when the place faces a side of the wall that does not mirror.
def mirrorProbes(ox, oy: double; mirrorIndex: int; var places: array<double>)
	clear(places)
	let mirror = walls[mirrorIndex]
	let side = sideOf(mirror, ox, oy)
	if side == 0.0lf || !(side > 0.0lf ? mirror.left : mirror.right)
		return
	let dx = mirror.bx - mirror.ax
	let dy = mirror.by - mirror.ay
	let pieces = min(64, max(6, int(ceil(hypot2(dx, dy) / STEP))))
	for i in range(pieces)
		let x = mirror.ax + dx * (double(i) + 0.5lf) / double(pieces)
		let y = mirror.ay + dy * (double(i) + 0.5lf) / double(pieces)
		let far = nonZero(hypot2(ox - x, oy - y))
		push(places, x + (ox - x) / far * OFF)
		push(places, y + (oy - y) / far * OFF)

// The outline of what is seen from `behind` through the part of a mirror from a to b: the area
// in front of the mirror that lines from `behind` through that part reach before a wall stops
// them, as corners, x and y in turn. The view is level, at the height `eye`, and the walls that
// stand at that height stop it, but for the wall the mirror is on. A line is followed for
// `reach` at most. False, and no corners, when there is no such area.
def viewThrough(behindX, behindY, ax, ay, bx, by: double; mirrorIndex: int; reach, eye: double; var outline: array<double>) : bool
	clear(outline)
	let turnA = atan2(ay - behindY, ax - behindX)
	let span = wrapped(atan2(by - behindY, bx - behindX) - turnA)
	if abs(span) < 0.000001lf
		return false
	// the walls that can stop this view at all
	var inscope stops: array<int>
	for wall, index in walls, count()
		if index == mirrorIndex || wall.sight == 0 || eye < wall.bottom || eye > wall.top
			continue
		let side = sideOf(wall, behindX, behindY)
		if side == 0.0lf
			continue
		if wall.dir != 0 && wall.dir == (side < 0.0lf ? 1 : 2)
			continue
		if beyondThreshold(wall, behindX, behindY)
			continue
		push(stops, index)
	// the directions to follow: evenly across the part, and just to either side of every wall end
	var inscope shares: array<double>
	push(shares, 0.0lf)
	push(shares, 1.0lf)
	let beside = BESIDE / abs(span)
	let even = max(1, int(ceil(abs(span) / FINE)))
	for i in range(1, even)
		push(shares, double(i) / double(even))
	for index in stops
		for corner in range(2)
			let x = corner == 0 ? walls[index].ax : walls[index].bx
			let y = corner == 0 ? walls[index].ay : walls[index].by
			let at = wrapped(atan2(y - behindY, x - behindX) - turnA) / span
			if at > 0.0lf && at < 1.0lf
				push(shares, max(0.0lf, at - beside))
				push(shares, at)
				push(shares, min(1.0lf, at + beside))
	sort(shares)
	let mx = bx - ax
	let my = by - ay
	var inscope far: array<double>
	var nearFirstX = 0.0lf
	var nearFirstY = 0.0lf
	var nearLastX = 0.0lf
	var nearLastY = 0.0lf
	var last = -1.0lf
	for at in shares
		if at == last
			continue
		last = at
		let turn = turnA + span * at
		let dx = cos(turn)
		let dy = sin(turn)
		// where the line passes the mirror: the view starts there
		let through = cross2(dx, dy, mx, my)
		if through == 0.0lf
			continue
		let start = cross2(ax - behindX, ay - behindY, mx, my) / through
		var stop = reach
		var firstLimited = NEVER
		var secondLimited = NEVER
		for index in stops
			let wall = walls[index]
			let wx = wall.bx - wall.ax
			let wy = wall.by - wall.ay
			let den = cross2(dx, dy, wx, wy)
			if den == 0.0lf
				continue
			let t = cross2(wall.ax - behindX, wall.ay - behindY, wx, wy) / den
			if t <= start + 0.01lf || t >= stop
				continue
			let s = cross2(wall.ax - behindX, wall.ay - behindY, dx, dy) / den
			if s < 0.0lf || s > 1.0lf
				continue
			if wall.sight == LIMITED
				if t < firstLimited
					secondLimited = firstLimited
					firstLimited = t
				elif t < secondLimited
					secondLimited = t
			else
				stop = t
		stop = min(stop, secondLimited)
		if !(stop > start)
			continue
		nearLastX = behindX + dx * start
		nearLastY = behindY + dy * start
		if empty(far)
			nearFirstX = nearLastX
			nearFirstY = nearLastY
		push(far, behindX + dx * stop)
		push(far, behindY + dy * stop)
	if length(far) < 4
		return false
	// along the mirror at the first line, out along the far ends, and back to the mirror at the last
	push(outline, nearFirstX)
	push(outline, nearFirstY)
	for value in far
		push(outline, value)
	push(outline, nearLastX)
	push(outline, nearLastY)
	return true

// The views a place (ox, oy) has in one mirror. `seen` says of each place mirrorProbes named
// whether it is seen from there; each stretch of neighbouring pieces that are seen is a part of
// the mirror with a view of its own, from the place mirrored at the wall (at whole map units)
// through that part. What is added to `views` per view that sees anything: the number of the
// part among the parts of the mirror, the mirrored place (x, y), how many numbers its outline
// has, and the outline as viewThrough gives it.
def mirrorViews(ox, oy: double; mirrorIndex: int; seen: array<bool>; reach, eye: double; var views: array<double>)
	clear(views)
	let pieces = length(seen)
	if pieces == 0
		return
	let mirror = walls[mirrorIndex]
	let dx = mirror.bx - mirror.ax
	let dy = mirror.by - mirror.ay
	let along = ((ox - mirror.ax) * dx + (oy - mirror.ay) * dy) / (dx * dx + dy * dy)
	let behindX = floor(2.0lf * (mirror.ax + dx * along) - ox + 0.5lf)
	let behindY = floor(2.0lf * (mirror.ay + dy * along) - oy + 0.5lf)
	var inscope outline: array<double>
	var number = 0
	var from = -1
	for i in range(pieces + 1)
		if i < pieces && seen[i]
			if from < 0
				from = i
			continue
		if from < 0
			continue
		let first = double(from) / double(pieces)
		let last = double(i) / double(pieces)
		from = -1
		if viewThrough(behindX, behindY, mirror.ax + dx * first, mirror.ay + dy * first, mirror.ax + dx * last, mirror.ay + dy * last, mirrorIndex, reach, eye, outline)
			push(views, double(number))
			push(views, behindX)
			push(views, behindY)
			push(views, double(length(outline)))
			for value in outline
				push(views, value)
		number ++

// The places of a token another token looks at: the middle of it and four places half way out
// to its corners, each near its head and at half its height, as x, y and height in turn. The
// token is w wide and h high on the map round (cx, cy), and stands from bottom to top.
def tokenPlaces(cx, cy, w, h, bottom, top: double; var places: array<double>)
	clear(places)
	let qw = w / 4.0lf
	let qh = h / 4.0lf
	for level in range(2)
		let z = bottom + (top - bottom) * (level == 0 ? 0.9lf : 0.5lf)
		for corner in range(5)
			let sx = corner == 0 ? 0.0lf : (corner == 1 || corner == 4 ? -1.0lf : 1.0lf)
			let sy = corner == 0 ? 0.0lf : (corner <= 2 ? -1.0lf : 1.0lf)
			push(places, cx + sx * qw)
			push(places, cy + sy * qh)
			push(places, z)
