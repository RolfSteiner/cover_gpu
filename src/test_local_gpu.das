options gen2 = false
// These two let collect() below reclaim memory the script no longer uses.
options persistent_heap
options gc

require daslib/json
require daslib/json_boost
require daslib/math
require daslib/math_boost
require daslib/safe_addr
require opengl/opengl_boost

// Tests of rays against the walls of a map, a cover test and a path tracer for the map's light,
// where every test of a ray against the walls runs on the graphics card through WebGL 2.
//
// The map has height. A wall stands upright on its line on the map, from its bottom to its top,
// and stops what meets it in between; a wall that names neither is as high and as deep as the
// map goes. Besides walls there are flat surfaces: floors, ceilings and roofs, each lying level
// at one height over an area of the map (see readScene). x and y are places on the map, z is the
// height, all three in map units.
//
// How the work is split:
//  - The tree is flattened into a list of entries, one per object of every cell, in the order
//    the tree is walked: a cell's own objects, then each of its child cells. The list is
//    uploaded as a texture (see uploadEntries).
//  - The rays of one step are uploaded as a second texture, and one draw call tests every ray
//    against every entry: a fragment shader runs once per ray and writes what that ray meets
//    (see castRays and castCover). test() has one ray only, so there the shader runs once per
//    entry and writes whether the ray crosses its box and its wall (see castOne).
//  - What comes back is read with glReadPixels. Everything that is not a ray-against-walls
//    test stays in this script: reading the tree, choosing the rays, trimming walls to their
//    visible part (visibleEnd), and putting the results together.
//
// test_light_adaptive can also draw a picture of the light, found by path tracing, onto the
// canvas of the WebGL context, and trace_lights draws such a picture for any number of light
// sources (see tracePicture). That picture never leaves the graphics card.
//
// A wall may say how it acts on what meets it (see wallOf). test_cover counts the walls and the
// surfaces that stop movement only, and trace_lights follows what each wall does to light and
// how each of its faces throws it back. Every other function works on every wall of the tree,
// whatever it says, and on no surface.
//
// WebGL has no way to create a context from inside the library, so the caller does it: before
// the first call, JavaScript creates a WebGL 2 context on a canvas and makes it current for
// this module (see test_local_gpu_api.js). Without a current context every function here fails.

// Rays are laid out in rows of this many.
let BATCH_WIDTH = 1024

// The bottom of a wall that names none is this far down, its top this far up.
let BIG = 1000000000.0

// test_cover looks at a target at this many heights at most: one bit each of what comes back.
let MOST_HEIGHTS = 24

// Vertex stage of every program: one triangle that covers the whole target, so that the
// fragment stage runs once per pixel.
let VERTEX_SOURCE = "#version 300 es
void main() \{
	vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
\}
"

// What all fragment stages share: the entries, the flat surfaces, and the tests of a ray
// against them. A ray runs from o to o + d.
//  hitsBox     = the ray crosses a box that stands from heights.x up to heights.y
//  hitsWall    = the ray, seen from above, crosses the line of a wall, and where: `at` is 0 at
//                o and 1 at o + d. How high the ray is there, and whether the wall stands at
//                that height, is left to the caller.
//  hitsSurface = the ray passes through a flat surface
let COMMON_SOURCE = "#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_entries;
uniform int u_count;
uniform sampler2D u_surfaces;
uniform int u_surfaceCount;
out vec4 o_color;
const float BIG = 1.0e9;

bool slab(float o, float d, float lo, float hi, inout float tmin, inout float tmax) \{
	if (d == 0.0) \{
		return o >= lo && o <= hi;
	\}
	float inv = 1.0 / d;
	float t0 = (lo - o) * inv;
	float t1 = (hi - o) * inv;
	tmin = max(tmin, min(t0, t1));
	tmax = min(tmax, max(t0, t1));
	return true;
\}

bool hitsBox(vec3 o, vec3 d, vec4 box, vec2 heights) \{
	float tmin = 0.0;
	float tmax = 1.0;
	if (!slab(o.x, d.x, box.x, box.z, tmin, tmax)) return false;
	if (!slab(o.y, d.y, box.y, box.w, tmin, tmax)) return false;
	if (!slab(o.z, d.z, heights.x, heights.y, tmin, tmax)) return false;
	return tmin < tmax;
\}

bool hitsWall(vec3 o, vec3 d, vec4 wall, out float at) \{
	vec2 w = wall.xy - o.xy;
	float den = d.x * wall.w - d.y * wall.z;
	at = 0.0;
	if (den == 0.0) return false;
	float t = w.x * wall.w - w.y * wall.z;
	float u = w.x * d.y - w.y * d.x;
	at = t / den;
	if (den > 0.0) return t >= 0.0 && t <= den && u >= 0.0 && u <= den;
	return t <= 0.0 && t >= den && u <= 0.0 && u >= den;
\}

// True for a one-way wall that lets through what crosses it along d. `dir` is the wall's
// EDGE_DIRECTIONS value: 1 (left) and 2 (right) name the side of the wall from which it does
// not act, as Edge#orientPoint of Foundry tells the sides apart; 0 acts from both.
bool letsThrough(vec2 d, vec4 wall, float dir) \{
	float den = d.x * wall.w - d.y * wall.z;
	return (dir == 1.0 && den > 0.0) || (dir == 2.0 && den < 0.0);
\}

// 1 when the ray crosses the cell and the box of entry i, 2 when it crosses its wall as well,
// between the wall's bottom and its top
int hitsEntry(vec3 o, vec3 d, int i, out float at) \{
	at = 0.0;
	if (!hitsBox(o, d, texelFetch(u_entries, ivec2(0, i), 0), vec2(-BIG, BIG))) return 0;
	vec4 more = texelFetch(u_entries, ivec2(3, i), 0);
	if (!hitsBox(o, d, texelFetch(u_entries, ivec2(1, i), 0), more.yz)) return 0;
	if (!hitsWall(o, d, texelFetch(u_entries, ivec2(2, i), 0), at)) return 1;
	float z = o.z + d.z * at;
	return z >= more.y && z <= more.z ? 2 : 1;
\}

// True when a place on the map lies in a triangle, which is two pixels of a texture: its three
// corners (x and y of the first two, then of the third), then its height.
bool inTriangle(vec2 p, vec4 one, vec4 two) \{
	vec2 ab = one.zw - one.xy;
	vec2 bc = two.xy - one.zw;
	vec2 ca = one.xy - two.xy;
	float s1 = ab.x * (p.y - one.y) - ab.y * (p.x - one.x);
	float s2 = bc.x * (p.y - one.w) - bc.y * (p.x - one.z);
	float s3 = ca.x * (p.y - two.y) - ca.y * (p.x - two.x);
	return (s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0) || (s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0);
\}

// True when the ray passes through flat surface i, and where along it. A surface is a triangle
// lying level, two pixels of u_surfaces (see inTriangle). A ray that sets off on the surface
// and goes up does not pass through it, and one that comes up to end on it does, as
// Scene#testSurfaceCollision of Foundry has it: the surface is the floor of what is above it.
bool hitsSurface(vec3 o, vec3 d, int i, out float at) \{
	at = 0.0;
	vec4 one = texelFetch(u_surfaces, ivec2(0, i), 0);
	vec4 two = texelFetch(u_surfaces, ivec2(1, i), 0);
	float z = two.z;
	if (!(z > min(o.z, o.z + d.z) && z <= max(o.z, o.z + d.z))) return false;
	at = (z - o.z) / d.z;
	return inTriangle(o.xy + d.xy * at, one, two);
\}
"

// One pixel per ray: the number of the entry whose wall the ray meets first, counted from 1,
// in the first three bytes; 0 when it meets none. Of two walls met equally early the earlier
// entry wins. The rays lie level, all at the height u_z, and meet the walls that stand at that
// height. With u_oneWay set, a one-way wall crossed from the side it does not act from is not
// met.
let NEAREST_SOURCE = "
uniform sampler2D u_rays;
uniform float u_z;
uniform int u_oneWay;
void main() \{
	vec4 ray = texelFetch(u_rays, ivec2(gl_FragCoord.xy), 0);
	vec3 o = vec3(ray.xy, u_z);
	vec3 d = vec3(ray.zw, 0.0);
	int best = 0;
	float bestAt = 2.0;
	for (int i = 0; i < u_count; i++) \{
		float at;
		if (hitsEntry(o, d, i, at) == 2 && at < bestAt) \{
			if (u_oneWay != 0 && letsThrough(d.xy, texelFetch(u_entries, ivec2(2, i), 0), texelFetch(u_entries, ivec2(3, i), 0).x)) continue;
			bestAt = at;
			best = i + 1;
		\}
	\}
	o_color = vec4(float(best & 255), float((best >> 8) & 255), float((best >> 16) & 255), 255.0) / 255.0;
\}
"

// One pixel per direction of test_cover. A direction is two pixels of u_rays: where the look
// sets off (x, y, z) and the bottom of the target, then how far the look runs on the map to
// reach the target (x, y), the top of the target and at how many heights the target is looked
// at. Those heights are spread evenly from the target's bottom to its top (the middle of as
// many equal slices), and to each of them runs one ray from where the look sets off.
//
// What is written is one bit per height, the lowest height first: set when a wall or a flat
// surface stops the ray to that height. A wall stops it when the ray, seen from above, crosses
// the wall's line, from a side the wall acts from, and is no lower than the wall's bottom and
// no higher than its top where it crosses. Seen from above the rays of one direction are one
// and the same, so the walls are gone through once per direction, not once per ray.
let COVER_SOURCE = "
uniform sampler2D u_rays;
void main() \{
	ivec2 pixel = ivec2(gl_FragCoord.xy);
	vec4 one = texelFetch(u_rays, ivec2(pixel.x * 2, pixel.y), 0);
	vec4 two = texelFetch(u_rays, ivec2(pixel.x * 2 + 1, pixel.y), 0);
	vec3 o = one.xyz;
	vec3 level = vec3(two.xy, 0.0);
	int heights = int(two.w);
	float slice = (two.z - one.w) / float(max(heights, 1));
	int mask = 0;
	for (int i = 0; i < u_count; i++) \{
		if (!hitsBox(o, level, texelFetch(u_entries, ivec2(0, i), 0), vec2(-BIG, BIG))) continue;
		if (!hitsBox(o, level, texelFetch(u_entries, ivec2(1, i), 0), vec2(-BIG, BIG))) continue;
		vec4 wall = texelFetch(u_entries, ivec2(2, i), 0);
		float at;
		if (!hitsWall(o, level, wall, at)) continue;
		vec4 more = texelFetch(u_entries, ivec2(3, i), 0);
		if (letsThrough(level.xy, wall, more.x)) continue;
		for (int j = 0; j < heights; j++) \{
			float z = o.z + (one.w + slice * (float(j) + 0.5) - o.z) * at;
			if (z >= more.y && z <= more.z) mask |= 1 << j;
		\}
	\}
	for (int i = 0; i < u_surfaceCount; i++) \{
		for (int j = 0; j < heights; j++) \{
			float at;
			if (hitsSurface(o, vec3(two.xy, one.w + slice * (float(j) + 0.5) - o.z), i, at)) mask |= 1 << j;
		\}
	\}
	o_color = vec4(float(mask & 255), float((mask >> 8) & 255), float((mask >> 16) & 255), 255.0) / 255.0;
\}
"

