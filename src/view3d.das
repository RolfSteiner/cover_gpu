options gen2 = false
module view3d public

require math
require daslib/json
require daslib/json_boost

// The scene in perspective: a camera that can be moved, turned and brought closer, what it
// sees as triangles and lines, and what a line of sight from it through a place on the screen
// meets. Nothing here draws: the caller puts the triangles and lines on the screen (WebGL, in
// view3d.mjs of the module) and says where the mouse is.
//
// Places and heights are in map units throughout: x to the right and y down, as on the map,
// and z up. A place on the screen is given from -1 to 1 both ways, x to the right and y up.
//
// What there is to see is kept between frames:
//  - the scene (setScene): its levels with their floors, the walls, and the flat surfaces that
//    are no floor of any level;
//  - the cover test to show (clearCovers, addCover, addRun);
//  - the camera: where it looks at on the ground, how far from that it is, and how it is
//    turned and tilted.
// Tokens and lights are handed in with every frame, since they move.
//
// A frame (see frame) is a list of vertices, ten numbers each: where (3), its color and how
// solid (4), where in a picture (2), and how much of that picture it shows. They come in
// draws, each a run of vertices drawn in one go with the pictures it shows:
//  - what is solid, in lots: one for everything that shows Foundry's own picture of the frame
//    or a color alone, one for the floors of each level that is not viewed (its own picture or
//    color, and the light traced for it), and one for the top of each token that shows its own
//    picture;
//  - what is see-through, in one draw, from the farthest piece to the nearest;
//  - the lines.

// How wide the camera sees from top to bottom, as an angle.
let private FIELD = 0.6981317

// How flat and how steep the camera may look down, as angles above the ground.
let private FLATTEST = 0.20943951
let private STEEPEST = 1.5533430

// How many flat sides a cylinder is drawn with.
let private SIDES = 28

// How many numbers a vertex is.
let private STRIDE = 10

// How many numbers of a frame's head come before its draws, and how many a draw is.
let private HEAD = 32
let private DRAW = 8

// A wall or a height that names no end is this far out.
let private BIG = 1000000000.0

let private WALL = float3(0.76, 0.76, 0.72)
let private MIRROR = float3(0.56, 0.83, 1.0)
let private FLOOR = float3(0.56, 0.83, 1.0)
let private BODY = float3(0.86, 0.85, 0.8)
let private PICKED = float3(1.0, 0.6, 0.16)
let private LAMP = float3(1.0, 0.77, 0.25)
let private SEEN = float3(1.0, 0.77, 0.25)
let private HIDDEN = float3(0.9, 0.4, 0.4)
let private INK = float3(0.94, 0.94, 0.92)
let private WHITE = float3(1.0, 1.0, 1.0)

// How many numbers a token and a light of a frame are.
let private TOKEN = 7
let private LIGHT = 7

// What a token shows on its top: Foundry's picture of it, its own picture, or, while that is
// not loaded, a color.
let private SHOWS_FRAME = 0
let private SHOWS_OWN = 1
let private SHOWS_NOTHING = 2

// One floor: it lies level at the height z over the triangles of t, six numbers each (the x
// and y of three corners).
struct ViewFloor
	z: float
	t: array<float>

// One level: whether it is the viewed one, the height of its base, whether it has a floor all
// over there, its color (red, green, blue), and its further floors.
struct ViewLevel
	viewed: int
	base: float
	plane: int
	color: array<float>
	floors: array<ViewFloor>

// The scene as setScene reads it from JSON text. `floor` is the height of the lowest floor and
// `viewedBase` that of the viewed level; `tall` is how high a wall without a top is drawn;
// `area`, `lightArea` and `all` are rectangles on the map (x, y, width, height): what the
// picture of a level lies over, what the pictures of the light lie over, and the whole canvas.
// `walls` holds seven numbers per wall: its two ends (x and y each), its bottom and its top
// (beyond BIG / 2 either way where it names none), and 1 for a wall with a face that mirrors.
struct ViewScene
	floor: float
	viewedBase: float
	tall: float
	area: array<float>
	lightArea: array<float>
	all: array<float>
	levels: array<ViewLevel>
	surfaces: array<ViewFloor>
	walls: array<float>

// A stretch of the edge of a target of the cover test in which the same lines of sight are
// stopped: from and to on the target's circle, and one bit per height, set where it is stopped.
struct ViewRun
	from: float2
	to: float2
	mask: int

// The cover test of one target, as it is drawn: where the source looks from, the ends of the
// source's diameter, the target (a circle from bottom to top), at how many heights it is looked
// at, and the runs.
struct ViewCover
	eye: float3
	lineA: float3
	lineB: float3
	centre: float2
	radius: float
	bottom: float
	top: float
	heights: int
	runs: array<ViewRun>

// The camera as it stands: where it is, and the three directions of what it sees.
struct Camera
	eye: float3
	ahead: float3
	right: float3
	up: float3
	aspect: float
	floor: float

