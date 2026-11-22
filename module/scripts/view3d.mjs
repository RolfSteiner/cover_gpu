// The scene in perspective: a camera that can be moved, turned and brought closer.
//
// Foundry draws a scene flat, seen from straight above, and nothing in it can draw it any other
// way: every picture it makes is laid on the screen by a transform that keeps lines parallel.
// So the view in perspective is a picture of its own, drawn here with WebGL on a canvas that
// lies over Foundry's. Foundry goes on drawing underneath, flat, and what it draws is put to
// use:
//
//  - Each frame, right after Foundry has drawn, its picture is taken over as an image. It holds
//    everything Foundry shows of the viewed level: the map, the tiles, the tokens, the
//    lighting, the fog, the grid, and what this module's view draws on the map. That image is
//    laid on the floors of the viewed level, each at its height, and on the top of every token
//    Foundry has drawn.
//  - The scene is shown whole, every level of it at once. Foundry draws the viewed level only,
//    so the floors of the other levels are drawn here: in the level's own picture or color, lit
//    by the light that was path traced for those floors, between the colors Foundry gives an
//    unlit and a lit place. The tokens of those levels show their own pictures.
//  - What has a height is drawn standing, from what the layer knows of it (see layer.mjs): the
//    walls from their bottom to their top, every token as a cylinder from its feet to its head,
//    and, with the GM's view shown, the other surfaces, the traced lights at their heights and
//    the cover test. The cover test is a cone of lines of sight from where the selected token
//    looks from to each other token: where the cone ends on that token, what of it is hidden
//    and what is seen.
//  - The image only holds the part of the scene that Foundry's own view shows. So Foundry's
//    view is moved here, out of sight, to wherever the camera looks: to the part of the ground
//    the camera sees, as large as the screen lets it be (`#follow`).
//
// The mouse keeps working on the scene. Foundry is told where on the scene the mouse is by one
// function of PIXI, which turns a place on the screen into a place of Foundry's flat picture;
// while this view is shown, that function goes by the line of sight from the camera through
// the mouse and by what the line meets: a token, a raised floor, or the ground (`mapPointer`;
// the wrappers are in wrappers.mjs). Selecting, dragging, hovering and clicking then land where
// they are seen to land. The right mouse button and the wheel are the camera's:
//
//  - dragging with the right button moves the camera over the ground, which stays under the
//    mouse where it was taken hold of;
//  - dragging with the middle button, or with the right button while Shift is held, turns the
//    camera round the place it looks at and tilts it;
//  - the wheel brings the camera closer or takes it away.
//
// Places and heights are in scene pixels throughout: x to the right and y down, as on the map,
// and z up.

/** How wide the camera sees from top to bottom, as an angle. */
const FIELD = (40 * Math.PI) / 180;

/** How flat and how steep the camera may look down, as angles above the ground. */
const FLATTEST = (12 * Math.PI) / 180;
const STEEPEST = (89 * Math.PI) / 180;

/** How many flat sides a cylinder is drawn with. */
const SIDES = 28;

/** A vertex is ten numbers: where (3), its color and how solid (4), where in Foundry's picture (2), and how much of that picture it shows. */
const STRIDE = 10;

const WALL = [0.76, 0.76, 0.72];
const MIRROR = [0.56, 0.83, 1];
const FLOOR = [0.56, 0.83, 1];
const BODY = [0.86, 0.85, 0.8];
const PICKED = [1, 0.6, 0.16];
const LAMP = [1, 0.77, 0.25];
const SEEN = [1, 0.77, 0.25];
const HIDDEN = [0.9, 0.4, 0.4];
const INK = [0.94, 0.94, 0.92];

const VERTEX = `#version 300 es
in vec3 a_place;
in vec4 a_color;
in vec3 a_image;
uniform mat4 u_camera;
out vec4 v_color;
out vec3 v_image;
out vec3 v_place;
void main() {
	v_color = a_color;
	v_image = a_image;
	v_place = a_place;
	gl_Position = u_camera * vec4(a_place, 1.0);
}`;

// u_lit 0: the color of the vertex, or as much of u_picture as the vertex says, where it says.
// u_lit 1: a floor of a level Foundry does not draw. Its color, times its picture where it has
// one, by the place on the scene; times the light traced for it, which lies between the color
// of an unlit place (u_dark) and that of a lit one (u_bright). The picture of the light has its
// first row at the bottom.
const FRAGMENT = `#version 300 es
precision mediump float;
in vec4 v_color;
in vec3 v_image;
in vec3 v_place;
uniform sampler2D u_picture;
uniform sampler2D u_light;
uniform int u_lit;
uniform int u_hasPicture;
uniform int u_hasLight;
uniform vec4 u_pictureArea;
uniform vec4 u_lightArea;
uniform vec3 u_dark;
uniform vec3 u_bright;
out vec4 o_color;
void main() {
	if (u_lit == 0) {
		vec3 shown = texture(u_picture, v_image.xy).rgb;
		o_color = vec4(mix(v_color.rgb, shown * v_color.rgb, v_image.z), v_color.a);
		return;
	}
	vec3 shown = v_color.rgb;
	if (u_hasPicture == 1) shown *= texture(u_picture, (v_place.xy - u_pictureArea.xy) * u_pictureArea.zw).rgb;
	if (u_hasLight == 1) {
		vec2 at = (v_place.xy - u_lightArea.xy) * u_lightArea.zw;
		shown *= u_dark + texture(u_light, vec2(at.x, 1.0 - at.y)).rgb * (u_bright - u_dark);
	}
	o_color = vec4(shown, 1.0);
}`;

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const along = (p, d, t) => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
const unit = (p) => {
	const length = Math.hypot(p[0], p[1], p[2]) || 1;
	return [p[0] / length, p[1] / length, p[2] / length];
};
const clamp = (value, least, most) => Math.min(Math.max(value, least), most);