// One pixel per entry, for a single ray: red when the ray crosses the entry's cell and box,
// green when it crosses its wall as well.
let HITS_SOURCE = "
uniform vec3 u_origin;
uniform vec3 u_dir;
uniform int u_width;
void main() \{
	ivec2 pixel = ivec2(gl_FragCoord.xy);
	int i = pixel.y * u_width + pixel.x;
	float at;
	int hit = i < u_count ? hitsEntry(u_origin, u_dir, i, at) : 0;
	o_color = vec4(hit >= 1 ? 1.0 : 0.0, hit == 2 ? 1.0 : 0.0, 0.0, 1.0);
\}
"

// The picture of the light: one pixel per place of the map, as bright as the light that gets to
// the floor there, in the color of that light. The floor is not at one height all over the map.
// The ground lies level at the height u_floor, and above it there may be floors: triangles
// lying level, each at a height of its own, two pixels of u_floors each (see inTriangle). The
// floor of a place is the highest of the floors over it, and the ground where there is none
// (see floorAt). So a place under a raised floor shows the light on that floor, not the light
// on the ground below it, and a place beside it shows the light on the ground. Light arrives
// straight from the sources, and after bouncing off walls and flat surfaces. A face of a wall
// scatters light to all sides, mirrors it, or does some of each (see BOUNCE_SOURCE).
//
// It is drawn in three steps, each a program of its own (see tracePicture):
//  1. BOUNCE_SOURCE finds the light that is thrown back to the floor, by path tracing. It is
//     noisy: each pixel follows a handful of random paths.
//  2. SMOOTH_SOURCE takes the noise out by averaging each pixel with pixels around it, several
//     times over, each time looking twice as far. It never averages across a wall.
//  3. SHOW_SOURCE adds the light that comes straight from the sources, which needs no
//     smoothing, and writes the picture.
//
// LIGHT_SOURCE is what the three share. A wall is four pixels of u_walls: its origin and
// direction on the map, then how it acts on light, the way Foundry's ClockwiseSweepPolygon
// reads an Edge:
//  - x, its EDGE_SENSE_TYPES value. A normal wall (20) stops light. A limited wall (10) stops
//    light that has crossed another limited wall on the same straight run. A proximity wall
//    (30) lets light through that sets off nearer to it than its threshold, a distance wall
//    (40) light that sets off farther away. Walls that do nothing to light are not in the list.
//  - y, its EDGE_DIRECTIONS value (see letsThrough);
//  - z, its threshold for light in map units; a proximity or distance wall without one acts
//    as a normal wall;
// then what its two faces are like: x and y say how metallic and how smooth its left face is,
// z and w the same for its right face, each from 0 to 1 (see BOUNCE_SOURCE for what they do).
// Left and right are the sides EDGE_DIRECTIONS names: the left face is the one a wall of
// direction "left" acts on. Last come its bottom and its top, between which it stops light,
// and the height up to which its faces throw light back (see BOUNCE_SOURCE).
// Light on its last run to a place sets off at its source. Along a path, a run is followed
// from the place it arrives at, and for the thresholds it counts as setting off there. The
// thresholds, the sides of a one-way wall and the cone of a source go by places on the map,
// whatever the heights, as they do in Foundry.
//
// A flat surface (see hitsSurface) stops light that passes through it.
//
// A light source is four pixels of u_lights:
//  - x, y, then its reach and the reach of its bright light. Inside the bright reach it is 1
//    bright, outside as bright as its dim light is (below), and nothing beyond its reach; the
//    two steps are smoothed as Foundry's lighting shaders do it. A reach of 0 or less marks a
//    source without an end instead, which is 1 bright next to it and a half at the fourth
//    value away. How far a place is from a source counts with the difference in height;
//  - its color, and 1 when walls and surfaces act on it (0: it shines through all of them);
//  - the direction of the middle of its cone (x, y) and the cosine of half the cone's angle
//    (below -1: it shines all round), then how much the steps are smoothed, 0 to 1;
//  - its own radius, which Foundry adds to its distance from a proximity or distance wall
//    (Edge#applyThreshold), then how much light its dim light is, bright light being 1, then
//    1 for a source whose light is in the picture only as far as it is thrown back: what
//    comes straight from it is left out, for someone else to draw; and last its height.
//
// All of this is worked out in amounts of light. A pixel holds an amount of light to the power
// of 1 / GAMMA, the way a screen expects a picture: a pixel half as bright as another then
// also looks half as bright. More light than the brightest of a source (1) is written as 1.
let LIGHT_SOURCE = "
uniform sampler2D u_walls;
uniform int u_wallCount;
uniform sampler2D u_lights;
uniform int u_lightCount;
uniform vec4 u_area;
uniform vec2 u_size;
uniform float u_floor;
uniform sampler2D u_floors;
uniform int u_floorCount;
const float GAMMA = 2.2;
const float LIMITED = 10.0;
const float PROXIMITY = 30.0;

// how high the floor lies at a place on the map
float floorAt(vec2 p) \{
	float z = u_floor;
	for (int i = 0; i < u_floorCount; i++) \{
		vec4 two = texelFetch(u_floors, ivec2(1, i), 0);
		if (two.z > z && inTriangle(p, texelFetch(u_floors, ivec2(0, i), 0), two)) z = two.z;
	\}
	return z;
\}

// the place a pixel of the picture shows, on the floor that is there; the picture has its first
// row at the bottom, the map has it at the top
vec3 placeOf(vec2 pixel) \{
	vec2 p = vec2(mix(u_area.x, u_area.z, pixel.x / u_size.x), mix(u_area.w, u_area.y, pixel.y / u_size.y));
	return vec3(p, floorAt(p));
\}

// an amount of light as a pixel holds it, and back
vec3 stored(vec3 light) \{
	return pow(clamp(light, 0.0, 1.0), vec3(1.0 / GAMMA));
\}

vec3 unstored(vec3 held) \{
	return pow(held, vec3(GAMMA));
\}

uint scramble(uint v) \{
	v = v * 747796405u + 2891336453u;
	uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
	return (w >> 22u) ^ w;
\}

// the next random number from 0 up to 1
float chance(inout uint state) \{
	state = scramble(state);
	return float(state >> 8u) / 16777216.0;
\}

// how far p is from the nearest point of the wall, on the map
float offWall(vec2 p, vec4 wall) \{
	vec2 v = p - wall.xy;
	float along = clamp(dot(v, wall.zw) / max(dot(wall.zw, wall.zw), 0.000001), 0.0, 1.0);
	return length(v - wall.zw * along);
\}

// What wall i does to light on the run from o over d: 0 when the run does not cross it, passes
// under or over it, or the wall lets the light through, 1 when it stops the light, 2 when it
// is a limited wall. The light set off at `source` on the map, which was `margin` in radius;
// `forward` is false when the light runs from the end of the run to its start.
int meets(vec3 o, vec3 d, int i, vec2 source, float margin, bool forward, out float at, out vec4 wall) \{
	wall = texelFetch(u_walls, ivec2(0, i), 0);
	if (!hitsWall(o, d, wall, at)) return 0;
	vec4 stands = texelFetch(u_walls, ivec2(3, i), 0);
	float z = o.z + d.z * at;
	if (z < stands.x || z > stands.y) return 0;
	vec4 acts = texelFetch(u_walls, ivec2(1, i), 0);
	if (letsThrough(forward ? d.xy : -d.xy, wall, acts.y)) return 0;
	if (acts.x >= PROXIMITY && acts.z > 0.0) \{
		float apart = offWall(source, wall);
		if (acts.x == PROXIMITY ? max(apart - margin, 0.0) < acts.z : apart + margin > acts.z) return 0;
	\}
	return acts.x == LIMITED ? 2 : 1;
\}

// true when the light of a source at `from`, `margin` in radius, gets to `to`
bool reaches(vec3 from, vec3 to, float margin) \{
	bool clear = true;
	int limited = 0;
	for (int i = 0; i < u_wallCount; i++) \{
		float at;
		vec4 wall;
		int met = meets(from, to - from, i, from.xy, margin, true, at, wall);
		if (met == 2) limited++;
		if (met == 1 || limited > 1) \{
			clear = false;
			break;
		\}
	\}
	if (!clear) return false;
	for (int i = 0; i < u_surfaceCount; i++) \{
		float at;
		if (hitsSurface(from, to - from, i, at)) \{
			clear = false;
			break;
		\}
	\}
	return clear;
\}