// A floor of the last frame, for the mouse: at the height z, over a rectangle or over the
// triangles of a floor of the scene (surface >= 0: of a level's floors).
struct PickFloor
	z: float
	area: float4
	level: int
	floor: int

// A lot of solid triangles and the pictures it shows.
struct Lot
	lit: bool
	shows: int
	ref: int
	light: int
	list: array<float>

// A see-through piece: how far it is from the camera, and its vertices in `glass`.
struct Piece
	far: float
	first: int
	count: int

// The look at a target of the cover test in one direction, told by where round the target it
// enters the target's circle: how far that is on the map, in which direction, and from how low
// to how high the target is seen there.
struct Look
	turn: float
	near: float
	ux: float
	uy: float
	low: float
	high: float

var private scene: ViewScene
var private covers: array<ViewCover>
var private camTarget: float2
var private camDistance = 1000.0
var private camTurn = 0.0
var private camTilt = 0.9599311
var private camera: Camera
var private hasCamera = false
var private heldAt = 0.0
var private holds = false
var private tokens: array<float>
var private pickFloors: array<PickFloor>
var private lots: array<Lot>
var private lotCount = 0
var private glass: array<float>
var private pieces: array<Piece>
var private lines: array<float>
var private looks: array<Look>
var private head: array<float>
var private verts: array<float>
// how the map lies in Foundry's picture of the frame: a place (x, y) is at
// ((a x + c y + tx) / width, (b x + d y + ty) / height) of it
var private lieA = 1.0
var private lieB = 0.0
var private lieC = 0.0
var private lieD = 1.0
var private lieX = 0.0
var private lieY = 0.0
var private screenW = 1.0
var private screenH = 1.0

def private rectOf(list: array<float>) : float4
	return length(list) >= 4 ? float4(list[0], list[1], list[2], list[3]) : float4(0.0, 0.0, 0.0, 0.0)

// A rectangle as a shader takes it to find a place in a picture that lies over it.
def private inverse(r: float4) : float4
	return float4(r.x, r.y, 1.0 / max(r.z, 1.0), 1.0 / max(r.w, 1.0))

def private wrapped(angle: float) : float
	var at = angle
	while at > PI
		at -= 2.0 * PI
	while at <= -PI
		at += 2.0 * PI
	return at

// --- what there is to see ----------------------------------------------------------------------

// Takes the scene from JSON text (see ViewScene).
def setScene(text: string)
	var error: string
	var js = read_json(text, error)
	delete scene
	scene <- from_JV(js, type<ViewScene>)
	unsafe
		delete js

def clearCovers
	delete covers

// Adds the cover test of one target; addRun adds its runs.
def addCover(eye, lineA, lineB: float3; centre: float2; radius, bottom, top: float; heights: int)
	var cover: ViewCover
	cover.eye = eye
	cover.lineA = lineA
	cover.lineB = lineB
	cover.centre = centre
	cover.radius = radius
	cover.bottom = bottom
	cover.top = top
	cover.heights = heights
	emplace(covers, cover)

def addRun(from, to: float2; mask: int)
	push(covers[length(covers) - 1].runs, ViewRun(from = from, to = to, mask = mask))

// --- the camera --------------------------------------------------------------------------------

// The camera as it stands. Not turned, it stands south of the place it looks at and looks
// north, so that the scene lies before it as on the map.
def private stand(floor, aspect: float) : Camera
	let flat = cos(camTilt)
	let away = float3(sin(camTurn) * flat, cos(camTurn) * flat, sin(camTilt))
	let at = float3(camTarget.x, camTarget.y, floor)
	let eye = at + away * camDistance
	let ahead = normalize(at - eye)
	let right = float3(cos(camTurn), -sin(camTurn), 0.0)
	return Camera(eye = eye, ahead = ahead, right = right, up = cross(ahead, right), aspect = aspect, floor = floor)

// The camera as the sixteen numbers a shader takes, at head[0]: a place of the scene to where
// it is on the screen.
def private writeMatrix
	let zoom = 1.0 / tan(FIELD / 2.0)
	let near = max(camDistance * 0.02, 1.0)
	let far = camDistance * 60.0 + 20000.0
	let deep = (far + near) / (far - near)
	let rows = [[float4 float4(camera.right * (zoom / camera.aspect), -dot(camera.eye, camera.right) * zoom / camera.aspect);
		float4(camera.up * zoom, -dot(camera.eye, camera.up) * zoom);
		float4(camera.ahead * deep, -dot(camera.eye, camera.ahead) * deep - 2.0 * far * near / (far - near));
		float4(camera.ahead, -dot(camera.eye, camera.ahead))]]
	for row in range(4)
		for column in range(4)
			head[column * 4 + row] = rows[row][column]

// The line of sight from the camera through a place on the screen.
def private sightThrough(sx, sy: float) : float3
	let reach = tan(FIELD / 2.0)
	return normalize(camera.ahead + camera.right * (sx * reach * camera.aspect) + camera.up * (sy * reach))