/** True when a place on the map lies in one of the triangles of `t` (six numbers each). */
function inTriangles(x, y, t) {
	const side = (ax, ay, bx, by) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
	for (let i = 0; i + 5 < t.length; i += 6) {
		const s1 = side(t[i], t[i + 1], t[i + 2], t[i + 3]);
		const s2 = side(t[i + 2], t[i + 3], t[i + 4], t[i + 5]);
		const s3 = side(t[i + 4], t[i + 5], t[i], t[i + 1]);
		if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
	}
	return false;
}

export class View3D {
	/**
	 * @param {() => object} describe what there is to draw right now, as `#seen` of layer.mjs
	 *   gives it: `floor`, the height of the lowest floor, and `viewedBase`, that of the viewed
	 *   level; `levels`, each `{ viewed, base, plane, image, color, light, floors }` with `floors`
	 *   being `{ z, t }`; `area` and `lightArea`, the rectangles of the scene a level's picture
	 *   and the pictures of the light lie over; `dark` and `bright`; `walls`, each
	 *   `{ a, b, bottom, top, mirror }` with a bottom or a top not finite where the wall names
	 *   none, and `tall`, how high such a wall is drawn; `surfaces`, each `{ z, t }`; `tokens`,
	 *   each `{ x, y, radius, bottom, top, picked, image }`; `lights`, each `{ x, y, z, color }`;
	 *   and `cover`, each `{ eye, line, centre, radius, bottom, top, heights, runs }`
	 */
	constructor(describe) {
		this.#describe = describe;
	}

	#describe;

	/** The canvas this view is drawn on, its WebGL context, and what was made in it: `{ program, buffer, picture, camera }`. */
	#overlay = null;

	#gl = null;

	#made = null;

	/** Where the camera looks at on the ground, how far from it the camera is, and how it is turned and tilted. */
	#target = { x: 0, y: 0 };

	#distance = 1000;

	#turn = 0;

	#tilt = (55 * Math.PI) / 180;

	/** The pictures loaded for levels and tokens, by their address: `{ texture, ready }`. */
	#images = new Map();

	/** The pictures of the light on the floors of the levels, by the id of the level: `{ texture, version }`. */
	#lights = new Map();

	/** The floors of the last frame, for the mouse: `{ z, t }` or `{ z, area }` each. */
	#floors = [];

	/** What was described for the last frame, and the camera of that frame: `{ eye, right, up, ahead, aspect, floor }`. */
	#scene = null;

	#camera = null;

	/** The drag that moves or turns the camera: `{ mode, id, x, y }`. */
	#drag = null;

	/** The height the left mouse button took hold of something at; null while it is not held. */
	#held = null;

	/** How Foundry's view was before this one took it over, and what was changed in the page. */
	#before = null;

	#listeners = [];