// The light source k sends straight to a place, and in `toward` the direction from the place
// to the source. A place on a wall or on a surface has the normal of the face it lies on, and
// gets nothing from a source behind that face; a place on the open floor has none (all 0), and
// takes light from wherever it comes. How flat the light falls on a face is left to the caller.
vec3 arriving(int k, vec3 place, vec3 normal, out vec3 toward) \{
	vec4 where = texelFetch(u_lights, ivec2(0, k), 0);
	vec4 cone = texelFetch(u_lights, ivec2(2, k), 0);
	vec4 more = texelFetch(u_lights, ivec2(3, k), 0);
	vec3 source = vec3(where.xy, more.w);
	vec3 toLight = source - place;
	float apart = length(toLight);
	toward = apart > 0.0 ? toLight / apart : vec3(0.0);
	if (normal != vec3(0.0) && dot(normal, toward) <= 0.0) return vec3(0.0);
	float power;
	if (where.z > 0.0) \{
		if (apart >= where.z) return vec3(0.0);
		float away = apart / where.z;
		float ratio = clamp(where.w / where.z, 0.0, 1.0);
		float soft = cone.w * 0.7;
		power = mix(1.0, more.y, smoothstep(ratio * (0.99 - soft), clamp(ratio * (1.01 + soft), 0.0001, 1.0), away));
		if (cone.w != 0.0) power *= 1.0 - smoothstep(1.0 - cone.w, 1.0, away);
	\} else \{
		float away = apart / where.w;
		power = 1.0 / (1.0 + away * away);
	\}
	float level = length(toLight.xy);
	if (cone.z >= -1.0 && level > 0.0 && dot(-toLight.xy / level, cone.xy) < cone.z) return vec3(0.0);
	vec4 tint = texelFetch(u_lights, ivec2(1, k), 0);
	if (tint.w != 0.0 && !reaches(source, place, more.x)) return vec3(0.0);
	return tint.rgb * power;
\}
"

// Step 1: the light that is thrown back to each place of the floor. From the pixel's place,
// u_samples paths set off upwards, in directions spread evenly over the half ball above the
// floor (the whole fan is turned and tilted by a different amount for each pixel). A path runs
// to the first wall or flat surface that stops it and collects the light that point gets
// straight from the sources; then it leaves in a random direction, more likely near the normal
// of the face, and does the same at the next thing it meets, up to u_bounces times. A path that
// meets nothing has left for the sky, and one that comes down to the ground ends there.
//
// What a face does with light is told by how metallic and how smooth it is, as in the material
// of a renderer. All faces are of one brightness, BASE.
//  - A face that is not metallic scatters BASE of its light evenly to all sides, and mirrors
//    a little: PLAIN of what falls straight on it, and more the flatter the light falls.
//  - A metallic face scatters nothing and mirrors BASE of its light. Between 0 and 1 a face is
//    part the one, part the other.
//  - Smoothness is how sharp the mirror is. A face of smoothness 1 mirrors exactly; less
//    spreads the mirrored light around the mirrored direction, up to a quarter turn to every
//    side at 0, which no longer looks like a mirror at all.
// At a face the path goes on as mirrored or as scattered light, by chance in the shares the
// two have. The light the point gets straight from the sources counts by both. A source is a
// point, which an exact mirror would never be found to show; for that the mirror is taken to
// spread by at least LEAST_SPREAD. A flat surface is a face that is neither metallic nor
// smooth.
//
// Because the walls have height, the light they throw back thins out by itself with the
// distance: a lit stretch of wall takes up less of what a place sees the farther away it is. A
// wall without a top would be lit, and throw light back, as high up as the light of a source
// carries. So each wall says up to what height its faces throw light back (the third value of
// its last pixel): above that a path that meets it ends, as if it had left for the sky.
//
// A place on the floor takes the light as something standing there would: from all sides alike.
let BOUNCE_SOURCE = "
uniform float u_far;
uniform int u_samples;
uniform int u_bounces;
const float TURN = 6.28318530718;
const float HALF_TURN = 3.14159265359;
const float GOLDEN = 0.61803399;
// how far off a face a path starts again, so that it does not meet the face it just left
const float NUDGE = 0.05;
const float BASE = 0.8;
const float PLAIN = 0.04;
const float LEAST_SPREAD = 0.1;

// The share of mirrored light that leaves `off` away from the mirrored direction, for a mirror
// that spreads its light by `spread` to every side, both as angles: most in the mirrored
// direction itself, evenly less to nothing at `spread`. All directions together add up to 1.
float mirrored(float off, float spread) \{
	return max(0.0, 1.0 - off / spread) / (TURN * (1.0 - sin(spread) / spread));
\}