// How far along a line of sight the level plane at a height is; below 0 when it runs away from it.
def private toPlane(direction: float3; z: float) : float
	if abs(direction.z) < 0.000001
		return -1.0
	return (z - camera.eye.z) / direction.z

def private inTriangles(x, y: float; t: array<float>) : bool
	for k in range(length(t) / 6)
		let i = k * 6
		let s1 = (t[i + 2] - t[i]) * (y - t[i + 1]) - (t[i + 3] - t[i + 1]) * (x - t[i])
		let s2 = (t[i + 4] - t[i + 2]) * (y - t[i + 3]) - (t[i + 5] - t[i + 3]) * (x - t[i + 2])
		let s3 = (t[i] - t[i + 4]) * (y - t[i + 5]) - (t[i + 1] - t[i + 5]) * (x - t[i + 4])
		if (s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0) || (s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0)
			return true
	return false

// What the line of sight through a place on the screen meets first: a token, a floor of one of
// the levels, or the ground. False for the sky.
def private meets(sx, sy: float; var at: float3&) : bool
	if !hasCamera
		return false
	let direction = sightThrough(sx, sy)
	var best = -1.0
	let ground = toPlane(direction, scene.floor)
	if ground > 0.0
		best = ground
	for floor in pickFloors
		let t = toPlane(direction, floor.z)
		if t <= 0.0 || (best > 0.0 && t >= best)
			continue
		let p = camera.eye + direction * t
		if floor.level >= 0 ? inTriangles(p.x, p.y, scene.levels[floor.level].floors[floor.floor].t) : (p.x >= floor.area.x && p.y >= floor.area.y && p.x <= floor.area.x + floor.area.z && p.y <= floor.area.y + floor.area.w)
			best = t
	for k in range(length(tokens) / TOKEN)
		let x = tokens[k * TOKEN]
		let y = tokens[k * TOKEN + 1]
		let radius = tokens[k * TOKEN + 2]
		let bottom = tokens[k * TOKEN + 3]
		let top = tokens[k * TOKEN + 4]
		// its top
		let onTop = toPlane(direction, top)
		if onTop > 0.0 && (best < 0.0 || onTop < best)
			let p = camera.eye + direction * onTop
			if length(float2(p.x - x, p.y - y)) <= radius
				best = onTop
		// its side: where the line, seen from above, enters the token's circle
		let ox = camera.eye.x - x
		let oy = camera.eye.y - y
		let a = direction.x * direction.x + direction.y * direction.y
		let b = 2.0 * (ox * direction.x + oy * direction.y)
		let c = ox * ox + oy * oy - radius * radius
		let inside = b * b - 4.0 * a * c
		if a > 0.000000001 && inside >= 0.0
			let t = (-b - sqrt(inside)) / (2.0 * a)
			let z = camera.eye.z + direction.z * t
			if z >= bottom && z <= top && t > 0.0 && (best < 0.0 || t < best)
				best = t
	if best <= 0.0
		return false
	at = camera.eye + direction * best
	return true

// Shows the view: the camera looks at the place Foundry's view looked at, from far enough to
// see about as much of the scene as that view showed. `height` is the height of the screen
// and `scale` the zoom of Foundry's view.
def start(x, y, height, scale: float)
	camTarget = float2(x, y)
	camDistance = height / scale / 2.0 / tan(FIELD / 2.0) * 0.9
	camTurn = 0.0
	camTilt = 0.9599311
	hasCamera = false
	holds = false

def stop
	hasCamera = false
	holds = false
	clear(tokens)
	clear(pickFloors)

// The place on the ground the camera looks at.
def lookedAt : float2
	return camTarget

// The left button was pressed at a place on the screen: what it takes hold of is moved at the
// height it was taken hold at.
def press(sx, sy: float)
	var at: float3
	holds = meets(sx, sy, at)
	heldAt = at.z

def release
	holds = false

// Moves the camera over the ground, so that the ground that was under the mouse stays under it.
def drag(fromX, fromY, toX, toY: float)
	if !hasCamera
		return
	let before = sightThrough(fromX, fromY)
	let after = sightThrough(toX, toY)
	let was = toPlane(before, camera.floor)
	let now = toPlane(after, camera.floor)
	if was <= 0.0 || now <= 0.0
		return
	let a = before * was
	let b = after * now
	let far = camDistance * 12.0
	if length(float2(a.x, a.y)) < far && length(float2(b.x, b.y)) < far
		camTarget += float2(a.x - b.x, a.y - b.y)
		camera = stand(camera.floor, camera.aspect)

// Turns the camera round the place it looks at and tilts it, by how far the mouse went in pixels.
def turnBy(dx, dy: float)
	camTurn -= dx * 0.006
	camTilt = clamp(camTilt + dy * 0.005, FLATTEST, STEEPEST)

