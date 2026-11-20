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

// The functions of test_local.das, with the same inputs and the same results, where every test
// of a ray against the walls runs on the graphics card through WebGL 2.
//
// How the work is split:
//  - The tree is flattened into a list of entries, one per object of every cell, in the order
//    test_local.das walks them. The list is uploaded as a texture (see uploadEntries).
//  - The rays of one step are uploaded as a second texture, and one draw call tests every ray
//    against every entry: a fragment shader runs once per ray and writes the entry whose wall
//    that ray meets first (see castRays). test() has one ray only, so there the shader runs
//    once per entry and writes whether the ray crosses its box and its wall (see castOne).
//  - What comes back is read with glReadPixels. Everything that is not a ray-against-walls
//    test stays in this script: reading the tree, choosing the rays, trimming walls to their
//    visible part (visibleEnd), and putting the results together.
//
//
// Two things have no twin in test_local.das. test_light_adaptive can also draw a picture of the
// light, found by path tracing, onto the canvas of the WebGL context, and trace_lights draws
// such a picture for any number of light sources (see tracePicture). That picture never leaves
// the graphics card.
//
// A wall may say how it acts on what meets it (see wallOf). test_cover counts the walls that
// stop movement only, and trace_lights follows what each wall does to light and how each of
// its faces throws it back. Every other function works on every wall of the tree, whatever it
// says.
//
// WebGL has no way to create a context from inside the library, so the caller does it: before
// the first call, JavaScript creates a WebGL 2 context on a canvas and makes it current for
// this module (see test_local_gpu_api.js). Without a current context every function here fails.

// Rays are laid out in rows of this many, one pixel per ray.
let BATCH_WIDTH = 1024

// Vertex stage of both programs: one triangle that covers the whole target, so that the
// fragment stage runs once per pixel.
let VERTEX_SOURCE = "#version 300 es
void main() \{
	vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
\}
"

// What both fragment stages share: the entries, and the three tests of test_local.das written
// the way that script and daslib/math_boost compute them, so that both give the same answers.
//  hitsBox  = is_intersecting(Ray, AABB, 0.0, 1.0) of math_boost (every box is 0.002 high)
//  hitsWall = is_intersecting(Ray, Ray) of test_local.das, and its hitFraction in `at`
let COMMON_SOURCE = "#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_entries;
uniform int u_count;
out vec4 o_color;
const float FLAT = 0.001;

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