// two directions at right angles to n and to each other
void beside(vec3 n, out vec3 s, out vec3 t) \{
	s = normalize(abs(n.z) < 0.9 ? cross(n, vec3(0.0, 0.0, 1.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
	t = cross(n, s);
\}

// the direction `tilt` away from n (an angle), `about` of the way round it (0 to 1)
vec3 tilted(vec3 n, float tilt, float about) \{
	vec3 s;
	vec3 t;
	beside(n, s, t);
	return normalize(n * cos(tilt) + (s * cos(TURN * about) + t * sin(TURN * about)) * sin(tilt));
\}

void main() \{
	vec2 pixel = gl_FragCoord.xy;
	vec3 place = placeOf(pixel);
	uint state = scramble(uint(pixel.x) + scramble(uint(pixel.y)));
	float turned = chance(state);
	float lifted = chance(state);
	vec3 bounced = vec3(0.0);
	for (int s = 0; s < u_samples; s++) \{
		float angle = TURN * (float(s) + turned) / float(u_samples);
		// how steeply the path sets off: every height of the half ball is as likely as another
		float rise = fract(float(s) * GOLDEN + lifted);
		float run = sqrt(1.0 - rise * rise);
		vec3 from = place;
		vec3 along = vec3(cos(angle) * run, sin(angle) * run, rise);
		// what is left of a face's light by the time it has come back along the path
		float carried = 1.0;
		for (int b = 0; b < u_bounces; b++) \{
			vec3 d = along * u_far;
			// the nearest wall that stops the path outright, and the two nearest limited walls
			float best = 2.0;
			int hit = -1;
			float first = 2.0;
			float second = 2.0;
			int firstHit = -1;
			int secondHit = -1;
			for (int i = 0; i < u_wallCount; i++) \{
				float at;
				vec4 candidate;
				int met = meets(from, d, i, from.xy, 0.0, false, at, candidate);
				if (met == 1 && at < best) \{
					best = at;
					hit = i;
				\} else if (met == 2 && at < first) \{
					second = first;
					secondHit = firstHit;
					first = at;
					firstHit = i;
				\} else if (met == 2 && at < second) \{
					second = at;
					secondHit = i;
				\}
			\}
			// the second limited wall stops the path as a normal wall would
			if (second < best) \{
				best = second;
				hit = secondHit;
			\}
			// a flat surface that is nearer than that wall
			bool level = false;
			for (int i = 0; i < u_surfaceCount; i++) \{
				float at;
				if (hitsSurface(from, d, i, at) && at < best) \{
					best = at;
					level = true;
				\}
			\}
			// down on the ground, or off to the sky
			if (d.z < 0.0 && (u_floor - from.z) / d.z < best) break;
			if ((hit < 0 && !level) || best > 1.0) break;
			// the face the path arrived on, and what that face is like
			vec3 normal = vec3(0.0, 0.0, along.z > 0.0 ? -1.0 : 1.0);
			vec2 face = vec2(0.0);
			if (!level) \{
				vec4 wall = texelFetch(u_walls, ivec2(0, hit), 0);
				// higher up than the wall throws light back
				if (from.z + d.z * best > texelFetch(u_walls, ivec2(3, hit), 0).z) break;
				normal = vec3(normalize(vec2(-wall.w, wall.z)), 0.0);
				if (dot(normal, along) > 0.0) normal = -normal;
				vec4 faces = texelFetch(u_walls, ivec2(2, hit), 0);
				face = along.x * wall.w - along.y * wall.z < 0.0 ? faces.xy : faces.zw;
			\}
			// the shares of the light it mirrors and scatters, at the angle the path left it by
			float steep = clamp(-dot(normal, along), 0.0, 1.0);
			float straight = mix(PLAIN, BASE, face.x);
			float shiny = straight + (1.0 - straight) * pow(1.0 - steep, 5.0);
			float matt = BASE * (1.0 - face.x) * (1.0 - shiny);
			float spread = 1.5707963 * (1.0 - face.y) * (1.0 - face.y);
			vec3 mirror = along - 2.0 * dot(along, normal) * normal;
			from = from + d * best + normal * NUDGE;
			for (int k = 0; k < u_lightCount; k++) \{
				vec3 toward;
				vec3 light = arriving(k, from, normal, toward);
				float off = acos(clamp(dot(mirror, toward), -1.0, 1.0));
				bounced += carried * (matt * dot(normal, toward) / HALF_TURN + shiny * mirrored(off, max(spread, LEAST_SPREAD))) * light;
			\}
			if (chance(state) * (shiny + matt) < shiny) \{
				// mirrored: off the mirrored direction more often by little than by much, as
				// `mirrored` has it
				float off = spread * (0.5 - sin(asin(1.0 - 2.0 * chance(state)) / 3.0));
				along = tilted(mirror, off, chance(state));
				// what would leave into the face leaves as far above it
				if (dot(along, normal) < 0.0) along -= 2.0 * dot(along, normal) * normal;
			\} else \{
				// scattered: more often near the normal, as much as the face shows of itself
				along = tilted(normal, asin(sqrt(chance(state))), chance(state));
			\}
			carried *= shiny + matt;
			if (carried <= 0.0) break;
		\}
	\}
	o_color = vec4(stored(TURN * bounced / float(u_samples)), 1.0);
\}
"

// Step 2, run several times: each pixel of u_picture averaged with the pixels u_step and
// 2 * u_step away from it in every direction, the nearer ones counting for more. A pixel on
// the far side of a wall that stands on the floor is left out, so light never seeps through
// such a wall, and so is a pixel whose floor lies at another height: the light on a raised
// floor is not the light on the ground beside it.
let SMOOTH_SOURCE = "
uniform sampler2D u_picture;
uniform int u_step;

float share(int apart) \{
	return apart == 0 ? 0.375 : (apart == 1 ? 0.25 : 0.0625);
\}

// True when the wall lies between the two places. It is hitsWall with the wall half a map unit
// longer at both ends: the pixels lie in a grid, so the line between two of them can run
// exactly through the point where two walls meet, and would count as crossing neither.
bool parts(vec2 from, vec2 to, vec4 wall) \{
	vec2 d = to - from;
	vec2 w = wall.xy - from;
	float den = d.x * wall.w - d.y * wall.z;
	if (den == 0.0) return false;
	float t = (w.x * wall.w - w.y * wall.z) / den;
	float u = (w.x * d.y - w.y * d.x) / den;
	float spare = 0.5 / max(length(wall.zw), 0.001);
	return t >= 0.0 && t <= 1.0 && u >= -spare && u <= 1.0 + spare;
\}

void main() \{
	ivec2 pixel = ivec2(gl_FragCoord.xy);
	vec3 here = placeOf(gl_FragCoord.xy);
	vec2 place = here.xy;
	vec3 sum = vec3(0.0);
	float shares = 0.0;
	for (int j = -2; j <= 2; j++) \{
		for (int i = -2; i <= 2; i++) \{
			ivec2 other = pixel + ivec2(i, j) * u_step;
			if (other.x < 0 || other.y < 0 || other.x >= int(u_size.x) || other.y >= int(u_size.y)) continue;
			vec3 across = placeOf(vec2(other) + 0.5);
			if (abs(across.z - here.z) > 0.5) continue;
			vec2 there = across.xy;
			bool parted = false;
			for (int w = 0; w < u_wallCount; w++) \{
				vec4 stands = texelFetch(u_walls, ivec2(3, w), 0);
				if (here.z < stands.x || here.z > stands.y) continue;
				if (parts(place, there, texelFetch(u_walls, ivec2(0, w), 0))) \{
					parted = true;
					break;
				\}
			\}
			if (parted) continue;
			float part = share(abs(i)) * share(abs(j));
			sum += unstored(texelFetch(u_picture, other, 0).rgb) * part;
			shares += part;
		\}
	\}
	o_color = vec4(stored(sum / shares), 1.0);
\}
"

// Step 3: the light u_picture holds for the pixel, and the light the pixel's place gets
// straight from the sources, but for those that say theirs is left out.
//
// That light ends at sharp edges: where a wall's shadow begins, and where a source's reach
// ends. A pixel that such an edge runs through is neither lit nor dark, so the light is taken
// at u_fine by u_fine places spread evenly over the pixel and averaged; with 1 it is taken at
// the middle of the pixel only, and edges come out in steps.
let SHOW_SOURCE = "
uniform sampler2D u_picture;
uniform int u_fine;

void main() \{
	vec2 pixel = gl_FragCoord.xy;
	vec3 straight = vec3(0.0);
	vec3 toward;
	for (int j = 0; j < u_fine; j++) \{
		for (int i = 0; i < u_fine; i++) \{
			vec3 place = placeOf(pixel + (vec2(float(i), float(j)) + 0.5) / float(u_fine) - 0.5);
			for (int k = 0; k < u_lightCount; k++) \{
				if (texelFetch(u_lights, ivec2(3, k), 0).z != 0.0) continue;
				straight += arriving(k, place, vec3(0.0), toward);
			\}
		\}
	\}
	vec3 light = unstored(texelFetch(u_picture, ivec2(pixel), 0).rgb) + straight / float(u_fine * u_fine);
	vec3 shown = stored(light);
	// less than one step of a pixel's range of noise hides the steps in a slow fade
	uint state = scramble(uint(pixel.x) + scramble(uint(pixel.y) + 977u));
	shown += (chance(state) - 0.5) / 255.0;
	o_color = vec4(shown, 1.0);
\}
"

// test_light_adaptive's light is half as strong this far from it, as a share of the map's
// diagonal.
let HALF_LIGHT = 0.15

// Step 2 of the picture is run at most this many times; each run looks twice as far.
let MOST_SMOOTHING = 6

// Step 3 takes the light straight from the sources at this many places of a pixel's side at most.
let MOST_FINE = 4

// How many pixels a wall, a light source and a flat surface take in the textures.
let WALL_PIXELS = 4
let LIGHT_PIXELS = 4
let FLAT_PIXELS = 2

// Foundry's CONST.EDGE_SENSE_TYPES, which CONST.WALL_MOVEMENT_TYPES takes its two values from.
let SENSE_NONE = 0
let SENSE_NORMAL = 20

// What a flat surface can stop, for flatsOf.
let STOPS_LIGHT = 1
let STOPS_MOVE = 2

var gpuReady = false
var nearestProgram: uint
var coverProgram: uint
var hitsProgram: uint
var bounceProgram: uint
var smoothProgram: uint
var showProgram: uint
var pictureA: uint
var pictureB: uint
var pictureTarget: uint
var wallsTexture: uint
var lightsTexture: uint
var flatsTexture: uint
var floorsTexture: uint
var fullTarget: uint
var entriesTexture: uint
var raysTexture: uint
var resultTexture: uint
var resultTarget: uint

// Frees what the previous call left behind, strings included: the JSON keys and text it parsed
// and the result it returned. The caller runs it before each call, after it has copied the
// previous result. It is a function of its own because the compiler does not allow a
// collection inside a function that holds a string argument.
[export]
def collect
	unsafe
		heap_collect(true, false)

// The objects whose bounding box the ray from ta to tb crosses, then those of them whose wall
// it crosses as well: two JSON arrays, one after the other. The box of a wall stands from the
// wall's bottom to its top, and so does the wall.
[export]
def test(var treeS:string; var ta:float3; var tb:float3) : string
	var inscope scene <- readScene(treeS)
	var inscope entries: array<Entry>
	flatten(scene.tree, entries, false)
	uploadEntries(entries)
	var inscope hits <- castOne(ta, tb - ta, length(entries))
	var inscope o: array<Zobjects>
	var inscope w: array<Zobjects>
	for i, hit in entries, hits
		if hit >= 1
			push_clone(o, i.obj)
		if hit == 2
			push_clone(w, i.obj)
	return sprint_json(o, false) + sprint_json(w, false)

// Returns two rays per wall visible from p, one after the other: from each end of the wall to
// p. Where such a ray would cross another visible wall, that end is hidden, and the ray starts
// from the end of the visible part of the wall instead (see visibleParts and visibleEnd). The
// look is level, at the height of p, and takes in the walls that stand at that height.
[export]
def test_rad_adaptive(var treeS:string; var p:float3) : string
	var inscope sight <- visibleParts(treeS, p)
	var inscope rays: array<Ray>
	for i in sight.parts
		let endA = i.wall.origin + i.wall.dir * i.first
		let endB = i.wall.origin + i.wall.dir * i.last
		push(rays, Ray(dir = p - endA, origin = endA))
		push(rays, Ray(dir = p - endB, origin = endB))
	return sprint_json(rays, false)

// Reads p as a light source. Returns one entry per wall the light reaches: the wall, the two
// rays test_rad_adaptive returns for it, and the corners of the area that wall keeps the light
// from. That area starts at the lit part of the wall and runs away from the light, between the
// two rays continued past the wall, to well outside the map.
//
// With a width and a height above 0 it also draws a picture of the light onto the canvas of
// the WebGL context, that many pixels in size, which the caller has to give the canvas
// beforehand. The picture covers the root cell of the tree and shows how bright each place of
// the floor is, the floor being at the height of p: lit straight from p, and by light that
// walls throw back, followed for up to `bounces` walls along `samples` paths per pixel (see
// BOUNCE_SOURCE). The light has no end: it is 1 bright next to p and a half at HALF_LIGHT of
// the map's diagonal away. Every wall stops it between its bottom and its top, and scatters
// what it throws back (it is neither metallic nor smooth). No flat surface takes part, and the
// picture is not smoothed. The function returns when the picture is drawn.
[export]
def test_light_adaptive(var treeS:string; var p:float3; width:int; height:int; samples:int; bounces:int) : string
	var inscope sight <- visibleParts(treeS, p)
	if width > 0 && height > 0
		let across = length(float2(sight.bounds.max.x - sight.bounds.min.x, sight.bounds.max.y - sight.bounds.min.y))
		var inscope lights: array<float4>
		push(lights, float4(p.x, p.y, 0.0, across * HALF_LIGHT))
		push(lights, float4(1.0, 1.0, 1.0, 1.0))
		push(lights, float4(0.0, 0.0, -2.0, 0.0))
		push(lights, float4(0.0, 0.0, 0.0, p.z))
		var inscope flats: array<float4>
		var inscope floors: array<float4>
		tracePicture(sight.bounds, sight.walls, length(sight.walls) / WALL_PIXELS, lights, 1, flats, floors, width, height, samples, bounces, 0, 1, p.z)
	// corners this far from p are outside the map, and so is every edge between two of them
	// that are at most a quarter turn apart
	let radius = sight.reach * 3.0
	var inscope shadows: array<Shadow>
	for i in sight.parts
		let endA = i.wall.origin + i.wall.dir * i.first
		let endB = i.wall.origin + i.wall.dir * i.last
		var area: array<float3>
		// a light sitting on the wall itself has no direction to cast its shadow in
		if length(endA - p) > 0.001 && length(endB - p) > 0.001
			let toA = normalize(endA - p)
			let toB = normalize(endB - p)
			push(area, endA)
			push(area, endB)
			push(area, p + toB * radius)
			// a corner halfway round keeps the far edge outside the map for a wide shadow
			if length(toA + toB) > 0.001
				push(area, p + normalize(toA + toB) * radius)
			push(area, p + toA * radius)
		var shadow <- Shadow(wall = i.wall, partly = i.first > 0.0 || i.last < 1.0, rayA = Ray(dir = p - endA, origin = endA), rayB = Ray(dir = p - endB, origin = endB), area <- area)
		emplace(shadows, shadow)
	return sprint_json(shadows, false)

// Draws a picture of the light of `count` light sources onto the canvas of the WebGL context,
// width by height pixels over the root cell of the tree; the caller has to give the canvas
// that size beforehand. The picture shows the light on the floor of the map. The ground lies
// level at the height `floor`; where a flat surface that stops movement lies over a place, at
// the height of the ground or above it and below `ceiling`, the highest such surface is the
// floor there (see LIGHT_SOURCE). `lights` points at the first of count * LIGHT_PIXELS float4 that lie
// one after the other in memory, four per source, as LIGHT_SOURCE describes them. Each wall
// acts on the light the way it says, between its bottom and its top (see wallOf and
// LIGHT_SOURCE); walls that do nothing to light are left out. The flat surfaces that stop light
// stop it. Light that walls and surfaces throw back is followed for up to `bounces` of them
// along `samples` paths per pixel, and the noise that leaves is smoothed out in `smoothing`
// runs (0 to MOST_SMOOTHING; 0 leaves it as it is). A wall without a top throws light back up
// to `wallHeight` map units above the floor (or above its own bottom, where that is higher);
// with 0 it does so as high as it is lit. The light that comes straight from the sources is
// taken at `fine` by `fine` places of each pixel, which smooths its edges (1 to MOST_FINE; see
// SHOW_SOURCE). Returns how many sources, walls and triangles of surfaces took part, when the
// picture is drawn.
[export]
def trace_lights(var treeS:string; lights:float4?; count:int; width:int; height:int; samples:int; bounces:int; smoothing:int; wallHeight:float; fine:int; floor:float; ceiling:float) : string
	var inscope scene <- readScene(treeS)
	var inscope entries: array<Entry>
	flatten(scene.tree, entries, false)
	var inscope walls <- wallsOf(entries, true, floor, wallHeight)
	var inscope flats <- flatsOf(scene.flats, STOPS_LIGHT)
	var inscope floors <- floorsOf(scene.flats, floor, ceiling)
	var inscope sources: array<float4>
	for i in range(max(count, 0) * LIGHT_PIXELS)
		unsafe
			push(sources, lights[i])
	let wallCount = length(walls) / WALL_PIXELS
	let flatCount = length(flats) / FLAT_PIXELS
	if width > 0 && height > 0
		tracePicture(scene.tree.bounds, walls, wallCount, sources, max(count, 0), flats, floors, width, height, samples, bounces, smoothing, fine, floor)
	return sprint_json(Traced(lights = max(count, 0), walls = wallCount, surfaces = flatCount), false)

// How much of each of several round targets the walls hide from a round source. source is the
// centre of the source, at the height it looks from; targets points at the first of `count`
// targets that lie one after the other in memory, each the centre of the target on the map (x,
// y), its bottom (z) and its top (w); ds and da are the diameters of the source and of every
// target, in map units. Returns one result per target, in the order of the targets.
//
// A target is an upright cylinder, and what is hidden of it is a share of what the source sees
// of it: its width, between the two lines of sight that just touch it, by its height.
//
// Only walls and flat surfaces that stop movement hide anything, a wall between its bottom and
// its top, and a one-way wall hides only what is looked at from the side it acts from (see
// wallOf).
//
// For each target, the source is looked from at n points, spread evenly along its diameter
// that lies across the line from source to target: the first point is one end of that
// diameter, the n-th the other (n = 1 looks from the first end only). From each point the
// target fills the sector between the two directions that just touch its circle. That sector
// is swept in directions at most 0.05 degrees apart, and in each direction the target is
// looked at at m heights, spread evenly from its bottom to its top (m is 1 to MOST_HEIGHTS; a
// target as high as it is low is looked at at that one height). A ray runs from the point to
// where its direction reaches the circle, at each of those heights, and a ray that a wall or a
// surface stops counts as blocked. The share of blocked rays is how much of the target that
// point cannot see; a target's own figure is the smallest share among its points.
//
// The directions of every point of every target go to the graphics card in one batch.
[export]
def test_cover(var treeS:string; var source:float3; targets:float4?; count:int; ds:float; da:float; n:int; m:int) : string
	var inscope scene <- readScene(treeS)
	var inscope entries: array<Entry>
	flatten(scene.tree, entries, true)
	uploadEntries(entries)
	var inscope flats <- flatsOf(scene.flats, STOPS_MOVE)
	let flatCount = uploadFlats(flats)
	var inscope covers: array<Cover>
	var inscope rays: array<float4>
	for i in range(count)
		var target: float4
		unsafe
			target = targets[i]
		var cover <- coverOf(source, target, ds, da, n, m, rays)
		emplace(covers, cover)
	var inscope masks <- castCover(rays, length(entries), flatCount)
	// the directions were queued point after point, and the answers come back in that order
	var next = 0
	for cover in covers
		var least = 1.0
		for point in cover.points
			for k in range(point.rays / cover.heights)
				let stopped = bitsOf(masks[next], cover.heights)
				let end = float3(rays[next * 2].x + rays[next * 2 + 1].x, rays[next * 2].y + rays[next * 2 + 1].y, cover.target.z)
				next ++
				point.blocked += stopped
				let share = float(stopped) / float(cover.heights)
				// neighbouring directions of which as much is blocked are kept as one run
				let last = length(point.runs) - 1
				if last >= 0 && point.runs[last].share == share
					point.runs[last].to = end
				else
					push(point.runs, CoverRun(blocked = stopped == cover.heights, share = share, from = end, to = end))
			if point.rays > 0
				point.obstructed = float(point.blocked) / float(point.rays)
			least = min(least, point.obstructed)
		cover.obstructed = least
	return sprint_json(covers, false)

// How many of the lowest `count` bits of mask are set.
def bitsOf(mask: int; count: int) : int
	var set = 0
	for bit in range(count)
		if ((mask >> bit) & 1) != 0
			set ++
	return set

// test_cover's preparation for one target: the diameter of the source that lies across the
// line to it, the n points on that diameter, and each point's directions, which are added to
// `rays`.
def coverOf(source: float3; target: float4; ds: float; da: float; n: int; m: int; var rays: array<float4>) : Cover
	var cover: Cover
	cover.target = float3(target.x, target.y, target.z)
	cover.top = target.w
	cover.heights = target.w > target.z ? clamp(m, 1, MOST_HEIGHTS) : 1
	let toTarget = float2(target.x - source.x, target.y - source.y)
	let apart = length(toTarget)
	// with source and target in one place no direction is across; any will do
	let across = apart > 0.001 ? float3(-toTarget.y, toTarget.x, 0.0) / apart : float3(0.0, 1.0, 0.0)
	cover.lineA = source - across * (ds * 0.5)
	cover.lineB = source + across * (ds * 0.5)
	let count = max(n, 1)
	for i in range(count)
		let along = count > 1 ? float(i) / float(count - 1) : 0.0
		var point <- coverFrom(cover.lineA + (cover.lineB - cover.lineA) * along, target, da * 0.5, cover.heights, rays)
		emplace(cover.points, point)
	return <- cover

// coverOf's work for one point p of the source; radius is that of the target circle. The
// point's directions go to the end of `rays`, two float4 each, as COVER_SOURCE reads them, and
// point.rays says how many rays they stand for: `heights` per direction.
def coverFrom(p: float3; target: float4; radius: float; heights: int; var rays: array<float4>) : CoverPoint
	var point: CoverPoint
	point.at = p
	let toward = float2(target.x - p.x, target.y - p.y)
	let apart = length(toward)
	// from inside the target, or on its edge, no direction just touches it: nothing is swept
	if apart <= radius || apart < 0.001
		point.rayA = Ray(dir = float3(toward.x, toward.y, 0.0), origin = p)
		point.rayB = Ray(dir = float3(toward.x, toward.y, 0.0), origin = p)
		return <- point
	let middle = atan2(toward.y, toward.x)
	let half = asin(radius / apart)
	let touch = sqrt(apart * apart - radius * radius)
	point.rayA = Ray(dir = float3(cos(middle - half), sin(middle - half), 0.0) * touch, origin = p)
	point.rayB = Ray(dir = float3(cos(middle + half), sin(middle + half), 0.0) * touch, origin = p)
	// equal steps of at most 0.05 degrees, so that the first and the last direction are the touching ones
	let steps = max(int(ceil(2.0 * half / (0.05 * PI / 180.0))), 1)
	for k in range(steps + 1)
		let offset = 2.0 * half * float(k) / float(steps) - half
		// how far along this direction the target circle begins
		let side = apart * sin(offset)
		let far = apart * cos(offset) - sqrt(max(radius * radius - side * side, 0.0))
		push(rays, float4(p.x, p.y, p.z, target.z))
		push(rays, float4(cos(middle + offset) * far, sin(middle + offset) * far, target.w, float(heights)))
	point.rays = (steps + 1) * heights
	return <- point

// The tree and the flat surfaces in treeS, in the form the rest of the script works on. treeS
// is a JSON object with the nodes of the tree in `nodes`, the place of the root among them in
// `root`, and the flat surfaces in `surfaces`, which may be left out. A surface lies level at
// the height `z`; `light` and `move` are 1 when it stops light and movement; `t` holds the
// triangles that make up its area, six numbers each: the x and y of three corners.
def readScene(treeS: string) : Scene
	var jError: string
	var Jtree = read_json(treeS,jError)
	var inscope Qtree <- from_JV(Jtree,type<Stree>)
	unsafe
		delete Jtree
	var scene: Scene
	scene.tree <- SnToZn(Qtree.nodes[Qtree.root], Qtree)
	for s in Qtree.surfaces
		for k in range(length(s.t) / 6)
			let a = float2(s.t[k * 6], s.t[k * 6 + 1])
			let b = float2(s.t[k * 6 + 2], s.t[k * 6 + 3])
			let c = float2(s.t[k * 6 + 4], s.t[k * 6 + 5])
			push(scene.flats, Flat(one = float4(a.x, a.y, b.x, b.y), two = float4(c.x, c.y, s.z, 0.0), light = s.light != 0, move = s.move != 0))
	return <- scene

// Adds one entry per object of the cell and of the cells below it: a cell's own objects, then
// each of its child cells. With moveOnly, objects whose wall lets movement through are left out.
def flatten(node: Znode; var entries: array<Entry>; moveOnly: bool)
	for i in node.objects
		if !moveOnly || i.move != SENSE_NONE
			push(entries, Entry(cell = node.bounds, obj = i))
	for i in node.nodes
		flatten(i, entries, moveOnly)

// Every wall of the entries once, however many cells store it, as the path tracer takes them:
// WALL_PIXELS float4 per wall (see LIGHT_SOURCE). With asTheySay, each wall acts on light the
// way it says and walls that do nothing to light are left out; without, every wall stops light
// and is neither metallic nor smooth. A wall without a top throws light back up to `rise` above
// `floor`, or above its own bottom where that is higher; with a rise of 0, as high as it goes.
def wallsOf(entries: array<Entry>; asTheySay: bool; floor: float; rise: float) : array<float4>
	var walls: array<float4>
	for i in entries
		if asTheySay && i.obj.light == SENSE_NONE
			continue
		let wall = float4(i.obj.t.origin.x, i.obj.t.origin.y, i.obj.t.dir.x, i.obj.t.dir.y)
		var known = false
		for k in range(length(walls) / WALL_PIXELS)
			if walls[k * WALL_PIXELS] == wall && walls[k * WALL_PIXELS + 3].x == i.obj.bottom && walls[k * WALL_PIXELS + 3].y == i.obj.top
				known = true
				break
		if !known
			let bright = i.obj.top < BIG * 0.5 ? i.obj.top : (rise > 0.0 ? max(i.obj.bottom, floor) + rise : BIG)
			push(walls, wall)
			push(walls, asTheySay ? float4(float(i.obj.light), float(i.obj.dir), i.obj.lightThreshold, 0.0) : float4(float(SENSE_NORMAL), 0.0, 0.0, 0.0))
			push(walls, asTheySay ? float4(i.obj.metallicLeft, i.obj.smoothnessLeft, i.obj.metallicRight, i.obj.smoothnessRight) : float4(0.0, 0.0, 0.0, 0.0))
			push(walls, float4(i.obj.bottom, i.obj.top, bright, 0.0))
	return <- walls

// The flat surfaces that stop one thing (STOPS_LIGHT or STOPS_MOVE), as the shaders take them:
// FLAT_PIXELS float4 per triangle (see hitsSurface).
def flatsOf(flats: array<Flat>; stops: int) : array<float4>
	var data: array<float4>
	for i in flats
		if stops == STOPS_LIGHT ? i.light : i.move
			push(data, i.one)
			push(data, i.two)
	return <- data

// The flat surfaces that are floors above the ground, as the shaders take them (FLAT_PIXELS
// float4 per triangle): those that stop movement and lie above `ground` and below `ceiling`.
def floorsOf(flats: array<Flat>; ground: float; ceiling: float) : array<float4>
	var data: array<float4>
	for i in flats
		if i.move && i.two.z > ground && i.two.z < ceiling
			push(data, i.one)
			push(data, i.two)
	return <- data

// Spins a ray around p in 1 degree steps (360 rays) to find the walls visible from p: each ray
// stops at the first wall it meets, and a wall met by several rays counts once. A ray is long
// enough to reach the farthest corner of the map from p. Then finds the visible part of each
// of those walls. After that, lookCloser sends more rays where that result calls for them,
// and the visible parts are found again if it adds a wall. All of it happens level, at the
// height of p: a wall that does not stand at that height is not there.
def visibleParts(treeS: string; p: float3) : Sight
	var inscope scene <- readScene(treeS)
	var inscope entries: array<Entry>
	flatten(scene.tree, entries, false)
	uploadEntries(entries)
	let far = max(abs(p - scene.tree.bounds.min), abs(scene.tree.bounds.max - p))
	let reach = length(float2(far.x, far.y))
	var inscope walls: array<Zobjects>
	var inscope rays: array<float4>
	for turn in range(360)
		push(rays, rayAlong(p, float(turn), reach))
	lookAlong(rays, p.z, entries, walls)
	var sight: Sight
	sight.reach = reach
	sight.bounds = scene.tree.bounds
	sight.walls <- wallsOf(entries, false, p.z, 0.0)
	sight.parts <- partsOf(p, walls, reach)
	if lookCloser(p, sight.parts, reach, entries, walls)
		delete sight.parts
		sight.parts <- partsOf(p, walls, reach)
	return <- sight

// The ray from p in the given direction, as castRays takes it: origin x and y, then direction
// x and y.
def rayAlong(p: float3; degrees: float; reach: float) : float4
	let angle = degrees * PI / 180.0
	let dir = float3(cos(angle), sin(angle), 0.0) * reach
	return float4(p.x, p.y, dir.x, dir.y)

// Sends the rays and adds the first wall each of them meets to walls, in the order of the
// rays, unless that wall is there already.
def lookAlong(var rays: array<float4>; z: float; entries: array<Entry>; var walls: array<Zobjects>)
	var inscope hits <- castRays(rays, z, length(entries), false)
	for hit in hits
		if hit > 0 && !hasWall(walls, entries[hit - 1].obj)
			push_clone(walls, entries[hit - 1].obj)

// The visible part of each wall in walls, seen from p; a wall with no visible part between its
// ends is left out.
def partsOf(p: float3; walls: array<Zobjects>; reach: float) : array<Seen>
	var parts: array<Seen>
	for i, index in walls, count()
		let first = visibleEnd(p, walls, index, 0.0, reach * 2.0)
		let last = visibleEnd(p, walls, index, 1.0, reach * 2.0)
		if first >= 0.0 && last >= first
			push(parts, Seen(wall = i.t, first = first, last = last))
	return <- parts

// The second pass, which makes the sweep adaptive. Two rays from visible wall ends that are
// less than a degree apart, seen from p, mark a place the sweep was too coarse for, such as a
// narrow gap between two walls. Around the middle between two such rays, one degree to either
// side, this sends a ray every 0.05 degrees and adds the walls those rays meet first. Returns
// true when that added a wall the sweep had missed.
def lookCloser(p: float3; parts: array<Seen>; reach: float; entries: array<Entry>; var walls: array<Zobjects>) : bool
	var inscope angles: array<float>
	for i in parts
		let endA = i.wall.origin + i.wall.dir * i.first
		let endB = i.wall.origin + i.wall.dir * i.last
		push(angles, atan2(endA.y - p.y, endA.x - p.x) * 180.0 / PI)
		push(angles, atan2(endB.y - p.y, endB.x - p.x) * 180.0 / PI)
	if length(angles) < 2
		return false
	sort(angles)
	// closes the circle: the last ray is a neighbour of the first as well
	let again = angles[0] + 360.0
	push(angles, again)
	let before = length(walls)
	// sectors overlap; a direction already looked along is not looked along again
	var covered = -1000.0
	var inscope rays: array<float4>
	for i in range(length(angles) - 1)
		if angles[i + 1] - angles[i] < 1.0
			let middle = (angles[i] + angles[i + 1]) * 0.5
			var at = max(middle - 1.0, covered)
			while at <= middle + 1.0
				push(rays, rayAlong(p, at, reach))
				at += 0.05
			covered = at
	lookAlong(rays, p.z, entries, walls)
	return length(walls) > before

// Where the visible part of walls[own] begins, coming from one of its ends: fromEnd is 0.0 for
// its origin, 1.0 for its far end, and the result is a position along the wall on that scale.
// A point of the wall is visible when the ray from it to p crosses none of the other walls.
// While the ray is blocked, the point steps over the part the blocking wall hides, which ends
// where the line from p past an end of the blocker meets the wall, or where the blocker crosses
// the wall, whichever comes first. Returns -1 when the far side of the wall is reached without
// finding a visible point.
// This runs in the script, not on the graphics card: each step depends on the one before, and
// only the few visible walls take part.
def visibleEnd(p: float3; walls: array<Zobjects>; own: int; fromEnd: float; reach: float) : float
	let wall = walls[own].t
	let wallLength = length(wall.dir)
	if wallLength < 0.001
		return fromEnd
	let side = fromEnd == 0.0 ? 1.0 : -1.0
	var at = fromEnd
	for turn in range(length(walls))
		let point = wall.origin + wall.dir * at
		let sight = Ray(dir = p - point, origin = point)
		var blocker = -1
		for v, index in walls, count()
			// a wall that only touches the point itself, such as one sharing this end, does not block
			if index != own && is_intersecting(sight, v.t) && hitFraction(sight, v.t) > 0.0001
				blocker = index
				break
		if blocker < 0
			return at
		var gain = 2.0
		for corner in range(2)
			let cornerAt = walls[blocker].t.origin + walls[blocker].t.dir * float(corner)
			let edge = Ray(dir = normalize(cornerAt - p) * reach, origin = p)
			if is_intersecting(wall, edge)
				let moved = (hitFraction(wall, edge) - at) * side
				if moved > 0.0 && moved < gain
					gain = moved
		// a blocker that crosses the wall hides it only up to the crossing
		if is_intersecting(wall, walls[blocker].t)
			let moved = (hitFraction(wall, walls[blocker].t) - at) * side
			if moved > 0.0 && moved < gain
				gain = moved
		if gain > 1.0
			return -1.0
		// half a unit further, so that the next ray clears the blocker's end
		at += (gain + 0.5 / wallLength) * side
		if at < 0.0 || at > 1.0
			return -1.0
	return -1.0

// Where r1 crosses r2, seen from above, as a fraction of r1's length: 0 at its origin, 1 at its
// end. Only meaningful for a pair is_intersecting(r1, r2) accepts.
def hitFraction(r1, r2 : Ray) : float
	let w = r2.origin - r1.origin
	let d = r1.dir.x * r2.dir.y - r1.dir.y * r2.dir.x
	return (w.x * r2.dir.y - w.y * r2.dir.x) / d

// True when arr already holds the wall of ob. One wall is stored in every tree cell it
// touches and is crossed by many neighbouring rays, so it turns up many times.
def hasWall(arr: array<Zobjects>; ob: Zobjects) : bool
	for i in arr
		if i.t.origin == ob.t.origin && i.t.dir == ob.t.dir && i.bottom == ob.bottom && i.top == ob.top
			return true
	return false

def is_intersecting(r1, r2 : Ray) : bool
	let w = r2.origin - r1.origin
	let d = r1.dir.x * r2.dir.y - r1.dir.y * r2.dir.x
	if d == 0.0
		return false
	let t = w.x * r2.dir.y - w.y * r2.dir.x
	let u = w.x * r1.dir.y - w.y * r1.dir.x
	if d > 0.0
		return t >= 0.0 && t <= d && u >= 0.0 && u <= d
	return t <= 0.0 && t >= d && u <= 0.0 && u >= d

// --- graphics card -------------------------------------------------------------------------

// Builds the programs and the objects every call reuses, on the first call that needs them.
def gpuInit
	if gpuReady
		return
	nearestProgram = create_shader_program(VERTEX_SOURCE, COMMON_SOURCE + NEAREST_SOURCE)
	coverProgram = create_shader_program(VERTEX_SOURCE, COMMON_SOURCE + COVER_SOURCE)
	hitsProgram = create_shader_program(VERTEX_SOURCE, COMMON_SOURCE + HITS_SOURCE)
	bounceProgram = create_shader_program(VERTEX_SOURCE, COMMON_SOURCE + LIGHT_SOURCE + BOUNCE_SOURCE)
	smoothProgram = create_shader_program(VERTEX_SOURCE, COMMON_SOURCE + LIGHT_SOURCE + SMOOTH_SOURCE)
	showProgram = create_shader_program(VERTEX_SOURCE, COMMON_SOURCE + LIGHT_SOURCE + SHOW_SOURCE)
	glGenVertexArrays(1, safe_addr(fullTarget))
	entriesTexture = dataTexture()
	raysTexture = dataTexture()
	resultTexture = dataTexture()
	wallsTexture = dataTexture()
	lightsTexture = dataTexture()
	flatsTexture = dataTexture()
	floorsTexture = dataTexture()
	pictureA = dataTexture()
	pictureB = dataTexture()
	glGenFramebuffers(1, safe_addr(pictureTarget))
	glGenFramebuffers(1, safe_addr(resultTarget))
	gpuReady = true

// A texture that is read value by value, never blended between neighbours.
def dataTexture : uint
	var texture: uint
	glGenTextures(1, safe_addr(texture))
	glBindTexture(GL_TEXTURE_2D, texture)
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, int(GL_NEAREST))
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, int(GL_NEAREST))
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, int(GL_CLAMP_TO_EDGE))
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, int(GL_CLAMP_TO_EDGE))
	return texture