// Brings the camera closer or takes it away, by what the wheel says; `across` is the diagonal
// of the scene.
def zoomBy(delta, across: float)
	camDistance = clamp(camDistance * exp(delta * 0.0012), 60.0, across * 4.0)

// Where on the scene the mouse is, as Foundry is to take it: what its line of sight meets, or,
// while the left button holds something, where the line passes the height it took hold at.
// False for the sky, and while the view is not shown.
def sceneAt(sx, sy: float; var at: float2&) : bool
	if !hasCamera
		return false
	var p: float3
	if holds
		let direction = sightThrough(sx, sy)
		let t = toPlane(direction, heldAt)
		if t <= 0.0
			return false
		p = camera.eye + direction * t
	elif !meets(sx, sy, p)
		return false
	at = float2(p.x, p.y)
	return true

// Where on the screen a place on the ground of the scene is seen, from 0 to 1 both ways, x to
// the right and y down. False when it is behind the camera.
def screenAt(x, y: float; var at: float2&) : bool
	if !hasCamera
		return false
	let from = float3(x, y, camera.floor) - camera.eye
	let deep = dot(from, camera.ahead)
	if deep <= 0.0
		return false
	let zoom = 1.0 / tan(FIELD / 2.0)
	at = float2((dot(from, camera.right) * zoom / camera.aspect / deep + 1.0) / 2.0, (1.0 - dot(from, camera.up) * zoom / deep) / 2.0)
	return true

// --- a frame -----------------------------------------------------------------------------------

def private put(var list: array<float>; p, color: float3; alpha, u, v, shows: float)
	let n = length(list)
	resize(list, n + STRIDE)
	list[n] = p.x
	list[n + 1] = p.y
	list[n + 2] = p.z
	list[n + 3] = color.x
	list[n + 4] = color.y
	list[n + 5] = color.z
	list[n + 6] = alpha
	list[n + 7] = u
	list[n + 8] = v
	list[n + 9] = shows

// a vertex that shows its color alone
def private plain(var list: array<float>; p, color: float3; alpha: float)
	put(list, p, color, alpha, 0.0, 0.0, 0.0)

// a vertex that shows Foundry's picture of the frame at its place
def private framed(var list: array<float>; p, color: float3)
	put(list, p, color, 1.0, (lieA * p.x + lieC * p.y + lieX) / screenW, (lieB * p.x + lieD * p.y + lieY) / screenH, 1.0)

def private triangle(var list: array<float>; a, b, c, color: float3; alpha: float)
	plain(list, a, color, alpha)
	plain(list, b, color, alpha)
	plain(list, c, color, alpha)

def private line(a, b, color: float3; alpha: float)
	plain(lines, a, color, alpha)
	plain(lines, b, color, alpha)

// a floor all over a rectangle, in a color or showing Foundry's picture
def private rectangle(var list: array<float>; area: float4; z: float; color: float3; showsFrame: bool)
	let a = float3(area.x, area.y, z)
	let b = float3(area.x + area.z, area.y, z)
	let c = float3(area.x + area.z, area.y + area.w, z)
	let d = float3(area.x, area.y + area.w, z)
	if showsFrame
		framed(list, a, color)
		framed(list, b, color)
		framed(list, c, color)
		framed(list, a, color)
		framed(list, c, color)
		framed(list, d, color)
	else
		triangle(list, a, b, c, color, 1.0)
		triangle(list, a, c, d, color, 1.0)

def private flat(var list: array<float>; floor: ViewFloor; color: float3; showsFrame: bool)
	for k in range(length(floor.t) / 6)
		for corner in range(3)
			let p = float3(floor.t[k * 6 + corner * 2], floor.t[k * 6 + corner * 2 + 1], floor.z)
			if showsFrame
				framed(list, p, color)
			else
				plain(list, p, color, 1.0)

// The next lot of solid triangles; its place in `lots`.
def private lot(lit: bool; shows, ref, light: int) : int
	if lotCount == length(lots)
		var made: Lot
		emplace(lots, made)
	lots[lotCount].lit = lit
	lots[lotCount].shows = shows
	lots[lotCount].ref = ref
	lots[lotCount].light = light
	clear(lots[lotCount].list)
	lotCount ++
	return lotCount - 1

// A see-through piece begins: what is put into `glass` from here to endPiece is one piece, as
// far from the camera as its middle is.
def private beginPiece(middle: float3)
	push(pieces, Piece(far = length(middle - camera.eye), first = length(glass), count = 0))

def private endPiece
	pieces[length(pieces) - 1].count = length(glass) - pieces[length(pieces) - 1].first

