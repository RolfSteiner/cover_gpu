options gen2 = false
module isometric public

require math

// The scene looked at from the side. The map is turned and sheared on the screen so that what
// lies to the right on the map runs up to the right and what lies below runs down to the right
// (see lieOf). Every height then has a direction on the screen, straight up, and what has a
// height can be drawn standing: here are the outlines for that, as places on the map that the
// turned map shows where the standing thing is seen. Nothing here draws.

// What a shape of `shapes` is.
let private BODY_SIDE = 0
let private BODY_TOP = 1
let private FLOOR = 2
let private WALL = 3
let private LAMP = 4

// How many numbers a token, a wall, a triangle of a flat surface and a light are, as they are
// handed in (the first two as view3d takes them).
let private TOKEN = 7
let private EDGE = 7
let private FLAT = 7
let private LIGHT = 7

// How many steps the half of a circle is drawn in.
let private ARC = 16

// A height that names no end is this far out.
let private BIG = 1000000000.0

// How the map lies on the screen, but for the zoom: a step of (x, y) on the map is a step of
// (a x + c y, b x + d y) on the screen. `up` is the step on the map that is one unit straight
// up on the screen, which is where a height of 1 goes; `across` is the direction on the map
// that runs farthest to the right on the screen.
struct Lie
	a: float
	b: float
	c: float
	d: float
	det: float
	up: float2
	across: float2

// How the map lies when its x axis runs `tilt` up from level on the screen and its y axis as
// far down (0: flat, as on the map).
def lieOf(tilt: double) : Lie
	let a = cos(tilt)
	let b = -sin(tilt)
	let c = sin(2.0lf * tilt)
	let d = cos(2.0lf * tilt)
	let det = a * d - b * c
	let wide = sqrt(a * a + c * c)
	return Lie(a = float(a), b = float(b), c = float(c), d = float(d), det = float(det), up = float2(float(c / det), float(-a / det)), across = float2(float(a / wide), float(c / wide)))

// Half of the edge of a circle at a height, as places on the map, added to `out`: from the
// angle `from` to the angle `to` round the middle, `way` being 1 or -1 for the side it bulges to.
def private arc(lie: Lie; x, y, radius, lift, from, to, way: float; var out: array<float>)
	let beside = float2(-lie.across.y, lie.across.x)
	for k in range(ARC + 1)
		let turn = from + (to - from) * float(k) / float(ARC)
		push(out, x + radius * (cos(turn) * lie.across.x + sin(turn) * way * beside.x) + lie.up.x * lift)
		push(out, y + radius * (cos(turn) * lie.across.y + sin(turn) * way * beside.y) + lie.up.y * lift)

// The places of a list in the order of their keys, the lowest first; of two with the same key
// the earlier one comes first. The keys are doubles: two things that are as far back as each
// other to the last digit have to stay in the order they came in.
def private ordered(keys: array<double>; var order: array<int>)
	clear(order)
	for i in range(length(keys))
		push(order, i)
	sort(order) <| $(p, q: int) : bool
		return keys[p] < keys[q] || (keys[p] == keys[q] && p < q)