// Fills a texture with four floats per pixel.
def uploadFloats(texture: uint; width, height: int; var data: array<float4>)
	glBindTexture(GL_TEXTURE_2D, texture)
	unsafe
		glTexImage2D(GL_TEXTURE_2D, 0, int(GL_RGBA32F), width, height, 0, GL_RGBA, GL_FLOAT, addr(data[0]))

// The entries as a texture four pixels wide and one row per entry: the cell's box (min x,
// min y, max x, max y), the object's box in the same form, its wall (origin x, origin y,
// direction x, direction y), and the wall's EDGE_DIRECTIONS value with its bottom and its
// top. It stays on texture unit 0 for the draw calls of this call.
def uploadEntries(entries: array<Entry>)
	gpuInit()
	var inscope data: array<float4>
	for i in entries
		push(data, float4(i.cell.min.x, i.cell.min.y, i.cell.max.x, i.cell.max.y))
		push(data, float4(i.obj.r.min.x, i.obj.r.min.y, i.obj.r.max.x, i.obj.r.max.y))
		push(data, float4(i.obj.t.origin.x, i.obj.t.origin.y, i.obj.t.dir.x, i.obj.t.dir.y))
		push(data, float4(float(i.obj.dir), i.obj.bottom, i.obj.top, 0.0))
	// a tree without objects still needs a texture to bind
	if empty(data)
		resize(data, 4)
	glActiveTexture(GL_TEXTURE0)
	uploadFloats(entriesTexture, 4, length(data) / 4, data)