def private lookAt(cover: ViewCover; turn: float) : Look
	let dx = cover.centre.x + cos(turn) * cover.radius - cover.eye.x
	let dy = cover.centre.y + sin(turn) * cover.radius - cover.eye.y
	var near = sqrt(dx * dx + dy * dy)
	if near == 0.0
		near = 1.0
	let ux = dx / near
	let uy = dy / near
	// how far the look runs on inside the circle
	let away = near + max(0.0, -2.0 * cover.radius * (ux * cos(turn) + uy * sin(turn)))
	return Look(turn = turn, near = near, ux = ux, uy = uy,
		low = cover.eye.z < cover.bottom ? atan2(cover.bottom - cover.eye.z, away) : atan2(cover.bottom - cover.eye.z, near),
		high = cover.eye.z > cover.top ? atan2(cover.top - cover.eye.z, away) : atan2(cover.top - cover.eye.z, near))

// Where the line of sight of a look meets the target, `part` of the way from the lowest to the
// highest: on its side, or on its top or bottom. A little off the target, so that what is drawn
// there lies on it and not in it.
def private onTarget(cover: ViewCover; seen: Look; part: float) : float3
	let rise = tan(seen.low + (seen.high - seen.low) * part)
	let z = cover.eye.z + rise * seen.near
	if z > cover.top && rise < 0.0
		let run = (cover.top - cover.eye.z) / rise
		return float3(cover.eye.x + seen.ux * run, cover.eye.y + seen.uy * run, cover.top + 1.0)
	if z < cover.bottom && rise > 0.0
		let run = (cover.bottom - cover.eye.z) / rise
		return float3(cover.eye.x + seen.ux * run, cover.eye.y + seen.uy * run, cover.bottom - 1.0)
	let out = cover.radius * 1.03 + 1.0
	return float3(cover.centre.x + cos(seen.turn) * out, cover.centre.y + sin(seen.turn) * out, clamp(z, cover.bottom, cover.top))

// The cover test of one target. From where the source looks from, the target fills a cone of
// lines of sight: on the map between the two directions that just touch it, and in each
// direction from the lowest to the highest it is seen at. The cone is drawn where it ends on
// the target, stretch by stretch round it and part by part up it: in one color where the walls
// stop the line of sight before it gets there, in another where it gets there. Faint sheets
// from where the source looks from show the lines of sight, and four lines the corners of the
// cone.
def private drawCover(cover: ViewCover)
	line(cover.lineA, cover.lineB, INK, 0.9)
	let count = max(cover.heights, 1)
	var first: Look
	var last: Look
	var any = false
	for run in cover.runs
		let from = atan2(run.from.y - cover.centre.y, run.from.x - cover.centre.x)
		let span = wrapped(atan2(run.to.y - cover.centre.y, run.to.x - cover.centre.x) - from)
		let steps = max(1, int(ceil(abs(span) / (PI / 14.0))))
		clear(looks)
		for s in range(steps + 1)
			push(looks, lookAt(cover, from + span * float(s) / float(steps)))
		if !any
			first = looks[0]
			any = true
		last = looks[steps]
		for j in range(count)
			let color = ((run.mask >> j) & 1) != 0 ? HIDDEN : SEEN
			let lower = float(j) / float(count)
			let upper = float(j + 1) / float(count)
			let half = (lower + upper) / 2.0
			let middle = onTarget(cover, looks[steps >> 1], half)
			beginPiece(middle)
			for s in range(steps)
				let a = onTarget(cover, looks[s], lower)
				let b = onTarget(cover, looks[s + 1], lower)
				let c = onTarget(cover, looks[s + 1], upper)
				let d = onTarget(cover, looks[s], upper)
				triangle(glass, a, b, c, color, 0.7)
				triangle(glass, a, c, d, color, 0.7)
			endPiece()
			let endA = onTarget(cover, looks[0], half)
			let endB = onTarget(cover, looks[steps], half)
			beginPiece((cover.eye + middle) * 0.5)
			triangle(glass, cover.eye, endA, endB, color, 0.1)
			endPiece()
			// a stretch of one direction, or a target seen edge on, has no area to show
			line(onTarget(cover, looks[0], lower), onTarget(cover, looks[0], upper), color, 0.6)
			line(endA, endB, color, 0.35)
	if any
		line(cover.eye, onTarget(cover, first, 0.0), INK, 0.45)
		line(cover.eye, onTarget(cover, first, 1.0), INK, 0.45)
		line(cover.eye, onTarget(cover, last, 0.0), INK, 0.45)
		line(cover.eye, onTarget(cover, last, 1.0), INK, 0.45)