bool hitsBox(vec3 o, vec3 d, vec4 box) \{
	float tmin = 0.0;
	float tmax = 1.0;
	if (!slab(o.x, d.x, box.x, box.z, tmin, tmax)) return false;
	if (!slab(o.y, d.y, box.y, box.w, tmin, tmax)) return false;
	if (!slab(o.z, d.z, -FLAT, FLAT, tmin, tmax)) return false;
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

// 1 when the ray crosses the cell and the box of entry i, 2 when it crosses its wall as well
int hitsEntry(vec3 o, vec3 d, int i, out float at) \{
	at = 0.0;
	if (!hitsBox(o, d, texelFetch(u_entries, ivec2(0, i), 0))) return 0;
	if (!hitsBox(o, d, texelFetch(u_entries, ivec2(1, i), 0))) return 0;
	return hitsWall(o, d, texelFetch(u_entries, ivec2(2, i), 0), at) ? 2 : 1;
\}
"

// One pixel per ray: the number of the entry whose wall the ray meets first, counted from 1,
// in the first three bytes; 0 when it meets none. Of two walls met equally early the earlier
// entry wins, as in lookAlong of test_local.das. With u_oneWay set, a one-way wall crossed
// from the side it does not act from is not met.
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

// The picture of the light: one pixel per place on the map, as bright as the light that gets
// there, in the color of that light. Light arrives straight from the sources, and after
// bouncing off walls. A face of a wall scatters light to all sides, mirrors it, or does some
// of each (see BOUNCE_SOURCE).
//
// It is drawn in three steps, each a program of its own (see tracePicture):
//  1. BOUNCE_SOURCE finds the light the walls throw back, by path tracing. It is noisy: each
//     pixel follows a handful of random paths.
//  2. SMOOTH_SOURCE takes the noise out by averaging each pixel with pixels around it, several
//     times over, each time looking twice as far. It never averages across a wall.
//  3. SHOW_SOURCE adds the light that comes straight from the sources, which needs no
//     smoothing, and writes the picture.
//
// LIGHT_SOURCE is what the three share. A wall is three pixels of u_walls: its origin and
// direction, then how it acts on light, the way Foundry's ClockwiseSweepPolygon reads an Edge:
//  - x, its EDGE_SENSE_TYPES value. A normal wall (20) stops light. A limited wall (10) stops
//    light that has crossed another limited wall on the same straight run. A proximity wall
//    (30) lets light through that sets off nearer to it than its threshold, a distance wall
//    (40) light that sets off farther away. Walls that do nothing to light are not in the list.
//  - y, its EDGE_DIRECTIONS value (see letsThrough);
//  - z, its threshold for light in map units; a proximity or distance wall without one acts
//    as a normal wall;
// and last what its two faces are like: x and y say how metallic and how smooth its left face
// is, z and w the same for its right face, each from 0 to 1 (see BOUNCE_SOURCE for what they
// do). Left and right are the sides EDGE_DIRECTIONS names: the left face is the one a wall of
// direction "left" acts on.
// Light on its last run to a place sets off at its source. Along a path, a run is followed
// from the place it arrives at, and for the thresholds it counts as setting off there.
//
// A light source is four pixels of u_lights:
//  - x, y, then its reach and the reach of its bright light. Inside the bright reach it is 1
//    bright, outside as bright as its dim light is (below), and nothing beyond its reach; the
//    two steps are smoothed as Foundry's lighting shaders do it. A reach of 0 or less marks a
//    source without an end instead, which is 1 bright next to it and a half at the fourth
//    value away;
//  - its color, and 1 when walls act on it (0: it shines through every wall);
//  - the direction of the middle of its cone (x, y) and the cosine of half the cone's angle
//    (below -1: it shines all round), then how much the steps are smoothed, 0 to 1;
//  - its own radius, which Foundry adds to its distance from a proximity or distance wall
//    (Edge#applyThreshold), then how much light its dim light is, bright light being 1, then
//    1 for a source whose light is in the picture only as far as walls throw it back: what
//    comes straight from it is left out, for someone else to draw.
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
const float GAMMA = 2.2;
const float LIMITED = 10.0;
const float PROXIMITY = 30.0;

// the place on the map a pixel of the picture shows; the picture has its first row at the
// bottom, the map has it at the top
vec2 placeOf(vec2 pixel) \{
	return vec2(mix(u_area.x, u_area.z, pixel.x / u_size.x), mix(u_area.w, u_area.y, pixel.y / u_size.y));
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

// how far p is from the nearest point of the wall
float offWall(vec2 p, vec4 wall) \{
	vec2 v = p - wall.xy;
	float along = clamp(dot(v, wall.zw) / max(dot(wall.zw, wall.zw), 0.000001), 0.0, 1.0);
	return length(v - wall.zw * along);
\}

// What wall i does to light on the run from o over d: 0 when the run does not cross it or the
// wall lets the light through, 1 when it stops the light, 2 when it is a limited wall. The
// light set off at `source`, which was `margin` in radius; `forward` is false when the light
// runs from the end of the run to its start.
int meets(vec2 o, vec2 d, int i, vec2 source, float margin, bool forward, out float at, out vec4 wall) \{
	wall = texelFetch(u_walls, ivec2(0, i), 0);
	if (!hitsWall(vec3(o, 0.0), vec3(d, 0.0), wall, at)) return 0;
	vec4 acts = texelFetch(u_walls, ivec2(1, i), 0);
	if (letsThrough(forward ? d : -d, wall, acts.y)) return 0;
	if (acts.x >= PROXIMITY && acts.z > 0.0) \{
		float apart = offWall(source, wall);
		if (acts.x == PROXIMITY ? max(apart - margin, 0.0) < acts.z : apart + margin > acts.z) return 0;
	\}
	return acts.x == LIMITED ? 2 : 1;
\}

// true when the light of a source at `from`, `margin` in radius, gets to `to`
bool reaches(vec2 from, vec2 to, float margin) \{
	bool clear = true;
	int limited = 0;
	for (int i = 0; i < u_wallCount; i++) \{
		float at;
		vec4 wall;
		int met = meets(from, to - from, i, from, margin, true, at, wall);
		if (met == 2) limited++;
		if (met == 1 || limited > 1) \{
			clear = false;
			break;
		\}
	\}
	return clear;
\}

// The light source k sends straight to a place, and in `toward` the direction from the place
// to the source. A place on a wall has the normal of the face it lies on, and gets nothing
// from a source behind that face; a place on the open map has none (0, 0). How flat the light
// falls on a face is left to the caller.
vec3 arriving(int k, vec2 place, vec2 normal, out vec2 toward) \{
	vec4 where = texelFetch(u_lights, ivec2(0, k), 0);
	vec2 toLight = where.xy - place;
	float apart = length(toLight);
	toward = apart > 0.0 ? toLight / apart : vec2(0.0);
	if (normal != vec2(0.0) && dot(normal, toward) <= 0.0) return vec3(0.0);
	vec4 cone = texelFetch(u_lights, ivec2(2, k), 0);
	vec4 more = texelFetch(u_lights, ivec2(3, k), 0);
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
	if (cone.z >= -1.0 && apart > 0.0 && dot(-toLight / apart, cone.xy) < cone.z) return vec3(0.0);
	vec4 tint = texelFetch(u_lights, ivec2(1, k), 0);
	if (tint.w != 0.0 && !reaches(where.xy, place, more.x)) return vec3(0.0);
	return tint.rgb * power;
\}
"

// Step 1: the light the walls throw back to each place. From the pixel's place, u_samples paths
// set off in evenly spread directions (the whole fan is turned by a different amount for each
// pixel). A path runs to the first wall that stops it and collects the light that wall point
// gets straight from the sources; then it leaves in a random direction, more likely near the
// wall's normal, and does the same at the next wall, up to u_bounces walls.
//
// What a face does with light is told by how metallic and how smooth it is, as in the material
// of a renderer. All faces are of one brightness, BASE.
//  - A face that is not metallic scatters BASE of its light evenly to all sides, and mirrors
//    a little: PLAIN of what falls straight on it, and more the flatter the light falls.
//  - A metallic face scatters nothing and mirrors BASE of its light. Between 0 and 1 a face is
//    part the one, part the other.
//  - Smoothness is how sharp the mirror is. A face of smoothness 1 mirrors exactly; less
//    spreads the mirrored light around the mirrored direction, up to a quarter turn to either
//    side at 0, which no longer looks like a mirror at all.
// At a wall the path goes on as mirrored or as scattered light, by chance in the shares the
// two have. The light the wall point gets straight from the sources counts by both. A source
// is a point, which an exact mirror would never be found to show; for that the mirror is
// taken to spread by at least LEAST_SPREAD.
//
// The map is flat, but the walls on it stand u_height high, and the light a wall throws back
// spreads upwards as well as along the floor. On a flat map none of it would ever be lost, and
// one lit wall would light the floor from one end of the map to the other. `kept` is the share
// that stays near the floor on a run of a given length: all of it next to the wall, a half at
// one wall height away, and less with the square of the distance from there on. A height of 0
// stands for a flat map, where all of it is kept.
let BOUNCE_SOURCE = "
uniform float u_far;
uniform int u_samples;
uniform int u_bounces;
uniform float u_height;
const float TURN = 6.28318530718;
// how far off a wall a path starts again, so that it does not meet the wall it just left
const float NUDGE = 0.05;
const float BASE = 0.8;
const float PLAIN = 0.04;
const float LEAST_SPREAD = 0.1;

// The share of mirrored light that leaves `off` away from the mirrored direction, for a mirror
// that spreads its light by `spread` to either side, both as angles: most in the mirrored
// direction itself, evenly less to nothing at `spread`.
float mirrored(float off, float spread) \{
	return max(0.0, 1.0 - abs(off) / spread) / spread;
\}

float kept(float run) \{
	if (u_height <= 0.0) return 1.0;
	float heights = run / u_height;
	return 1.0 / (1.0 + heights * heights);
\}

void main() \{
	vec2 pixel = gl_FragCoord.xy;
	vec2 place = placeOf(pixel);
	uint state = scramble(uint(pixel.x) + scramble(uint(pixel.y)));
	float turned = chance(state);
	vec3 bounced = vec3(0.0);
	for (int s = 0; s < u_samples; s++) \{
		float angle = TURN * (float(s) + turned) / float(u_samples);
		vec2 from = place;
		vec2 along = vec2(cos(angle), sin(angle));
		// what is left of a wall's light by the time it has come back along the path
		float carried = 1.0;
		for (int b = 0; b < u_bounces; b++) \{
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
				int met = meets(from, along * u_far, i, from, 0.0, false, at, candidate);
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
			if (hit < 0 || best > 1.0) break;
			vec4 wall = texelFetch(u_walls, ivec2(0, hit), 0);
			// the face of the wall the path arrived on, and what that face is like
			vec2 normal = normalize(vec2(-wall.w, wall.z));
			if (dot(normal, along) > 0.0) normal = -normal;
			vec4 faces = texelFetch(u_walls, ivec2(2, hit), 0);
			vec2 face = along.x * wall.w - along.y * wall.z < 0.0 ? faces.xy : faces.zw;
			// the shares of the light it mirrors and scatters, at the angle the path left it by
			float steep = clamp(-dot(normal, along), 0.0, 1.0);
			float straight = mix(PLAIN, BASE, face.x);
			float shiny = straight + (1.0 - straight) * pow(1.0 - steep, 5.0);
			float matt = BASE * (1.0 - face.x) * (1.0 - shiny);
			float spread = 1.5707963 * (1.0 - face.y) * (1.0 - face.y);
			vec2 mirror = along - 2.0 * dot(along, normal) * normal;
			carried *= kept(u_far * best);
			from = from + along * (u_far * best) + normal * NUDGE;
			for (int k = 0; k < u_lightCount; k++) \{
				vec2 toward;
				vec3 light = arriving(k, from, normal, toward);
				float off = atan(mirror.x * toward.y - mirror.y * toward.x, dot(mirror, toward));
				bounced += carried * (0.5 * matt * dot(normal, toward) + shiny * mirrored(off, max(spread, LEAST_SPREAD))) * light;
			\}
			if (chance(state) * (shiny + matt) < shiny) \{
				// mirrored: off the mirrored direction by the sum of two chances, which is more
				// often small than large, as `mirrored` has it
				float off = spread * (chance(state) + chance(state) - 1.0);
				along = vec2(mirror.x * cos(off) - mirror.y * sin(off), mirror.x * sin(off) + mirror.y * cos(off));
				// what would leave into the wall leaves as far above it
				if (dot(along, normal) < 0.0) along -= 2.0 * dot(along, normal) * normal;
			\} else \{
				float side = 2.0 * chance(state) - 1.0;
				along = normal * sqrt(1.0 - side * side) + vec2(-normal.y, normal.x) * side;
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
// the far side of a wall is left out, so light never seeps through a wall.
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
	vec2 place = placeOf(gl_FragCoord.xy);
	vec3 sum = vec3(0.0);
	float shares = 0.0;
	for (int j = -2; j <= 2; j++) \{
		for (int i = -2; i <= 2; i++) \{
			ivec2 other = pixel + ivec2(i, j) * u_step;
			if (other.x < 0 || other.y < 0 || other.x >= int(u_size.x) || other.y >= int(u_size.y)) continue;
			vec2 there = placeOf(vec2(other) + 0.5);
			bool parted = false;
			for (int w = 0; w < u_wallCount; w++) \{
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
	vec2 toward;
	for (int j = 0; j < u_fine; j++) \{
		for (int i = 0; i < u_fine; i++) \{
			vec2 place = placeOf(pixel + (vec2(float(i), float(j)) + 0.5) / float(u_fine) - 0.5);
			for (int k = 0; k < u_lightCount; k++) \{
				if (texelFetch(u_lights, ivec2(3, k), 0).z != 0.0) continue;
				straight += arriving(k, place, vec2(0.0), toward);
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

// How many pixels a wall and a light source take in the textures of the path tracer.
let WALL_PIXELS = 3
let LIGHT_PIXELS = 4

// Foundry's CONST.EDGE_SENSE_TYPES, which CONST.WALL_MOVEMENT_TYPES takes its two values from.
let SENSE_NONE = 0
let SENSE_NORMAL = 20

var gpuReady = false
var nearestProgram: uint
var hitsProgram: uint
var bounceProgram: uint
var smoothProgram: uint
var showProgram: uint
var pictureA: uint
var pictureB: uint
var pictureTarget: uint
var wallsTexture: uint
var lightsTexture: uint
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
// it crosses as well: two JSON arrays, one after the other, as test() of test_local.das returns.
[export]
def test(var treeS:string; var ta:float3; var tb:float3) : string
	var inscope tree <- readTree(treeS)
	var inscope entries: array<Entry>
	flatten(tree, entries, false)
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
// from the end of the visible part of the wall instead (see visibleParts and visibleEnd).
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
// beforehand. The picture covers the root cell of the tree and shows how bright each place is:
// lit straight from p, and by light that walls throw back, followed for up to `bounces` walls
// along `samples` paths per pixel (see BOUNCE_SOURCE). The light has no end: it is 1 bright
// next to p and a half at HALF_LIGHT of the map's diagonal away. Every wall stops it, as in
// the rest of this function, and scatters what it throws back (it is neither metallic nor
// smooth). The picture is not smoothed. The function returns when the picture is drawn.
[export]
def test_light_adaptive(var treeS:string; var p:float3; width:int; height:int; samples:int; bounces:int) : string
	var inscope sight <- visibleParts(treeS, p)
	if width > 0 && height > 0
		let across = length(float2(sight.bounds.max.x - sight.bounds.min.x, sight.bounds.max.y - sight.bounds.min.y))
		var inscope lights: array<float4>
		push(lights, float4(p.x, p.y, 0.0, across * HALF_LIGHT))
		push(lights, float4(1.0, 1.0, 1.0, 1.0))
		push(lights, float4(0.0, 0.0, -2.0, 0.0))
		push(lights, float4(0.0, 0.0, 0.0, 0.0))
		// a light above or below the flat boxes of the walls meets none of them, as in the sweep
		let wallCount = abs(p.z) <= 0.001 ? length(sight.walls) / WALL_PIXELS : 0
		tracePicture(sight.bounds, sight.walls, wallCount, lights, 1, width, height, samples, bounces, 0, 0.0, 1)
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
// that size beforehand. `lights` points at the first of count * LIGHT_PIXELS float4 that lie
// one after the other in memory, four per source, as LIGHT_SOURCE describes them. Each wall
// acts on the light the way it says (see wallOf and LIGHT_SOURCE); walls that do nothing to
// light are left out. Light the walls throw back is followed for up to `bounces` walls along
// `samples` paths per pixel, and the noise that leaves is smoothed out in `smoothing` runs
// (0 to MOST_SMOOTHING; 0 leaves it as it is). The walls stand `wallHeight` map units high,
// which is how far the light they throw back carries (see BOUNCE_SOURCE; 0: as far as the map
// goes). The light that comes straight from the sources is taken at `fine` by `fine` places of
// each pixel, which smooths its edges (1 to MOST_FINE; see SHOW_SOURCE). Returns how many
// sources and walls took part, when the picture is drawn.
[export]
def trace_lights(var treeS:string; lights:float4?; count:int; width:int; height:int; samples:int; bounces:int; smoothing:int; wallHeight:float; fine:int) : string
	var inscope tree <- readTree(treeS)
	var inscope entries: array<Entry>
	flatten(tree, entries, false)
	var inscope walls <- wallsOf(entries, true)
	var inscope sources: array<float4>
	for i in range(max(count, 0) * LIGHT_PIXELS)
		unsafe
			push(sources, lights[i])
	let wallCount = length(walls) / WALL_PIXELS
	if width > 0 && height > 0
		tracePicture(tree.bounds, walls, wallCount, sources, max(count, 0), width, height, samples, bounces, smoothing, wallHeight, fine)
	return sprint_json(Traced(lights = max(count, 0), walls = wallCount), false)

// How much of each of several round targets the walls hide from a round source. source is the
// centre of the source; targets points at the first of `count` target centres that lie one
// after the other in memory; ds and da are the diameters of the source and of every target,
// in map units. Returns one result per target, in the order of the targets.
//
// Only walls that stop movement hide anything, and a one-way wall hides only what is looked
// at from the side it acts from (see wallOf).
//
// For each target, the source is looked from at n points, spread evenly along its diameter
// that lies across the line from source to target: the first point is one end of that
// diameter, the n-th the other (n = 1 looks from the first end only). From each point the
// target fills the sector between the two rays that just touch its circle. That sector is
// swept with rays at most 0.05 degrees apart, each as long as it takes to reach the circle,
// and a ray a wall crosses counts as blocked. The share of blocked rays is how much of the
// target that point cannot see; a target's own figure is the smallest share among its points.
//
// The rays of every point of every target go to the graphics card in one batch.
[export]
def test_cover(var treeS:string; var source:float3; targets:float3?; count:int; ds:float; da:float; n:int) : string
	var inscope tree <- readTree(treeS)
	var inscope entries: array<Entry>
	flatten(tree, entries, true)
	uploadEntries(entries)
	var inscope covers: array<Cover>
	var inscope rays: array<float4>
	for i in range(count)
		var target: float3
		unsafe
			target = targets[i]
		var cover <- coverOf(source, target, ds, da, n, rays)
		emplace(covers, cover)
	var inscope hits <- castRays(rays, source.z, length(entries), true)
	// the rays were queued point after point, and the answers come back in that order
	var next = 0
	for cover in covers
		var least = 1.0
		for point in cover.points
			for k in range(point.rays)
				let stopped = hits[next] > 0
				let end = float3(rays[next].x + rays[next].z, rays[next].y + rays[next].w, source.z)
				next ++
				if stopped
					point.blocked ++
				// neighbouring rays that end the same way are kept as one run
				let last = length(point.runs) - 1
				if last >= 0 && point.runs[last].blocked == stopped
					point.runs[last].to = end
				else
					push(point.runs, CoverRun(blocked = stopped, from = end, to = end))
			if point.rays > 0
				point.obstructed = float(point.blocked) / float(point.rays)
			least = min(least, point.obstructed)
		cover.obstructed = least
	return sprint_json(covers, false)

// test_cover's preparation for one target: the diameter of the source that lies across the
// line to it, the n points on that diameter, and each point's rays, which are added to `rays`.
def coverOf(source: float3; target: float3; ds: float; da: float; n: int; var rays: array<float4>) : Cover
	var cover: Cover
	cover.target = target
	let toTarget = float2(target.x - source.x, target.y - source.y)
	let apart = length(toTarget)
	// with source and target in one place no direction is across; any will do
	let across = apart > 0.001 ? float3(-toTarget.y, toTarget.x, 0.0) / apart : float3(0.0, 1.0, 0.0)
	cover.lineA = source - across * (ds * 0.5)
	cover.lineB = source + across * (ds * 0.5)
	let count = max(n, 1)
	for i in range(count)
		let along = count > 1 ? float(i) / float(count - 1) : 0.0
		var point <- coverFrom(cover.lineA + (cover.lineB - cover.lineA) * along, target, da * 0.5, rays)
		emplace(cover.points, point)
	return <- cover

// coverOf's work for one point p of the source; radius is that of the target circle. The
// point's rays go to the end of `rays`, and point.rays says how many there are.
def coverFrom(p: float3; target: float3; radius: float; var rays: array<float4>) : CoverPoint
	var point: CoverPoint
	point.at = p
	let toward = float2(target.x - p.x, target.y - p.y)
	let apart = length(toward)
	// from inside the target, or on its edge, no ray just touches it: nothing is swept
	if apart <= radius || apart < 0.001
		point.rayA = Ray(dir = target - p, origin = p)
		point.rayB = Ray(dir = target - p, origin = p)
		return <- point
	let middle = atan2(toward.y, toward.x)
	let half = asin(radius / apart)
	let touch = sqrt(apart * apart - radius * radius)
	point.rayA = Ray(dir = float3(cos(middle - half), sin(middle - half), 0.0) * touch, origin = p)
	point.rayB = Ray(dir = float3(cos(middle + half), sin(middle + half), 0.0) * touch, origin = p)
	// equal steps of at most 0.05 degrees, so that the first and the last ray are the touching ones
	let steps = max(int(ceil(2.0 * half / (0.05 * PI / 180.0))), 1)
	for k in range(steps + 1)
		let offset = 2.0 * half * float(k) / float(steps) - half
		// how far along this direction the target circle begins
		let side = apart * sin(offset)
		let far = apart * cos(offset) - sqrt(max(radius * radius - side * side, 0.0))
		let dir = float3(cos(middle + offset), sin(middle + offset), 0.0) * far
		push(rays, float4(p.x, p.y, dir.x, dir.y))
	point.rays = steps + 1
	return <- point

// The tree in treeS, in the form the rest of the script works on.
def readTree(treeS: string) : Znode
	var jError: string
	var Jtree = read_json(treeS,jError)
	var inscope Qtree <- from_JV(Jtree,type<Stree>)
	unsafe
		delete Jtree
	var tree <- SnToZn(Qtree.nodes[Qtree.root], Qtree)
	return <- tree

// Adds one entry per object of the cell and of the cells below it, in the order checkN and
// checkO of test_local.das walk them: a cell's own objects, then each of its child cells.
// With moveOnly, objects whose wall lets movement through are left out.
def flatten(node: Znode; var entries: array<Entry>; moveOnly: bool)
	for i in node.objects
		if !moveOnly || i.move != SENSE_NONE
			push(entries, Entry(cell = node.bounds, obj = i))
	for i in node.nodes
		flatten(i, entries, moveOnly)

// Every wall of the entries once, however many cells store it, as the path tracer takes them:
// WALL_PIXELS float4 per wall (see LIGHT_SOURCE). With asTheySay, each wall acts on light the
// way it says and walls that do nothing to light are left out; without, every wall stops light
// and is neither metallic nor smooth.
def wallsOf(entries: array<Entry>; asTheySay: bool) : array<float4>
	var walls: array<float4>
	for i in entries
		if asTheySay && i.obj.light == SENSE_NONE
			continue
		let wall = float4(i.obj.t.origin.x, i.obj.t.origin.y, i.obj.t.dir.x, i.obj.t.dir.y)
		var known = false
		for k in range(length(walls) / WALL_PIXELS)
			if walls[k * WALL_PIXELS] == wall
				known = true
				break
		if !known
			push(walls, wall)
			push(walls, asTheySay ? float4(float(i.obj.light), float(i.obj.dir), i.obj.lightThreshold, 0.0) : float4(float(SENSE_NORMAL), 0.0, 0.0, 0.0))
			push(walls, asTheySay ? float4(i.obj.metallicLeft, i.obj.smoothnessLeft, i.obj.metallicRight, i.obj.smoothnessRight) : float4(0.0, 0.0, 0.0, 0.0))
	return <- walls

// Spins a ray around p in 1 degree steps (360 rays) to find the walls visible from p: each ray
// stops at the first wall it meets, and a wall met by several rays counts once. A ray is long
// enough to reach the farthest corner of the map from p. Then finds the visible part of each
// of those walls. After that, lookCloser sends more rays where that result calls for them,
// and the visible parts are found again if it adds a wall.
def visibleParts(treeS: string; p: float3) : Sight
	var inscope tree <- readTree(treeS)
	var inscope entries: array<Entry>
	flatten(tree, entries, false)
	uploadEntries(entries)
	let far = max(abs(p - tree.bounds.min), abs(tree.bounds.max - p))
	let reach = length(float2(far.x, far.y))
	var inscope walls: array<Zobjects>
	var inscope rays: array<float4>
	for turn in range(360)
		push(rays, rayAlong(p, float(turn), reach))
	lookAlong(rays, p.z, entries, walls)
	var sight: Sight
	sight.reach = reach
	sight.bounds = tree.bounds
	sight.walls <- wallsOf(entries, false)
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

// Where r1 crosses r2, as a fraction of r1's length: 0 at its origin, 1 at its end. Only
// meaningful for a pair is_intersecting(r1, r2) accepts.
def hitFraction(r1, r2 : Ray) : float
	let w = r2.origin - r1.origin
	let d = r1.dir.x * r2.dir.y - r1.dir.y * r2.dir.x
	return (w.x * r2.dir.y - w.y * r2.dir.x) / d

// True when arr already holds the wall of ob. One wall is stored in every tree cell it
// touches and is crossed by many neighbouring rays, so it turns up many times.
def hasWall(arr: array<Zobjects>; ob: Zobjects) : bool
	for i in arr
		if i.t.origin == ob.t.origin && i.t.dir == ob.t.dir
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

// Builds the two programs and the objects every call reuses, on the first call that needs them.
def gpuInit
	if gpuReady
		return
	nearestProgram = create_shader_program(VERTEX_SOURCE, COMMON_SOURCE + NEAREST_SOURCE)
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
// direction x, direction y), and the wall's EDGE_DIRECTIONS value. It stays on texture unit 0
// for the draw calls of this call.
def uploadEntries(entries: array<Entry>)
	gpuInit()
	var inscope data: array<float4>
	for i in entries
		push(data, float4(i.cell.min.x, i.cell.min.y, i.cell.max.x, i.cell.max.y))
		push(data, float4(i.obj.r.min.x, i.obj.r.min.y, i.obj.r.max.x, i.obj.r.max.y))
		push(data, float4(i.obj.t.origin.x, i.obj.t.origin.y, i.obj.t.dir.x, i.obj.t.dir.y))
		push(data, float4(float(i.obj.dir), 0.0, 0.0, 0.0))
	// a tree without objects still needs a texture to bind
	if empty(data)
		resize(data, 4)
	glActiveTexture(GL_TEXTURE0)
	uploadFloats(entriesTexture, 4, length(data) / 4, data)

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

// Tests every ray against every entry in one draw call. A ray is origin x and y, then
// direction x and y; all of them lie flat at height z. Returns, per ray, the number of the
// entry whose wall the ray meets first, counted from 1, or 0 when it meets none. With oneWay,
// a one-way wall is met only from the side it acts from.
def castRays(var rays: array<float4>; z: float; entryCount: int; oneWay: bool) : array<int>
	var hits: array<int>
	let count = length(rays)
	if count == 0
		return <- hits
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
	resize(hits, count)
	for i in range(count)
		hits[i] = int(pixels[i * 4]) + int(pixels[i * 4 + 1]) * 256 + int(pixels[i * 4 + 2]) * 65536
	return <- hits

// Draws the picture of the light of the sources onto the canvas, width by height pixels over
// `area`, in the three steps LIGHT_SOURCE describes. walls and lights are as that shader reads
// them; the first wallCount walls and lightCount sources take part. The light the walls throw
// back is drawn into one of two textures the size of the picture, smoothed from one into the
// other `smoothing` times, and the last of them goes into the picture on the canvas. The walls
// stand wallHeight high (0: the map is flat), and the light straight from the sources is taken
// at fine by fine places of each pixel.
def tracePicture(area: AABB; var walls: array<float4>; wallCount: int; var lights: array<float4>; lightCount: int; width, height, samples, bounces, smoothing: int; wallHeight: float; fine: int)
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
		lightProgram(bounceProgram, area, wallCount, lightCount, width, height)
		// long enough to leave the map from anywhere on it
		glUniform1f(glGetUniformLocation(bounceProgram, "u_far"), across * 2.0)
		glUniform1i(glGetUniformLocation(bounceProgram, "u_samples"), clamp(samples, 1, 1024))
		glUniform1i(glGetUniformLocation(bounceProgram, "u_bounces"), clamp(bounces, 0, 16))
		glUniform1f(glGetUniformLocation(bounceProgram, "u_height"), max(wallHeight, 0.0))
		glDrawArrays(GL_TRIANGLES, 0, 3)
		lightProgram(smoothProgram, area, wallCount, lightCount, width, height)
		glUniform1i(glGetUniformLocation(smoothProgram, "u_picture"), 5)
		for run in range(clamp(smoothing, 0, MOST_SMOOTHING))
			glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, next, 0)
			glBindTexture(GL_TEXTURE_2D, held)
			glUniform1i(glGetUniformLocation(smoothProgram, "u_step"), 1 << run)
			glDrawArrays(GL_TRIANGLES, 0, 3)
			swap(held, next)
	else
		// no wall throws anything back
		glClearColor(0.0, 0.0, 0.0, 1.0)
		glClear(GL_COLOR_BUFFER_BIT)
	glBindFramebuffer(GL_FRAMEBUFFER, 0u)
	lightProgram(showProgram, area, wallCount, lightCount, width, height)
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
// needs to know: where the walls and the light sources are, and what the picture covers.
def lightProgram(program: uint; area: AABB; wallCount, lightCount, width, height: int)
	glUseProgram(program)
	glUniform1i(glGetUniformLocation(program, "u_walls"), 3)
	glUniform1i(glGetUniformLocation(program, "u_wallCount"), wallCount)
	glUniform1i(glGetUniformLocation(program, "u_lights"), 4)
	glUniform1i(glGetUniformLocation(program, "u_lightCount"), lightCount)
	glUniform4f(glGetUniformLocation(program, "u_area"), area.min.x, area.min.y, area.max.x, area.max.y)
	glUniform2f(glGetUniformLocation(program, "u_size"), float(width), float(height))

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
		mi = float3(Sn.bounds["x"], Sn.bounds["y"], -0.001)
		ma = float3(Sn.bounds["x"] + Sn.bounds["width"], Sn.bounds["y"] + Sn.bounds["height"], 0.001)
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
		mi = float3(So.r["x"], So.r["y"], -0.001)
		ma = float3(float(So.r["x"]) + max(float(So.r["width"]), 0.001), float(So.r["y"]) + max(float(So.r["height"]), 0.001), 0.001)
	var orr = AABB(min = mi, max = ma)
	var o <- Zobjects(t = ot, r = orr)
	wallOf(o, So.w)
	return <- o

// Takes over how a wall acts from `w` of its object in the tree: what Foundry's Edge of the
// wall has as move, light and direction, and its threshold for light in map units (an open
// door has move and light 0 there), then how metallic and how smooth its left and its right
// face are, 0 to 1 each (see LIGHT_SOURCE for which face is which and BOUNCE_SOURCE for what
// they do). An object without `w`, or without one of these, is a wall that stops movement and
// light from both sides and is neither metallic nor smooth.
def wallOf(var wall: Zobjects; w: table<string; float>)
	wall.move = int(w?["move"] ?? float(SENSE_NORMAL))
	wall.light = int(w?["light"] ?? float(SENSE_NORMAL))
	wall.dir = int(w?["dir"] ?? 0.0)
	wall.lightThreshold = w?["lightThreshold"] ?? 0.0
	wall.metallicLeft = clamp(w?["metallicLeft"] ?? 0.0, 0.0, 1.0)
	wall.smoothnessLeft = clamp(w?["smoothnessLeft"] ?? 0.0, 0.0, 1.0)
	wall.metallicRight = clamp(w?["metallicRight"] ?? 0.0, 0.0, 1.0)
	wall.smoothnessRight = clamp(w?["smoothnessRight"] ?? 0.0, 0.0, 1.0)

struct Sobjects
	n: int
	t: table<string, table<string; int >>
	r: table<string, int >
	w: table<string; float>

struct Snode
	objects: array<Sobjects>
	bounds: table<string; int >
	nodes: array<int >

struct Stree
	root: int
	nodes: array<Snode>

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

// A stretch of neighbouring rays of test_cover that all end the same way: stopped by a wall
// (blocked), or reaching the target. from and to are where its first and its last ray meet
// the target circle.
struct CoverRun
	blocked: bool
	from: float3
	to: float3

// test_cover's result for one point of the source: the point, the two rays that just touch the
// target, how many rays were sent between them, how many a wall stopped, that share, and the
// runs the rays fall into.
struct CoverPoint
	at: float3
	rayA: Ray
	rayB: Ray
	rays: int
	blocked: int
	obstructed: float
	runs: array<CoverRun>

// What test_cover returns for one target: its centre, the ends of the source's diameter that
// lies across the line to it, the smallest share of the target any of the points cannot see,
// and each point's result.
struct Cover
	target: float3
	lineA: float3
	lineB: float3
	obstructed: float
	points: array<CoverPoint>

// What trace_lights returns: how many light sources and walls took part.
struct Traced
	lights: int
	walls: int

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

struct Znode
	objects: array<Zobjects>
	bounds: AABB
	nodes: array<Znode>