// The flat surfaces as a texture FLAT_PIXELS wide and one row per triangle (see flatsOf). It
// stays on texture unit 6 for the draw calls of this call. Returns how many triangles there are.
def uploadFlats(var data: array<float4>) : int
	gpuInit()
	let count = length(data) / FLAT_PIXELS
	// a map without surfaces still needs a texture to bind
	if empty(data)
		resize(data, FLAT_PIXELS)
	glActiveTexture(GL_TEXTURE6)
	uploadFloats(flatsTexture, FLAT_PIXELS, length(data) / FLAT_PIXELS, data)
	return count

// Draws once into a target of the given size with the program in use and reads back four
// bytes per pixel.
def drawAndRead(width, height: int; var pixels: array<uint8>)
	resize(pixels, width * height * 4)
	glActiveTexture(GL_TEXTURE2)
	glBindTexture(GL_TEXTURE_2D, resultTexture)
	glTexImage2D(GL_TEXTURE_2D, 0, int(GL_RGBA8), width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, null)
	glBindFramebuffer(GL_FRAMEBUFFER, resultTarget)
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, resultTexture, 0)
	glViewport(0, 0, width, height)
	glBindVertexArray(fullTarget)
	glDrawArrays(GL_TRIANGLES, 0, 3)
	unsafe
		glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, addr(pixels[0]))
	glBindFramebuffer(GL_FRAMEBUFFER, 0u)