// A token: a cylinder whose side is lit from where the camera's right is. Its top shows
// Foundry's picture of it where Foundry has drawn it, and its own picture otherwise.
def private drawToken(number: int)
	let at = number * TOKEN
	let x = tokens[at]
	let y = tokens[at + 1]
	let radius = tokens[at + 2]
	let bottom = tokens[at + 3]
	// a token that has no height is its top alone, a little off the floor it lies on
	let top = max(tokens[at + 4], bottom + 0.5)
	let edge = tokens[at + 5] != 0.0 ? PICKED : BODY
	let shows = int(tokens[at + 6])
	let cap = shows == SHOWS_OWN ? lot(false, SHOWS_OWN, number, -1) : 0
	let capColor = shows == SHOWS_NOTHING ? BODY : WHITE
	let middle = float3(x, y, top)
	for i in range(SIDES)
		let turnP = float(i) / float(SIDES) * 2.0 * PI
		let turnQ = float((i + 1) % SIDES) / float(SIDES) * 2.0 * PI
		let p = float2(cos(turnP), sin(turnP))
		let q = float2(cos(turnQ), sin(turnQ))
		let pTop = float3(x + p.x * radius, y + p.y * radius, top)
		let qTop = float3(x + q.x * radius, y + q.y * radius, top)
		if shows == SHOWS_FRAME
			framed(lots[cap].list, middle, capColor)
			framed(lots[cap].list, pTop, capColor)
			framed(lots[cap].list, qTop, capColor)
		elif shows == SHOWS_OWN
			put(lots[cap].list, middle, capColor, 1.0, 0.5, 0.5, 1.0)
			put(lots[cap].list, pTop, capColor, 1.0, 0.5 + p.x / 2.0, 0.5 + p.y / 2.0, 1.0)
			put(lots[cap].list, qTop, capColor, 1.0, 0.5 + q.x / 2.0, 0.5 + q.y / 2.0, 1.0)
		else
			triangle(lots[cap].list, middle, pTop, qTop, capColor, 1.0)
		line(pTop, qTop, edge, 1.0)
		if tokens[at + 4] > bottom
			let lit = 0.55 + 0.45 * max(0.0, p.x * camera.right.x + p.y * camera.right.y)
			let pBottom = float3(pTop.x, pTop.y, bottom)
			let qBottom = float3(qTop.x, qTop.y, bottom)
			triangle(lots[0].list, pBottom, qBottom, qTop, BODY * lit, 1.0)
			triangle(lots[0].list, pBottom, qTop, pTop, BODY * lit, 1.0)
			line(pBottom, qBottom, edge, 0.8)

// The part of the ground the camera sees, as the place and the zoom Foundry's own view is to
// move to so that its next picture holds it, as large as the screen lets it be: written to
// head[18..21] as 1, x, y and the zoom, or 0 when Foundry's view may stay as it is. It stays
// while it still holds all of that part without being much too wide for it, so that the picture
// does not swim under a camera that moves a little. `view` is what Foundry's view holds now
// and `all` the whole canvas, each x, y, width and height; `zoom` is the zoom of Foundry's
// view, `least` the least it can be, and `pivot` the place it looks at.
def private follow(view, all: float4; zoom, least: float; pivot: float2)
	head[18] = 0.0
	var low = float2(BIG, BIG)
	var high = float2(-BIG, -BIG)
	let reach = camDistance * 8.0
	for i in range(9)
		for j in range(9)
			let direction = sightThrough(float(i) / 4.0 - 1.0, float(j) / 4.0 - 1.0)
			let t = toPlane(direction, camera.floor)
			var at = float2(camera.eye.x + direction.x * t, camera.eye.y + direction.y * t)
			// towards the horizon the ground goes on for ever; so far is far enough
			if t <= 0.0 || length(at - float2(camera.eye.x, camera.eye.y)) > reach
				var level = length(float2(direction.x, direction.y))
				if level == 0.0
					level = 1.0
				at = float2(camera.eye.x + direction.x / level * reach, camera.eye.y + direction.y / level * reach)
			low = min(low, at)
			high = max(high, at)
	low = max(low, float2(all.x, all.y))
	high = min(high, float2(all.x + all.z, all.y + all.w))
	if !(high.x > low.x && high.y > low.y)
		return
	let holdsAll = view.x <= low.x + 1.0 && view.y <= low.y + 1.0 && view.x + view.z >= high.x - 1.0 && view.y + view.w >= high.y - 1.0
	let wanted = min(screenW / (high.x - low.x), screenH / (high.y - low.y)) / 1.12
	if holdsAll && zoom > wanted / 1.6
		return
	let middle = (low + high) * 0.5
	// Foundry will not show more than so much at once: then what it does show stays as it is
	if !holdsAll && wanted < least && abs(zoom - least) < 0.000001 && length(pivot - middle) < 1.0
		return
	head[18] = 1.0
	head[19] = middle.x
	head[20] = middle.y
	head[21] = wanted