// What stands on the map, as shapes to draw, in the order to draw them in. The map lies at the
// height `ground`. `bodies` holds TOKEN numbers per token (its middle, its radius, its bottom
// and its top, 1 when it is selected), `walls` EDGE numbers per wall (its two ends, its bottom
// and its top, beyond BIG / 2 where it names none, and 1 for a mirror), `flats` FLAT numbers
// per triangle of a flat surface (its height and the x and y of three corners) and `lights`
// LIGHT numbers per light (x, y, its height, its color and how much of the color its light has).
// A wall without a top is drawn `tall` high.
//
// A shape is three numbers and then its own: what it is, a flag, and how many numbers follow.
//  - BODY_SIDE (flag: 1 when selected): the outline of a token from its feet to its head, as
//    the corners of a polygon. A token is a cylinder; the outline is the near half of its
//    bottom, its two sides, and the far half of its top. Left out for a token without height.
//  - BODY_TOP (flag: 1 when selected): the top of that token, as the middle of a circle and
//    its radius. The tokens come from the back of the screen to the front.
//  - FLOOR: one triangle of a flat surface above the ground, where it lies.
//  - WALL (flag: 1 for a mirror, plus 2 for a wall without a top): a wall from its bottom to
//    its top, as the four corners of a polygon. The walls come from the back to the front.
//  - LAMP: a light, as the place it is over, the place it is seen at, and its color.
def shapes(tilt: double; ground, tall: float; bodies: float?; bodyCount: int; walls: float?; wallCount: int; flats: float?; flatCount: int; lights: float?; lightCount: int; var out: array<float>)
	clear(out)
	let lie = lieOf(tilt)
	let beside = float2(-lie.across.y, lie.across.x)
	// the way round a circle that comes nearer the bottom of the screen
	let near = lie.b * beside.x + lie.d * beside.y > 0.0 ? 1.0 : -1.0
	// how far down the screen a place of the map is: what is farther up is farther back
	let downX = -sin(tilt)
	let downY = cos(2.0lf * tilt)
	var inscope keys: array<double>
	var inscope order: array<int>
	for i in range(bodyCount)
		unsafe
			push(keys, downX * double(bodies[i * TOKEN]) + downY * double(bodies[i * TOKEN + 1]))
	ordered(keys, order)
	for i in order
		var x = 0.0
		var y = 0.0
		var radius = 0.0
		var bottom = 0.0
		var top = 0.0
		var picked = 0.0
		unsafe
			x = bodies[i * TOKEN]
			y = bodies[i * TOKEN + 1]
			radius = bodies[i * TOKEN + 2]
			bottom = bodies[i * TOKEN + 3]
			top = bodies[i * TOKEN + 4]
			picked = bodies[i * TOKEN + 5]
		if top > bottom
			push(out, float(BODY_SIDE))
			push(out, picked)
			push(out, float((ARC + 1) * 4))
			arc(lie, x, y, radius, bottom - ground, PI, 0.0, near, out)
			arc(lie, x, y, radius, top - ground, 0.0, PI, -near, out)
		push(out, float(BODY_TOP))
		push(out, picked)
		push(out, 3.0)
		push(out, x + lie.up.x * (top - ground))
		push(out, y + lie.up.y * (top - ground))
		push(out, radius)
	for i in range(flatCount)
		var z = 0.0
		unsafe
			z = flats[i * FLAT]
		if !(z > ground)
			continue
		push(out, float(FLOOR))
		push(out, 0.0)
		push(out, 6.0)
		for corner in range(3)
			unsafe
				push(out, flats[i * FLAT + 1 + corner * 2] + lie.up.x * (z - ground))
				push(out, flats[i * FLAT + 2 + corner * 2] + lie.up.y * (z - ground))
	clear(keys)
	for i in range(wallCount)
		unsafe
			push(keys, downX * double(walls[i * EDGE] + walls[i * EDGE + 2]) + downY * double(walls[i * EDGE + 1] + walls[i * EDGE + 3]))
	ordered(keys, order)
	for i in order
		var a: float2
		var b: float2
		var bottom = 0.0
		var top = 0.0
		var mirror = 0.0
		unsafe
			a = float2(walls[i * EDGE], walls[i * EDGE + 1])
			b = float2(walls[i * EDGE + 2], walls[i * EDGE + 3])
			bottom = walls[i * EDGE + 4]
			top = walls[i * EDGE + 5]
			mirror = walls[i * EDGE + 6]
		if !(abs(bottom) < BIG * 0.5)
			bottom = ground
		let open = !(abs(top) < BIG * 0.5)
		if open
			top = max(bottom, ground) + tall
		push(out, float(WALL))
		push(out, (mirror != 0.0 ? 1.0 : 0.0) + (open ? 2.0 : 0.0))
		push(out, 8.0)
		for corner in range(4)
			let p = corner == 0 || corner == 3 ? a : b
			let z = corner < 2 ? bottom : top
			push(out, p.x + lie.up.x * (z - ground))
			push(out, p.y + lie.up.y * (z - ground))
	for i in range(lightCount)
		var at: float3
		var color: float3
		var strength = 1.0
		unsafe
			at = float3(lights[i * LIGHT], lights[i * LIGHT + 1], lights[i * LIGHT + 2])
			color = float3(lights[i * LIGHT + 3], lights[i * LIGHT + 4], lights[i * LIGHT + 5])
			strength = lights[i * LIGHT + 6]
		color = saturate(float3(1.0, 1.0, 1.0) + (color - float3(1.0, 1.0, 1.0)) * strength)
		push(out, float(LAMP))
		push(out, 0.0)
		push(out, 7.0)
		push(out, at.x)
		push(out, at.y)
		push(out, at.x + lie.up.x * (at.z - ground))
		push(out, at.y + lie.up.y * (at.z - ground))
		push(out, color.x)
		push(out, color.y)
		push(out, color.z)