// The numbers a draw call wrote, one per pixel in its first three bytes, for the first `count`
// pixels.
def numbersOf(pixels: array<uint8>; count: int) : array<int>
	var numbers: array<int>
	resize(numbers, count)
	for i in range(count)
		numbers[i] = int(pixels[i * 4]) + int(pixels[i * 4 + 1]) * 256 + int(pixels[i * 4 + 2]) * 65536
	return <- numbers

// Tests every ray against every entry in one draw call. A ray is origin x and y, then
// direction x and y; all of them lie level at the height z. Returns, per ray, the number of
// the entry whose wall the ray meets first, counted from 1, or 0 when it meets none. With
// oneWay, a one-way wall is met only from the side it acts from.
def castRays(var rays: array<float4>; z: float; entryCount: int; oneWay: bool) : array<int>
	let count = length(rays)
	if count == 0
		var none: array<int>
		return <- none
	// whole rows; the rays added to fill the last one have no length and meet nothing
	let height = (count + BATCH_WIDTH - 1) / BATCH_WIDTH
	resize(rays, height * BATCH_WIDTH)
	glUseProgram(nearestProgram)
	glActiveTexture(GL_TEXTURE1)
	uploadFloats(raysTexture, BATCH_WIDTH, height, rays)
	glUniform1i(glGetUniformLocation(nearestProgram, "u_entries"), 0)
	glUniform1i(glGetUniformLocation(nearestProgram, "u_rays"), 1)
	glUniform1i(glGetUniformLocation(nearestProgram, "u_count"), entryCount)
	glUniform1f(glGetUniformLocation(nearestProgram, "u_z"), z)
	glUniform1i(glGetUniformLocation(nearestProgram, "u_oneWay"), oneWay ? 1 : 0)
	var inscope pixels: array<uint8>
	drawAndRead(BATCH_WIDTH, height, pixels)
	resize(rays, count)
	return <- numbersOf(pixels, count)

// Tests every direction of test_cover against every entry and every flat surface in one draw
// call. A direction is two float4, as COVER_SOURCE reads them. Returns, per direction, one bit
// per height the target is looked at, set when the ray to that height is stopped.
def castCover(var rays: array<float4>; entryCount: int; flatCount: int) : array<int>
	let count = length(rays) / 2
	if count == 0
		var none: array<int>
		return <- none
	// whole rows; the directions added to fill the last one look at no height at all
	let height = (count + BATCH_WIDTH - 1) / BATCH_WIDTH
	resize(rays, height * BATCH_WIDTH * 2)
	glUseProgram(coverProgram)
	glActiveTexture(GL_TEXTURE1)
	uploadFloats(raysTexture, BATCH_WIDTH * 2, height, rays)
	glUniform1i(glGetUniformLocation(coverProgram, "u_entries"), 0)
	glUniform1i(glGetUniformLocation(coverProgram, "u_rays"), 1)
	glUniform1i(glGetUniformLocation(coverProgram, "u_count"), entryCount)
	glUniform1i(glGetUniformLocation(coverProgram, "u_surfaces"), 6)
	glUniform1i(glGetUniformLocation(coverProgram, "u_surfaceCount"), flatCount)
	var inscope pixels: array<uint8>
	drawAndRead(BATCH_WIDTH, height, pixels)
	resize(rays, count * 2)
	return <- numbersOf(pixels, count)

// Draws the picture of the light of the sources onto the canvas, width by height pixels over
// `area`, in the three steps LIGHT_SOURCE describes. walls, lights and flats are as the shaders
// read them; the first wallCount walls and lightCount sources take part, and every triangle of
// flats. The light that is thrown back is drawn into one of two textures the size of the
// picture, smoothed from one into the other `smoothing` times, and the last of them goes into
// the picture on the canvas. The ground lies at the height `floor`, the triangles of `floors`
// are the floors above it (as flatsOf lists surfaces), and the light straight from the sources
// is taken at fine by fine places of each pixel.
def tracePicture(area: AABB; var walls: array<float4>; wallCount: int; var lights: array<float4>; lightCount: int; var flats: array<float4>; var floors: array<float4>; width, height, samples, bounces, smoothing, fine: int; floor: float)
	gpuInit()
	// a texture needs something to hold even when there is no wall or no source
	if empty(walls)
		resize(walls, WALL_PIXELS)
	if empty(lights)
		resize(lights, LIGHT_PIXELS)
	glActiveTexture(GL_TEXTURE3)
	uploadFloats(wallsTexture, WALL_PIXELS, length(walls) / WALL_PIXELS, walls)
	glActiveTexture(GL_TEXTURE4)
	uploadFloats(lightsTexture, LIGHT_PIXELS, length(lights) / LIGHT_PIXELS, lights)
	let flatCount = uploadFlats(flats)
	let floorCount = length(floors) / FLAT_PIXELS
	if empty(floors)
		resize(floors, FLAT_PIXELS)
	glActiveTexture(GL_TEXTURE7)
	uploadFloats(floorsTexture, FLAT_PIXELS, length(floors) / FLAT_PIXELS, floors)
	glActiveTexture(GL_TEXTURE5)
	for picture in [[uint pictureA; pictureB]]
		glBindTexture(GL_TEXTURE_2D, picture)
		glTexImage2D(GL_TEXTURE_2D, 0, int(GL_RGBA8), width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, null)
	glViewport(0, 0, width, height)
	glBindVertexArray(fullTarget)
	glBindFramebuffer(GL_FRAMEBUFFER, pictureTarget)
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, pictureA, 0)
	// the texture that holds the light thrown back so far, and the one the next step draws into
	var held = pictureA
	var next = pictureB
	if bounces > 0
		let across = length(float2(area.max.x - area.min.x, area.max.y - area.min.y))
		lightProgram(bounceProgram, area, wallCount, lightCount, flatCount, floorCount, width, height, floor)
		// long enough to leave the map from anywhere on it
		glUniform1f(glGetUniformLocation(bounceProgram, "u_far"), across * 2.0)
		glUniform1i(glGetUniformLocation(bounceProgram, "u_samples"), clamp(samples, 1, 1024))
		glUniform1i(glGetUniformLocation(bounceProgram, "u_bounces"), clamp(bounces, 0, 16))
		glDrawArrays(GL_TRIANGLES, 0, 3)
		lightProgram(smoothProgram, area, wallCount, lightCount, flatCount, floorCount, width, height, floor)
		glUniform1i(glGetUniformLocation(smoothProgram, "u_picture"), 5)
		for run in range(clamp(smoothing, 0, MOST_SMOOTHING))
			glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, next, 0)
			glBindTexture(GL_TEXTURE_2D, held)
			glUniform1i(glGetUniformLocation(smoothProgram, "u_step"), 1 << run)
			glDrawArrays(GL_TRIANGLES, 0, 3)
			swap(held, next)
	else
		// nothing is thrown back
		glClearColor(0.0, 0.0, 0.0, 1.0)
		glClear(GL_COLOR_BUFFER_BIT)
	glBindFramebuffer(GL_FRAMEBUFFER, 0u)
	lightProgram(showProgram, area, wallCount, lightCount, flatCount, floorCount, width, height, floor)
	glBindTexture(GL_TEXTURE_2D, held)
	glUniform1i(glGetUniformLocation(showProgram, "u_picture"), 5)
	glUniform1i(glGetUniformLocation(showProgram, "u_fine"), clamp(fine, 1, MOST_FINE))
	glDrawArrays(GL_TRIANGLES, 0, 3)
	// reading a pixel back makes the call wait until the picture is drawn
	var inscope done: array<uint8>
	resize(done, 4)
	unsafe
		glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, addr(done[0]))