// Works out a frame. `inputs` holds how the map lies in Foundry's picture of this frame (a, b,
// c, d, tx, ty of the transform from the map to the screen), the width and the height of the
// screen, how much wider than high the view is, the zoom of Foundry's view, the least it can
// be, the place it looks at (x, y), and 1 when the cover test is shown. `tokenData` holds TOKEN
// numbers per token: its middle (x, y), its radius, its bottom and its top, 1 when it is
// selected, and what its top shows (SHOWS_FRAME, SHOWS_OWN or SHOWS_NOTHING). `lightData`
// holds LIGHT numbers per light: where it is (x, y, z), its color, and how much of that color
// its light has (0 to 1). `flags` holds two numbers per level of the scene: 1 when its own
// picture is there to show, 1 when the light traced for it is.
//
// Returns how many draws the frame is. The head of the frame (see headOf) holds the camera as a
// matrix (0 to 15), the number of draws (16), the number of vertices (17), where Foundry's view
// is to move to (18 to 21, see follow), the rectangles of a level's picture and of the pictures
// of the light as a shader takes them (22 to 25, 26 to 29), and from HEAD on DRAW numbers per
// draw: its first vertex, how many vertices, 1 for lines, 1 for a floor of a level that is not
// viewed, which picture it shows (SHOWS_FRAME, or SHOWS_OWN: a level's picture, or a token's, by
// the next number), the number of that level or token (-1 for none), the number of the level
// whose traced light it shows (-1 for none), and 1 when it is see-through.
def frame(inputs: float?; tokenData: float?; tokenCount: int; lightData: float?; lightCount: int; flags: float?) : int
	unsafe
		lieA = inputs[0]
		lieB = inputs[1]
		lieC = inputs[2]
		lieD = inputs[3]
		lieX = inputs[4]
		lieY = inputs[5]
		screenW = max(inputs[6], 1.0)
		screenH = max(inputs[7], 1.0)
	var aspect = 1.0
	var zoom = 1.0
	var least = 0.0
	var pivot: float2
	var showCover = false
	unsafe
		aspect = inputs[8]
		zoom = inputs[9]
		least = inputs[10]
		pivot = float2(inputs[11], inputs[12])
		showCover = inputs[13] != 0.0
	resize(tokens, tokenCount * TOKEN)
	for i in range(tokenCount * TOKEN)
		unsafe
			tokens[i] = tokenData[i]
	// the camera looks at a place on the floor of the viewed level
	camera = stand(scene.viewedBase, aspect)
	hasCamera = true
	lotCount = 0
	clear(glass)
	clear(pieces)
	clear(lines)
	clear(pickFloors)
	let solid = lot(false, SHOWS_FRAME, -1, -1)

	// the part of the scene Foundry's picture holds
	let det = lieA * lieD - lieC * lieB
	var viewLow = float2(BIG, BIG)
	var viewHigh = float2(-BIG, -BIG)
	for corner in range(4)
		let sx = corner == 1 || corner == 2 ? screenW : 0.0
		let sy = corner >= 2 ? screenH : 0.0
		let p = float2((lieD * sx - lieC * sy + lieY * lieC - lieX * lieD) / det, (lieA * sy - lieB * sx - lieY * lieA + lieX * lieB) / det)
		viewLow = min(viewLow, p)
		viewHigh = max(viewHigh, p)
	let view = float4(viewLow.x, viewLow.y, viewHigh.x - viewLow.x, viewHigh.y - viewLow.y)
	let all = length(scene.all) >= 4 ? rectOf(scene.all) : view
	let x0 = max(view.x, all.x)
	let y0 = max(view.y, all.y)
	let held = float4(x0, y0, min(view.x + view.z, all.x + all.z) - x0, min(view.y + view.w, all.y + all.w) - y0)

	// The levels. The viewed one shows Foundry's picture on its floors; each other one is a lot
	// of its own, with its picture and the light traced for it.
	let area = length(scene.area) >= 4 ? rectOf(scene.area) : all
	for level, number in scene.levels, count()
		if level.viewed != 0
			if level.plane != 0 && held.z > 0.0 && held.w > 0.0
				rectangle(lots[solid].list, held, level.base, WHITE, true)
			for floor in level.floors
				flat(lots[solid].list, floor, WHITE, true)
		else
			var hasPicture = false
			var hasLight = false
			unsafe
				hasPicture = flags[number * 2] != 0.0
				hasLight = flags[number * 2 + 1] != 0.0
			let own = lot(true, hasPicture ? SHOWS_OWN : SHOWS_FRAME, hasPicture ? number : -1, hasLight ? number : -1)
			let color = hasPicture || length(level.color) < 3 ? WHITE : float3(level.color[0], level.color[1], level.color[2])
			if level.plane != 0
				rectangle(lots[own].list, area, level.base, color, false)
			for floor in level.floors
				flat(lots[own].list, floor, color, false)
		if level.plane != 0
			push(pickFloors, PickFloor(z = level.base, area = level.viewed != 0 ? all : area, level = -1, floor = -1))
		for floor, index in level.floors, count()
			push(pickFloors, PickFloor(z = floor.z, level = number, floor = index))

	// the surfaces that are no floor of any level are see-through
	for surface in scene.surfaces
		for k in range(length(surface.t) / 6)
			let a = float3(surface.t[k * 6], surface.t[k * 6 + 1], surface.z)
			let b = float3(surface.t[k * 6 + 2], surface.t[k * 6 + 3], surface.z)
			let c = float3(surface.t[k * 6 + 4], surface.t[k * 6 + 5], surface.z)
			beginPiece((a + b + c) / 3.0)
			triangle(glass, a, b, c, FLOOR, 0.22)
			endPiece()

	for k in range(length(scene.walls) / 7)
		let at = k * 7
		let bottom = abs(scene.walls[at + 4]) < BIG * 0.5 ? scene.walls[at + 4] : scene.floor
		let open = !(abs(scene.walls[at + 5]) < BIG * 0.5)
		let top = open ? max(bottom, scene.floor) + scene.tall : scene.walls[at + 5]
		let color = scene.walls[at + 6] != 0.0 ? MIRROR : WALL
		let a = float3(scene.walls[at], scene.walls[at + 1], bottom)
		let b = float3(scene.walls[at + 2], scene.walls[at + 3], bottom)
		let c = float3(b.x, b.y, top)
		let d = float3(a.x, a.y, top)
		beginPiece(float3((a.x + b.x) / 2.0, (a.y + b.y) / 2.0, (bottom + top) / 2.0))
		triangle(glass, a, b, c, color, open ? 0.16 : 0.34)
		triangle(glass, a, c, d, color, open ? 0.16 : 0.34)
		endPiece()
		let edge = open ? 0.5 : 0.95
		line(a, b, color, edge)
		line(b, c, color, edge)
		line(c, d, color, edge)
		line(d, a, color, edge)

	for number in range(tokenCount)
		drawToken(number)

	if showCover
		for cover in covers
			drawCover(cover)

	// a traced light: a small square that faces the camera, on a stem down to the lowest floor
	for k in range(lightCount)
		var at: float3
		var color: float3
		var strength = 1.0
		unsafe
			at = float3(lightData[k * LIGHT], lightData[k * LIGHT + 1], lightData[k * LIGHT + 2])
			color = float3(lightData[k * LIGHT + 3], lightData[k * LIGHT + 4], lightData[k * LIGHT + 5])
			strength = lightData[k * LIGHT + 6]
		color = WHITE + (color - WHITE) * strength
		line(float3(at.x, at.y, scene.floor), at, LAMP, 0.9)
		let size = length(at - camera.eye) * 0.008
		let a = at + (-camera.right - camera.up) * size
		let b = at + (camera.right - camera.up) * size
		let c = at + (camera.right + camera.up) * size
		let d = at + (-camera.right + camera.up) * size
		triangle(lots[solid].list, a, b, c, color, 1.0)
		triangle(lots[solid].list, a, c, d, color, 1.0)

	// the see-through pieces from the farthest to the nearest; of two as far as each other, the
	// one made first comes first
	sort(pieces) <| $(p, q: Piece) : bool
		return p.far > q.far || (p.far == q.far && p.first < q.first)

	// everything in one list, and the draws that take their part of it
	var draws = 0
	var total = length(glass) + length(lines)
	for i in range(lotCount)
		total += length(lots[i].list)
		if !empty(lots[i].list)
			draws ++
	if !empty(glass)
		draws ++
	if !empty(lines)
		draws ++
	resize(head, HEAD + draws * DRAW)
	resize(verts, max(total, STRIDE))
	writeMatrix()
	head[16] = float(draws)
	head[17] = float(total / STRIDE)
	let pictureArea = inverse(area)
	let lightArea = inverse(rectOf(scene.lightArea))
	for i in range(4)
		head[22 + i] = pictureArea[i]
		head[26 + i] = lightArea[i]
	var at = 0
	var draw = HEAD
	for i in range(lotCount)
		let size = length(lots[i].list)
		if size == 0
			continue
		for k in range(size)
			verts[at + k] = lots[i].list[k]
		head[draw] = float(at / STRIDE)
		head[draw + 1] = float(size / STRIDE)
		head[draw + 2] = 0.0
		head[draw + 3] = lots[i].lit ? 1.0 : 0.0
		head[draw + 4] = float(lots[i].shows)
		head[draw + 5] = float(lots[i].ref)
		head[draw + 6] = float(lots[i].light)
		head[draw + 7] = 0.0
		draw += DRAW
		at += size
	for mode in range(2)
		let size = mode == 0 ? length(glass) : length(lines)
		if size == 0
			continue
		let first = at
		if mode == 0
			for piece in pieces
				for k in range(piece.count)
					verts[at + k] = glass[piece.first + k]
				at += piece.count
		else
			for k in range(size)
				verts[at + k] = lines[k]
			at += size
		head[draw] = float(first / STRIDE)
		head[draw + 1] = float(size / STRIDE)
		head[draw + 2] = mode == 0 ? 0.0 : 1.0
		head[draw + 3] = 0.0
		head[draw + 4] = float(SHOWS_FRAME)
		head[draw + 5] = -1.0
		head[draw + 6] = -1.0
		head[draw + 7] = 1.0
		draw += DRAW

	follow(view, all, zoom, least, pivot)
	return draws

// The head of the last frame, and its vertices (see frame).
def headOf : float?
	unsafe
		return addr(head[0])

def vertsOf : float?
	unsafe
		return addr(verts[0])