	/** True while the view is shown. */
	get active() {
		return Boolean(this.#overlay);
	}

	/* -------------------------------------------- */
	/*  Showing and hiding                          */
	/* -------------------------------------------- */

	/** Shows the view over Foundry's canvas, looking at what Foundry's view is looking at. */
	start() {
		const board = canvas.app?.view;
		if (this.#overlay || !board) return;
		const overlay = document.createElement('canvas');
		overlay.id = 'cover-view-3d';
		// over the canvas of Foundry, under everything Foundry lays over that; the mouse goes through
		overlay.style.cssText = `position: fixed; pointer-events: none; z-index: ${getComputedStyle(board).zIndex};`;
		const gl = overlay.getContext('webgl2', { alpha: false, antialias: true, depth: true });
		if (!gl) {
			ui.notifications?.error(game.i18n.localize('COVERQV.No3D'));
			return;
		}
		board.after(overlay);
		this.#overlay = overlay;
		this.#gl = gl;
		this.#made = this.#make(gl);

		const stage = canvas.stage;
		const screen = canvas.app.renderer.screen;
		const scale = stage.scale.x || 1;
		this.#before = { scale, hud: document.getElementById('hud') };
		if (this.#before.hud) this.#before.hud.style.visibility = 'hidden';
		this.#target = { x: stage.pivot.x, y: stage.pivot.y };
		// far enough to see about as much of the scene as Foundry's view showed
		this.#distance = (screen.height / scale / 2 / Math.tan(FIELD / 2)) * 0.9;
		this.#turn = 0;
		this.#tilt = (55 * Math.PI) / 180;

		// ahead of PIXI and of Foundry, which listen further down the same way
		const listen = (type, handler) => {
			const options = { capture: true, passive: false };
			window.addEventListener(type, handler, options);
			this.#listeners.push([type, handler, options]);
		};
		listen('pointerdown', (event) => this.#onDown(event));
		listen('pointermove', (event) => this.#onMove(event));
		listen('pointerup', (event) => this.#onUp(event));
		listen('pointercancel', (event) => this.#onUp(event));
		listen('wheel', (event) => this.#onWheel(event));
		// after Foundry has drawn its frame
		canvas.app.ticker.add(this.#frame, this, PIXI.UPDATE_PRIORITY.UTILITY);
	}

	/** Takes the view away and gives Foundry's view back, looking at where the camera looked. */
	stop() {
		if (!this.#overlay) return;
		canvas.app?.ticker?.remove(this.#frame, this);
		for (const [type, handler, options] of this.#listeners) window.removeEventListener(type, handler, options);
		this.#listeners = [];
		this.#gl.getExtension('WEBGL_lose_context')?.loseContext();
		this.#overlay.remove();
		this.#overlay = null;
		this.#gl = null;
		this.#made = null;
		this.#camera = null;
		this.#scene = null;
		this.#images = new Map();
		this.#lights = new Map();
		this.#floors = [];
		this.#drag = null;
		this.#held = null;
		if (this.#before?.hud) this.#before.hud.style.visibility = '';
		if (canvas.ready) canvas.pan?.({ x: this.#target.x, y: this.#target.y, scale: this.#before?.scale });
		this.#before = null;
	}

	#make(gl) {
		const shader = (type, source) => {
			const made = gl.createShader(type);
			gl.shaderSource(made, source);
			gl.compileShader(made);
			if (!gl.getShaderParameter(made, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(made));
			return made;
		};
		const program = gl.createProgram();
		gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
		gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
		gl.useProgram(program);
		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		[['a_place', 3, 0], ['a_color', 4, 3], ['a_image', 3, 7]].forEach(([name, size, offset]) => {
			const at = gl.getAttribLocation(program, name);
			gl.enableVertexAttribArray(at);
			gl.vertexAttribPointer(at, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
		});
		const picture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, picture);
		for (const [name, to] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
			gl.texParameteri(gl.TEXTURE_2D, name, to);
		}
		const at = Object.fromEntries(['u_camera', 'u_picture', 'u_light', 'u_lit', 'u_hasPicture', 'u_hasLight', 'u_pictureArea', 'u_lightArea', 'u_dark', 'u_bright']
			.map((name) => [name, gl.getUniformLocation(program, name)]));
		gl.uniform1i(at.u_picture, 0);
		gl.uniform1i(at.u_light, 1);
		return { program, buffer, picture, at };
	}

	/** A texture that is shown stretched, not repeated. */
	#texture(gl) {
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		for (const [name, to] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
			gl.texParameteri(gl.TEXTURE_2D, name, to);
		}
		return texture;
	}

	/** The picture at an address as a texture; null until it is loaded, and for one that cannot be. */
	#image(gl, address) {
		if (!address) return null;
		let entry = this.#images.get(address);
		if (!entry) {
			entry = { texture: null, ready: false };
			this.#images.set(address, entry);
			const image = new Image();
			image.crossOrigin = 'anonymous';
			image.onload = () => {
				// the view may have been taken away, or made anew, while the picture was on its way
				if (this.#gl !== gl || this.#images.get(address) !== entry) return;
				try {
					entry.texture = this.#texture(gl);
					gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
					gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
					entry.ready = true;
				} catch (error) {
					console.warn('cover-quadtree-view: a picture could not be used in the view in perspective', address, error);
				}
			};
			image.src = address;
		}
		return entry.ready ? entry.texture : null;
	}

	/** The light on the floors of a level as a texture, made anew when the picture is another. */
	#light(gl, id, picture) {
		if (!picture) return null;
		let entry = this.#lights.get(id);
		if (!entry) {
			entry = { texture: this.#texture(gl), version: null };
			this.#lights.set(id, entry);
		}
		if (entry.version !== picture.version) {
			gl.bindTexture(gl.TEXTURE_2D, entry.texture);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, picture.width, picture.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, picture.data);
			entry.version = picture.version;
		}
		return entry.texture;
	}

	/* -------------------------------------------- */
	/*  The camera                                  */
	/* -------------------------------------------- */

	/**
	 * The camera as it stands: where it is (`eye`), and the three directions of what it sees: to
	 * the right, up, and ahead. Not turned, it stands south of the place it looks at and looks
	 * north, so that the scene lies before it as on the map.
	 */
	#stand(floor, aspect) {
		const flat = Math.cos(this.#tilt);
		const away = [Math.sin(this.#turn) * flat, Math.cos(this.#turn) * flat, Math.sin(this.#tilt)];
		const at = [this.#target.x, this.#target.y, floor];
		const eye = along(at, away, this.#distance);
		const ahead = unit(sub(at, eye));
		const right = [Math.cos(this.#turn), -Math.sin(this.#turn), 0];
		return { eye, ahead, right, up: cross(ahead, right), aspect, floor };
	}

	/** The camera as the numbers the shader takes: a place of the scene to where it is on the screen. */
	#matrix(camera) {
		const { eye, right, up, ahead, aspect } = camera;
		const zoom = 1 / Math.tan(FIELD / 2);
		const near = Math.max(this.#distance * 0.02, 1);
		const far = this.#distance * 60 + 20000;
		const deep = (far + near) / (far - near);
		const rows = [
			[...right.map((v) => (v * zoom) / aspect), (-dot(eye, right) * zoom) / aspect],
			[...up.map((v) => v * zoom), -dot(eye, up) * zoom],
			[...ahead.map((v) => v * deep), -dot(eye, ahead) * deep - (2 * far * near) / (far - near)],
			[...ahead, -dot(eye, ahead)],
		];
		const matrix = new Float32Array(16);
		for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) matrix[column * 4 + row] = rows[row][column];
		return matrix;
	}

	/** The line of sight from the camera through a place on the screen, which is given from -1 to 1 both ways. */
	#sight(camera, sx, sy) {
		const reach = Math.tan(FIELD / 2);
		return unit([0, 1, 2].map((i) => camera.ahead[i] + camera.right[i] * sx * reach * camera.aspect + camera.up[i] * sy * reach));
	}

	/** Where on the screen, from -1 to 1 both ways, a place given by the mouse is. */
	#onScreen(clientX, clientY) {
		const box = canvas.app.view.getBoundingClientRect();
		return [((clientX - box.left) / box.width) * 2 - 1, 1 - ((clientY - box.top) / box.height) * 2];
	}

	/** Where a line of sight meets the level plane at a height; null when it runs away from it. */
	#onPlane(camera, direction, z) {
		if (Math.abs(direction[2]) < 1e-6) return null;
		const t = (z - camera.eye[2]) / direction[2];
		return t > 0 ? along(camera.eye, direction, t) : null;
	}

	/**
	 * What the line of sight through a place on the screen meets first: a token, a floor of one
	 * of the levels, or the ground. The place it meets it at, or null for the sky.
	 */
	#meets(sx, sy) {
		const camera = this.#camera;
		const scene = this.#scene;
		if (!camera || !scene) return null;
		const direction = this.#sight(camera, sx, sy);
		let best = null;
		const take = (t) => {
			if (t > 0 && (!best || t < best.t)) best = { t, at: along(camera.eye, direction, t) };
		};
		const ground = this.#onPlane(camera, direction, scene.floor);
		if (ground) take((scene.floor - camera.eye[2]) / direction[2]);
		for (const floor of this.#floors) {
			const at = this.#onPlane(camera, direction, floor.z);
			if (!at) continue;
			const { area, t } = floor;
			if (t ? inTriangles(at[0], at[1], t) : (at[0] >= area.x && at[1] >= area.y && at[0] <= area.x + area.width && at[1] <= area.y + area.height)) {
				take((floor.z - camera.eye[2]) / direction[2]);
			}
		}
		for (const token of scene.tokens) {
			// its top
			const top = this.#onPlane(camera, direction, token.top);
			if (top && Math.hypot(top[0] - token.x, top[1] - token.y) <= token.radius) take((token.top - camera.eye[2]) / direction[2]);
			// its side: where the line, seen from above, enters the token's circle
			const ox = camera.eye[0] - token.x;
			const oy = camera.eye[1] - token.y;
			const a = direction[0] * direction[0] + direction[1] * direction[1];
			const b = 2 * (ox * direction[0] + oy * direction[1]);
			const c = ox * ox + oy * oy - token.radius * token.radius;
			const inside = b * b - 4 * a * c;
			if (a > 1e-9 && inside >= 0) {
				const t = (-b - Math.sqrt(inside)) / (2 * a);
				const z = camera.eye[2] + direction[2] * t;
				if (z >= token.bottom && z <= token.top) take(t);
			}
		}
		return best?.at ?? null;
	}

	/**
	 * Where on the scene the mouse is, as Foundry is to take it: `{ x, y }` of what its line of
	 * sight meets, or, while the left button holds something, of where the line passes the
	 * height it took hold at. Null for the sky, and while the view is not shown.
	 */
	sceneAt(clientX, clientY) {
		const camera = this.#camera;
		if (!camera) return null;
		const [sx, sy] = this.#onScreen(clientX, clientY);
		const at = this.#held === null ? this.#meets(sx, sy) : this.#onPlane(camera, this.#sight(camera, sx, sy), this.#held);
		return at ? { x: at[0], y: at[1] } : null;
	}

	/** Where on the screen a place on the ground of the scene is seen, as the mouse would give it. */
	clientAt(place) {
		const camera = this.#camera;
		if (!camera) return null;
		const from = sub([place.x, place.y, camera.floor], camera.eye);
		const deep = dot(from, camera.ahead);
		if (deep <= 0) return null;
		const zoom = 1 / Math.tan(FIELD / 2);
		const box = canvas.app.view.getBoundingClientRect();
		return { x: box.left + (((dot(from, camera.right) * zoom) / camera.aspect / deep + 1) / 2) * box.width,
			y: box.top + ((1 - (dot(from, camera.up) * zoom) / deep) / 2) * box.height };
	}

	/**
	 * PIXI's turning of a place of the mouse into a place of Foundry's flat picture, done by way
	 * of the scene in perspective. `point` gets the place of the picture where Foundry has drawn
	 * what the mouse is on.
	 * @returns {boolean} false while the view is not shown, and PIXI has to do it its own way
	 */
	mapPointer(point, clientX, clientY) {
		if (!this.#camera) return false;
		const at = this.sceneAt(clientX, clientY);
		if (at) canvas.stage.worldTransform.apply(at, point);
		else point.set(-1e7, -1e7);
		return true;
	}

	/* -------------------------------------------- */
	/*  The mouse, as far as it is the camera's      */
	/* -------------------------------------------- */

	#onDown(event) {
		if (event.target !== canvas.app?.view) return;
		if (event.button === 0) {
			// what the left button takes hold of is moved at the height it was taken hold at
			const at = this.#meets(...this.#onScreen(event.clientX, event.clientY));
			this.#held = at ? at[2] : null;
			return;
		}
		if (event.button !== 1 && event.button !== 2) return;
		event.stopImmediatePropagation();
		event.preventDefault();
		this.#drag = { mode: event.button === 1 || event.shiftKey ? 'turn' : 'move', id: event.pointerId, x: event.clientX, y: event.clientY };
	}

	#onMove(event) {
		const drag = this.#drag;
		if (!drag || event.pointerId !== drag.id) return;
		event.stopImmediatePropagation();
		const camera = this.#camera;
		if (camera && drag.mode === 'move') {
			// the ground that was under the mouse stays under it
			const was = this.#onPlane(camera, this.#sight(camera, ...this.#onScreen(drag.x, drag.y)), camera.floor);
			const now = this.#onPlane(camera, this.#sight(camera, ...this.#onScreen(event.clientX, event.clientY)), camera.floor);
			const far = this.#distance * 12;
			if (was && now && Math.hypot(was[0] - camera.eye[0], was[1] - camera.eye[1]) < far && Math.hypot(now[0] - camera.eye[0], now[1] - camera.eye[1]) < far) {
				this.#target = { x: this.#target.x + was[0] - now[0], y: this.#target.y + was[1] - now[1] };
				this.#camera = this.#stand(camera.floor, camera.aspect);
			}
		} else if (drag.mode === 'turn') {
			this.#turn -= (event.clientX - drag.x) * 0.006;
			this.#tilt = clamp(this.#tilt + (event.clientY - drag.y) * 0.005, FLATTEST, STEEPEST);
		}
		drag.x = event.clientX;
		drag.y = event.clientY;
	}

	#onUp(event) {
		if (event.button === 0 || event.type === 'pointercancel') this.#held = null;
		if (!this.#drag || event.pointerId !== this.#drag.id) return;
		event.stopImmediatePropagation();
		this.#drag = null;
	}

	#onWheel(event) {
		if (document.elementFromPoint(event.clientX, event.clientY) !== canvas.app?.view) return;
		event.stopImmediatePropagation();
		event.preventDefault();
		const { width, height } = canvas.dimensions?.rect ?? { width: 4000, height: 4000 };
		this.#distance = clamp(this.#distance * Math.exp((event.deltaY || event.deltaX) * 0.0012), 60, Math.hypot(width, height) * 4);
	}

	/* -------------------------------------------- */
	/*  Drawing                                     */
	/* -------------------------------------------- */

	#frame() {
		const gl = this.#gl;
		const board = canvas.app?.view;
		if (!gl || !board || gl.isContextLost()) return;
		try {
			this.#draw(gl, board);
		} catch (error) {
			console.error('cover-quadtree-view: the view in perspective failed', error);
			this.stop();
		}
	}

	#draw(gl, board) {
		const overlay = this.#overlay;
		const box = board.getBoundingClientRect();
		if (overlay.width !== board.width || overlay.height !== board.height) {
			overlay.width = board.width;
			overlay.height = board.height;
		}
		Object.assign(overlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });

		// Foundry's picture of this frame, and how the scene lies in it
		const made = this.#made;
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, made.picture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, board);
		const lies = canvas.stage.worldTransform;
		const screen = canvas.app.renderer.screen;
		const shown = (x, y) => [(lies.a * x + lies.c * y + lies.tx) / screen.width, (lies.b * x + lies.d * y + lies.ty) / screen.height];

		const scene = this.#describe();
		this.#scene = scene;
		// the camera looks at a place on the floor of the viewed level
		const camera = this.#stand(scene.viewedBase, overlay.width / Math.max(overlay.height, 1));
		this.#camera = camera;

		// What is drawn solid goes in lots, each with the pictures it shows; what is drawn
		// see-through goes in pieces, each with how far it is; and there are lines.
		const lots = [];
		const lot = (more = {}) => {
			const made = { list: [], ...more };
			lots.push(made);
			return made.list;
		};
		const solid = lot();
		const glass = [];
		const lines = [];
		const white = [1, 1, 1];
		// `image`: 0 for the color alone, 1 for Foundry's picture at the place, or where in a picture
		const vertex = (list, p, color, alpha, image = 0) => {
			const [u, v] = Array.isArray(image) ? image : (image ? shown(p[0], p[1]) : [0, 0]);
			list.push(p[0], p[1], p[2], color[0], color[1], color[2], alpha, u, v, image ? 1 : 0);
		};
		const triangle = (list, a, b, c, color, alpha, image = 0) => {
			vertex(list, a, color, alpha, image);
			vertex(list, b, color, alpha, image);
			vertex(list, c, color, alpha, image);
		};
		const line = (a, b, color, alpha = 1) => {
			vertex(lines, a, color, alpha);
			vertex(lines, b, color, alpha);
		};
		const piece = (middle, fill) => {
			const list = [];
			fill(list);
			glass.push({ far: Math.hypot(...sub(middle, camera.eye)), list });
		};
		const rectangle = (list, area, z, color, image = 0) => {
			const [x0, y0, x1, y1] = [area.x, area.y, area.x + area.width, area.y + area.height];
			triangle(list, [x0, y0, z], [x1, y0, z], [x1, y1, z], color, 1, image);
			triangle(list, [x0, y0, z], [x1, y1, z], [x0, y1, z], color, 1, image);
		};
		const flat = (list, floor, color, image = 0) => {
			const { z, t } = floor;
			for (let i = 0; i + 5 < t.length; i += 6) triangle(list, [t[i], t[i + 1], z], [t[i + 2], t[i + 3], z], [t[i + 4], t[i + 5], z], color, 1, image);
		};

		// the part of the scene Foundry's picture holds
		const view = this.#viewed(lies, screen);
		const all = canvas.dimensions?.rect ?? view;
		const x0 = Math.max(view.x, all.x);
		const y0 = Math.max(view.y, all.y);
		const held = { x: x0, y: y0, width: Math.min(view.x + view.width, all.x + all.width) - x0, height: Math.min(view.y + view.height, all.y + all.height) - y0 };

		// The levels. The viewed one shows Foundry's picture on its floors; each other one is a
		// lot of its own, with its picture and the light traced for it.
		const floors = [];
		const area = scene.area ?? all;
		const inverse = (r) => (r ? [r.x, r.y, 1 / Math.max(r.width, 1), 1 / Math.max(r.height, 1)] : [0, 0, 0, 0]);
		for (const level of scene.levels) {
			if (level.viewed) {
				if (level.plane && held.width > 0 && held.height > 0) rectangle(solid, held, level.base, white, 1);
				for (const floor of level.floors) flat(solid, floor, white, 1);
			} else {
				const picture = this.#image(gl, level.image);
				const light = this.#light(gl, level.id, level.light);
				const list = lot({ lit: true, picture, light, pictureArea: inverse(area), lightArea: inverse(scene.lightArea) });
				const color = picture ? white : level.color ?? white;
				if (level.plane) rectangle(list, area, level.base, color);
				for (const floor of level.floors) flat(list, floor, color);
			}
			if (level.plane) floors.push({ z: level.base, area: level.viewed ? all : area });
			for (const floor of level.floors) floors.push({ z: floor.z, t: floor.t });
		}
		this.#floors = floors;

		// the surfaces that are no floor of any level are see-through
		for (const surface of scene.surfaces) {
			const { z, t } = surface;
			for (let i = 0; i + 5 < t.length; i += 6) {
				const corners = [[t[i], t[i + 1], z], [t[i + 2], t[i + 3], z], [t[i + 4], t[i + 5], z]];
				piece(corners[0].map((v, k) => (v + corners[1][k] + corners[2][k]) / 3), (list) => triangle(list, ...corners, FLOOR, 0.22));
			}
		}

		for (const wall of scene.walls) {
			const bottom = Number.isFinite(wall.bottom) ? wall.bottom : scene.floor;
			const open = !Number.isFinite(wall.top);
			const top = open ? Math.max(bottom, scene.floor) + scene.tall : wall.top;
			const color = wall.mirror ? MIRROR : WALL;
			const corners = [[wall.a.x, wall.a.y, bottom], [wall.b.x, wall.b.y, bottom], [wall.b.x, wall.b.y, top], [wall.a.x, wall.a.y, top]];
			piece([(wall.a.x + wall.b.x) / 2, (wall.a.y + wall.b.y) / 2, (bottom + top) / 2], (list) => {
				triangle(list, corners[0], corners[1], corners[2], color, open ? 0.16 : 0.34);
				triangle(list, corners[0], corners[2], corners[3], color, open ? 0.16 : 0.34);
			});
			for (let i = 0; i < 4; i++) line(corners[i], corners[(i + 1) % 4], color, open ? 0.5 : 0.95);
		}

		// A token: its side is lit from where the camera's right is. Its top shows Foundry's
		// picture of it where Foundry has drawn it, and its own picture otherwise.
		for (const token of scene.tokens) {
			const rim = Array.from({ length: SIDES }, (_, i) => {
				const turn = (i / SIDES) * 2 * Math.PI;
				return [token.x + Math.cos(turn) * token.radius, token.y + Math.sin(turn) * token.radius, Math.cos(turn), Math.sin(turn)];
			});
			// a token that has no height is its top alone, a little off the floor it lies on
			const top = Math.max(token.top, token.bottom + 0.5);
			const edge = token.picked ? PICKED : BODY;
			const own = token.image ? this.#image(gl, token.image) : null;
			const cap = token.image ? (own ? lot({ picture: own }) : solid) : solid;
			const inPicture = (p) => (token.image ? (own ? [0.5 + p[2] / 2, 0.5 + p[3] / 2] : 0) : 1);
			const middle = token.image ? (own ? [0.5, 0.5] : 0) : 1;
			const capColor = token.image && !own ? BODY : white;
			for (let i = 0; i < SIDES; i++) {
				const p = rim[i];
				const q = rim[(i + 1) % SIDES];
				vertex(cap, [token.x, token.y, top], capColor, 1, middle);
				vertex(cap, [p[0], p[1], top], capColor, 1, inPicture(p));
				vertex(cap, [q[0], q[1], top], capColor, 1, inPicture(q));
				line([p[0], p[1], top], [q[0], q[1], top], edge);
				if (token.top > token.bottom) {
					const lit = 0.55 + 0.45 * Math.max(0, p[2] * camera.right[0] + p[3] * camera.right[1]);
					const color = BODY.map((v) => v * lit);
					triangle(solid, [p[0], p[1], token.bottom], [q[0], q[1], token.bottom], [q[0], q[1], top], color, 1);
					triangle(solid, [p[0], p[1], token.bottom], [q[0], q[1], top], [p[0], p[1], top], color, 1);
					line([p[0], p[1], token.bottom], [q[0], q[1], token.bottom], edge, 0.8);
				}
			}
		}

		// The cover test. From where the source looks from, each target fills a cone of lines of
		// sight: on the map between the two directions that just touch it, and in each direction
		// from the lowest to the highest it is seen at (the same as the script works out, see
		// seenBetween in the script). The cone is drawn where it ends on the target, stretch by
		// stretch round it and part by part up it: red where the walls stop the line of sight
		// before it gets there, yellow where it gets there. Faint sheets from where the source
		// looks from show the lines of sight, and four lines the corners of the cone.
		for (const test of scene.cover) {
			const { eye, centre, radius, bottom, top } = test;
			line(test.line[0], test.line[1], INK, 0.9);
			const count = Math.max(test.heights, 1);
			// The look in a direction, told by where round the target it enters the target's circle:
			// how far that is on the map, and from how low to how high the target is seen there.
			const look = (turn) => {
				const dx = centre.x + Math.cos(turn) * radius - eye[0];
				const dy = centre.y + Math.sin(turn) * radius - eye[1];
				const near = Math.hypot(dx, dy) || 1;
				const ux = dx / near;
				const uy = dy / near;
				// how far the look runs on inside the circle
				const away = near + Math.max(0, -2 * radius * (ux * Math.cos(turn) + uy * Math.sin(turn)));
				return { turn, near, ux, uy,
					low: eye[2] < bottom ? Math.atan2(bottom - eye[2], away) : Math.atan2(bottom - eye[2], near),
					high: eye[2] > top ? Math.atan2(top - eye[2], away) : Math.atan2(top - eye[2], near) };
			};
			// Where the line of sight of a look meets the target, `part` of the way from the lowest
			// to the highest: on its side, or on its top or bottom. A little off the target, so
			// that what is drawn there lies on it and not in it.
			const meets = (seen, part) => {
				const rise = Math.tan(seen.low + (seen.high - seen.low) * part);
				const z = eye[2] + rise * seen.near;
				if (z > top && rise < 0) {
					const run = (top - eye[2]) / rise;
					return [eye[0] + seen.ux * run, eye[1] + seen.uy * run, top + 1];
				}
				if (z < bottom && rise > 0) {
					const run = (bottom - eye[2]) / rise;
					return [eye[0] + seen.ux * run, eye[1] + seen.uy * run, bottom - 1];
				}
				const out = radius * 1.03 + 1;
				return [centre.x + Math.cos(seen.turn) * out, centre.y + Math.sin(seen.turn) * out, clamp(z, bottom, top)];
			};
			let first = null;
			let last = null;
			for (const run of test.runs) {
				const from = Math.atan2(run.from.y - centre.y, run.from.x - centre.x);
				let span = Math.atan2(run.to.y - centre.y, run.to.x - centre.x) - from;
				while (span > Math.PI) span -= 2 * Math.PI;
				while (span <= -Math.PI) span += 2 * Math.PI;
				const steps = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 14)));
				const looks = Array.from({ length: steps + 1 }, (_, s) => look(from + (span * s) / steps));
				first ??= looks[0];
				last = looks[steps];
				for (let j = 0; j < count; j++) {
					const color = (run.mask >> j) & 1 ? HIDDEN : SEEN;
					const lower = j / count;
					const upper = (j + 1) / count;
					const half = (lower + upper) / 2;
					const middle = meets(looks[steps >> 1], half);
					piece(middle, (list) => {
						for (let s = 0; s < steps; s++) {
							const corners = [meets(looks[s], lower), meets(looks[s + 1], lower), meets(looks[s + 1], upper), meets(looks[s], upper)];
							triangle(list, corners[0], corners[1], corners[2], color, 0.7);
							triangle(list, corners[0], corners[2], corners[3], color, 0.7);
						}
					});
					const ends = [meets(looks[0], half), meets(looks[steps], half)];
					piece(eye.map((v, i) => (v + middle[i]) / 2), (list) => triangle(list, eye, ends[0], ends[1], color, 0.1));
					// a stretch of one direction, or a target seen edge on, has no area to show
					line(meets(looks[0], lower), meets(looks[0], upper), color, 0.6);
					line(ends[0], ends[1], color, 0.35);
				}
			}
			if (first) for (const [seen, part] of [[first, 0], [first, 1], [last, 0], [last, 1]]) line(eye, meets(seen, part), INK, 0.45);
		}

		// a traced light: a small square that faces the camera, on a stem down to the lowest floor
		for (const light of scene.lights) {
			const at = [light.x, light.y, light.z];
			line([light.x, light.y, scene.floor], at, LAMP, 0.9);
			const size = Math.hypot(...sub(at, camera.eye)) * 0.008;
			const corner = (sx, sy) => [0, 1, 2].map((i) => at[i] + (camera.right[i] * sx + camera.up[i] * sy) * size);
			const color = light.color ?? white;
			triangle(solid, corner(-1, -1), corner(1, -1), corner(1, 1), color, 1);
			triangle(solid, corner(-1, -1), corner(1, 1), corner(-1, 1), color, 1);
		}

		gl.viewport(0, 0, overlay.width, overlay.height);
		const back = canvas.app.renderer.background?.color;
		const [r, g, b] = typeof back === 'number' ? [(back >> 16) & 255, (back >> 8) & 255, back & 255].map((v) => v / 510) : [0.07, 0.07, 0.08];
		gl.clearColor(r, g, b, 1);
		gl.clearDepth(1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(made.program);
		const at = made.at;
		gl.uniformMatrix4fv(at.u_camera, false, this.#matrix(camera));
		gl.uniform3fv(at.u_dark, scene.dark);
		gl.uniform3fv(at.u_bright, scene.bright);
		gl.bindBuffer(gl.ARRAY_BUFFER, made.buffer);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.disable(gl.CULL_FACE);
		// one lot, or the see-through pieces, or the lines: with the pictures they show
		const put = (list, kind, more = {}) => {
			if (!list.length) return;
			gl.uniform1i(at.u_lit, more.lit ? 1 : 0);
			gl.uniform1i(at.u_hasPicture, more.picture ? 1 : 0);
			gl.uniform1i(at.u_hasLight, more.light ? 1 : 0);
			if (more.lit) {
				gl.uniform4fv(at.u_pictureArea, more.pictureArea);
				gl.uniform4fv(at.u_lightArea, more.lightArea);
			}
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, more.light ?? made.picture);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, more.picture ?? made.picture);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(list), gl.DYNAMIC_DRAW);
			gl.drawArrays(kind, 0, list.length / STRIDE);
		};
		gl.disable(gl.BLEND);
		gl.depthMask(true);
		for (const each of lots) put(each.list, gl.TRIANGLES, each);
		// the see-through pieces from the farthest to the nearest, hidden by what is solid before them
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		glass.sort((p, q) => q.far - p.far);
		put(glass.flatMap((entry) => entry.list), gl.TRIANGLES);
		put(lines, gl.LINES);
		gl.depthMask(true);

		this.#follow(camera, view, all, screen);
	}

	/** The part of the scene Foundry's picture holds, as a rectangle on the scene. */
	#viewed(lies, screen) {
		const corners = [[0, 0], [screen.width, 0], [screen.width, screen.height], [0, screen.height]].map(([x, y]) => lies.applyInverse({ x, y }));
		const xs = corners.map((p) => p.x);
		const ys = corners.map((p) => p.y);
		return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
	}

	/**
	 * Moves Foundry's own view to the part of the ground the camera sees, so that the next
	 * picture holds it, as large as the screen lets it be. Foundry's view is left alone while it
	 * still holds all of that part without being much too wide for it, so that the picture does
	 * not swim under a camera that moves a little.
	 */
	#follow(camera, view, all, screen) {
		if (!canvas.pan) return;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		const reach = this.#distance * 8;
		for (let i = 0; i <= 8; i++) {
			for (let j = 0; j <= 8; j++) {
				const direction = this.#sight(camera, i / 4 - 1, j / 4 - 1);
				let at = this.#onPlane(camera, direction, camera.floor);
				// towards the horizon the ground goes on for ever; so far is far enough
				if (!at || Math.hypot(at[0] - camera.eye[0], at[1] - camera.eye[1]) > reach) {
					const level = Math.hypot(direction[0], direction[1]) || 1;
					at = [camera.eye[0] + (direction[0] / level) * reach, camera.eye[1] + (direction[1] / level) * reach];
				}
				x0 = Math.min(x0, at[0]);
				y0 = Math.min(y0, at[1]);
				x1 = Math.max(x1, at[0]);
				y1 = Math.max(y1, at[1]);
			}
		}
		x0 = Math.max(x0, all.x);
		y0 = Math.max(y0, all.y);
		x1 = Math.min(x1, all.x + all.width);
		y1 = Math.min(y1, all.y + all.height);
		if (!(x1 > x0 && y1 > y0)) return;
		const holds = view.x <= x0 + 1 && view.y <= y0 + 1 && view.x + view.width >= x1 - 1 && view.y + view.height >= y1 - 1;
		const wanted = Math.min(screen.width / (x1 - x0), screen.height / (y1 - y0)) / 1.12;
		const scale = canvas.stage.scale.x;
		if (holds && scale > wanted / 1.6) return;
		const least = canvas.dimensions?.scale?.min ?? 0;
		// Foundry will not show more than so much at once: then what it does show stays as it is
		if (!holds && wanted < least && Math.abs(scale - least) < 1e-6 && Math.hypot(canvas.stage.pivot.x - (x0 + x1) / 2, canvas.stage.pivot.y - (y0 + y1) / 2) < 1) return;
		canvas.pan({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, scale: wanted });
	}
}