// Makes one of the three programs of the picture the one in use and tells it what LIGHT_SOURCE
// needs to know: where the walls, the light sources, the flat surfaces and the floors are, what
// the picture covers and how high the ground lies. The texture of the picture stays the active
// one.
def lightProgram(program: uint; area: AABB; wallCount, lightCount, flatCount, floorCount, width, height: int; floor: float)
	glUseProgram(program)
	glUniform1i(glGetUniformLocation(program, "u_walls"), 3)
	glUniform1i(glGetUniformLocation(program, "u_wallCount"), wallCount)
	glUniform1i(glGetUniformLocation(program, "u_lights"), 4)
	glUniform1i(glGetUniformLocation(program, "u_lightCount"), lightCount)
	glUniform1i(glGetUniformLocation(program, "u_surfaces"), 6)
	glUniform1i(glGetUniformLocation(program, "u_surfaceCount"), flatCount)
	glUniform1i(glGetUniformLocation(program, "u_floors"), 7)
	glUniform1i(glGetUniformLocation(program, "u_floorCount"), floorCount)
	glUniform4f(glGetUniformLocation(program, "u_area"), area.min.x, area.min.y, area.max.x, area.max.y)
	glUniform2f(glGetUniformLocation(program, "u_size"), float(width), float(height))
	glUniform1f(glGetUniformLocation(program, "u_floor"), floor)

// Tests one ray against every entry in one draw call. Returns, per entry, 1 when the ray
// crosses its cell and its box, 2 when it crosses its wall as well, and 0 otherwise.
def castOne(origin: float3; dir: float3; entryCount: int) : array<int>
	var hits: array<int>
	if entryCount == 0
		return <- hits
	let height = (entryCount + BATCH_WIDTH - 1) / BATCH_WIDTH
	glUseProgram(hitsProgram)
	glUniform1i(glGetUniformLocation(hitsProgram, "u_entries"), 0)
	glUniform1i(glGetUniformLocation(hitsProgram, "u_count"), entryCount)
	glUniform1i(glGetUniformLocation(hitsProgram, "u_width"), BATCH_WIDTH)
	glUniform3f(glGetUniformLocation(hitsProgram, "u_origin"), origin.x, origin.y, origin.z)
	glUniform3f(glGetUniformLocation(hitsProgram, "u_dir"), dir.x, dir.y, dir.z)
	var inscope pixels: array<uint8>
	drawAndRead(BATCH_WIDTH, height, pixels)
	resize(hits, entryCount)
	for i in range(entryCount)
		hits[i] = int(pixels[i * 4 + 1]) > 127 ? 2 : (int(pixels[i * 4]) > 127 ? 1 : 0)
	return <- hits

// --- the tree ------------------------------------------------------------------------------

def SnToZn(var Sn; var Tr: Stree)
	var obj: array<Zobjects>
	for i in Sn.objects
		push(obj, SoToZo(i))
	var mi: float3
	var ma: float3
	unsafe
		mi = float3(Sn.bounds["x"], Sn.bounds["y"], -BIG)
		ma = float3(Sn.bounds["x"] + Sn.bounds["width"], Sn.bounds["y"] + Sn.bounds["height"], BIG)
	var bou = AABB(min = mi, max = ma)
	var nod: array<Znode>
	for j in Sn.nodes
		// moved in, not cloned: a clone would leave the original behind with nothing to free it
		var child <- SnToZn(Tr.nodes[j], Tr)
		emplace(nod, child)
	var o <- Znode(objects <- obj, bounds <- bou, nodes <- nod)
	return <- o

def SoToZo(var So)
	var a: float3
	var b: float3
	var a1: float
	var a2: float
	var b1: float
	var b2: float
	unsafe
		a1 = float(So.t["a"]["x"])
		a2 = float(So.t["a"]["y"])
		b1 = float(So.t["b"]["x"])
		b2 = float(So.t["b"]["y"])
		a = float3(a1, a2, 0)
		b = float3(b1, b2, 0)
	var ot = Ray(dir = b-a, origin = a)
	var mi: float3
	var ma: float3
	unsafe
		mi = float3(So.r["x"], So.r["y"], 0.0)
		ma = float3(float(So.r["x"]) + max(float(So.r["width"]), 0.001), float(So.r["y"]) + max(float(So.r["height"]), 0.001), 0.0)
	var orr = AABB(min = mi, max = ma)
	var o <- Zobjects(t = ot, r = orr)
	wallOf(o, So.w)
	// the box of a wall stands as high as the wall
	o.r.min.z = o.bottom
	o.r.max.z = o.top
	return <- o

// Takes over how a wall acts from `w` of its object in the tree: what Foundry's Edge of the
// wall has as move, light and direction, and its threshold for light in map units (an open
// door has move and light 0 there), then how metallic and how smooth its left and its right
// face are, 0 to 1 each (see LIGHT_SOURCE for which face is which and BOUNCE_SOURCE for what
// they do), then its bottom and its top, as heights in map units. An object without `w`, or
// without one of these, is a wall that stops movement and light from both sides, is neither
// metallic nor smooth, and is as high and as deep as the map goes.
def wallOf(var wall: Zobjects; w: table<string; float>)
	wall.move = int(w?["move"] ?? float(SENSE_NORMAL))
	wall.light = int(w?["light"] ?? float(SENSE_NORMAL))
	wall.dir = int(w?["dir"] ?? 0.0)
	wall.lightThreshold = w?["lightThreshold"] ?? 0.0
	wall.metallicLeft = clamp(w?["metallicLeft"] ?? 0.0, 0.0, 1.0)
	wall.smoothnessLeft = clamp(w?["smoothnessLeft"] ?? 0.0, 0.0, 1.0)
	wall.metallicRight = clamp(w?["metallicRight"] ?? 0.0, 0.0, 1.0)
	wall.smoothnessRight = clamp(w?["smoothnessRight"] ?? 0.0, 0.0, 1.0)
	wall.bottom = clamp(w?["bottom"] ?? -BIG, -BIG, BIG)
	wall.top = clamp(w?["top"] ?? BIG, -BIG, BIG)

struct Sobjects
	n: int
	t: table<string, table<string; int >>
	r: table<string, int >
	w: table<string; float>

struct Snode
	objects: array<Sobjects>
	bounds: table<string; int >
	nodes: array<int >

// One flat surface as the JSON text has it (see readScene).
struct Ssurface
	z: float
	light: int
	move: int
	t: array<float>

struct Stree
	root: int
	nodes: array<Snode>
	surfaces: array<Ssurface>

// One triangle of a flat surface, as hitsSurface reads it, and what the surface stops.
struct Flat
	one: float4
	two: float4
	light: bool
	move: bool

// What readScene makes of the JSON text: the tree of the walls, and every triangle of the flat
// surfaces.
struct Scene
	tree: Znode
	flats: array<Flat>

// One object of one cell: what a ray has to cross to count as hitting it there.
struct Entry
	cell: AABB
	obj: Zobjects

// One wall visible from a point, and the part of it that is visible: first and last are
// positions along the wall, 0 at its origin and 1 at its far end.
struct Seen
	wall: Ray
	first: float
	last: float

// What visibleParts found, how far the map reaches from the point it looked from, the root
// cell of the tree, and every wall of the tree once, as wallsOf lists them.
struct Sight
	reach: float
	parts: array<Seen>
	bounds: AABB
	walls: array<float4>

// One entry of test_light_adaptive's result.
struct Shadow
	wall: Ray
	partly: bool
	rayA: Ray
	rayB: Ray
	area: array<float3>

// A stretch of neighbouring directions of test_cover of which equally much is blocked: `share`
// of the rays of each, from none (0) to all of them (1, for which `blocked` is set). from and
// to are where its first and its last direction meet the target circle.
struct CoverRun
	blocked: bool
	share: float
	from: float3
	to: float3

// test_cover's result for one point of the source: the point, the two rays that just touch the
// target on the map, how many rays were sent between them, how many of those were stopped,
// that share, and the runs the directions fall into.
struct CoverPoint
	at: float3
	rayA: Ray
	rayB: Ray
	rays: int
	blocked: int
	obstructed: float
	runs: array<CoverRun>

// What test_cover returns for one target: its centre at its bottom, its top, at how many
// heights it was looked at, the ends of the source's diameter that lies across the line to it,
// the smallest share of the target any of the points cannot see, and each point's result.
struct Cover
	target: float3
	top: float
	heights: int
	lineA: float3
	lineB: float3
	obstructed: float
	points: array<CoverPoint>

// What trace_lights returns: how many light sources, walls and triangles of flat surfaces took
// part.
struct Traced
	lights: int
	walls: int
	surfaces: int

// One wall as one cell stores it: the wall, its bounding box, and how it acts (see wallOf).
struct Zobjects
	t: Ray
	r: AABB
	move: int
	light: int
	dir: int
	lightThreshold: float
	metallicLeft: float
	smoothnessLeft: float
	metallicRight: float
	smoothnessRight: float
	bottom: float
	top: float

struct Znode
	objects: array<Zobjects>
	bounds: AABB
	nodes: array<Znode>
