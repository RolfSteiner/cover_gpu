// The scene in perspective: a camera that can be moved, turned and brought closer.
//
// Foundry draws a scene flat, seen from straight above, and nothing in it can draw it any other
// way: every picture it makes is laid on the screen by a transform that keeps lines parallel.
// So the view in perspective is a picture of its own, drawn with WebGL on a canvas that lies
// over Foundry's. Foundry goes on drawing underneath, flat, and what it draws is put to use:
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
//    the cover test.
//  - The image only holds the part of the scene that Foundry's own view shows. So Foundry's
//    view is moved here, out of sight, to wherever the camera looks: to the part of the ground
//    the camera sees, as large as the screen lets it be.
//
// Where the camera stands, what it sees as triangles and lines, what the mouse is on, and where
// Foundry's view has to go are all worked out by the script library (src/view3d.das; `view` of
// lib/test_local_gpu_api.js). This file is the rest: the canvas and its WebGL, the pictures as
// textures, and the mouse.
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

/** A vertex is ten numbers: where (3), its color and how solid (4), where in a picture (2), and how much of that picture it shows. */
const STRIDE = 10;

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

export class View3D {
	/**
	 * @param {() => object} describe what there is to draw right now, as `#seen` of layer.mjs
	 *   gives it:
	 *    - `version` and `scene`: what stays from frame to frame, and a number that is another
	 *      one whenever that has changed. `scene` is what `view.scene` of the library takes:
	 *      `floor`, the height of the lowest floor, and `viewedBase`, that of the viewed level;
	 *      `levels`, each `{ viewed, base, plane, color, floors }` with `floors` being `{ z, t }`;
	 *      `area`, `lightArea` and `all`, the rectangles of the scene a level's picture and the
	 *      pictures of the light lie over, and the whole canvas; `walls`, each `{ a, b, bottom,
	 *      top, mirror }` with a bottom or a top not finite where the wall names none, and
	 *      `tall`, how high such a wall is drawn; `surfaces`, each `{ z, t }`;
	 *    - `levels`: per level of `scene.levels`, `{ id, viewed, image, light }`: the address of
	 *      its own picture and the light traced for its floors (see lighting.mjs), where it has them;
	 *    - `tokens`, each `{ x, y, radius, bottom, top, picked, image }`; `lights`, each `{ x, y,
	 *      z, color, strength }`; `cover`, true while the cover test is to be shown; and `dark`
	 *      and `bright`, the colors Foundry gives an unlit and a lit place
	 */
	constructor(describe) {
		this.#describe = describe;
	}

	#describe;

	/** The script library; the view cannot be shown before it is loaded. */
	#cover = null;

	/** The canvas this view is drawn on, its WebGL context, and what was made in it: `{ program, buffer, picture, at }`. */
	#overlay = null;

	#gl = null;

	#made = null;

	/** The pictures loaded for levels and tokens, by their address: `{ texture, ready }`. */
	#images = new Map();

	/** The pictures of the light on the floors of the levels, by the id of the level: `{ texture, version }`. */
	#lights = new Map();

	/** The version of the scene the library was last given, and true once a frame was drawn from it. */
	#version = null;

	#drawn = false;

	/** The drag that moves or turns the camera: `{ mode, id, x, y }`. */
	#drag = null;

	/** How Foundry's view was before this one took it over, and what was changed in the page. */
	#before = null;

	#listeners = [];

	/** True while the view is shown. */
	get active() {
		return Boolean(this.#overlay);
	}

	/** Takes the script library (lib/test_local_gpu_api.js). */
	use(cover) {
		this.#cover = cover;
	}

	/* -------------------------------------------- */
	/*  Showing and hiding                          */
	/* -------------------------------------------- */

	/** Shows the view over Foundry's canvas, looking at what Foundry's view is looking at. */
	start() {
		const board = canvas.app?.view;
		if (this.#overlay || !board || !this.#cover) return;
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
		const scale = stage.scale.x || 1;
		this.#before = { scale, hud: document.getElementById('hud') };
		if (this.#before.hud) this.#before.hud.style.visibility = 'hidden';
		this.#cover.view.start(stage.pivot.x, stage.pivot.y, canvas.app.renderer.screen.height, scale);
		this.#version = null;
		this.#drawn = false;

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
		this.#images = new Map();
		this.#lights = new Map();
		this.#drag = null;
		this.#drawn = false;
		const at = this.#cover.view.lookedAt();
		this.#cover.view.stop();
		if (this.#before?.hud) this.#before.hud.style.visibility = '';
		if (canvas.ready) canvas.pan?.({ x: at.x, y: at.y, scale: this.#before?.scale });
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
		const picture = this.#texture(gl);
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
	/*  The mouse                                   */
	/* -------------------------------------------- */

	/** Where on the screen, from -1 to 1 both ways, a place given by the mouse is. */
	#onScreen(clientX, clientY) {
		const box = canvas.app.view.getBoundingClientRect();
		return [((clientX - box.left) / box.width) * 2 - 1, 1 - ((clientY - box.top) / box.height) * 2];
	}

	/**
	 * Where on the scene the mouse is, as Foundry is to take it: `{ x, y }` of what its line of
	 * sight meets, or, while the left button holds something, of where the line passes the
	 * height it took hold at. Null for the sky, and while the view is not shown.
	 */
	sceneAt(clientX, clientY) {
		return this.#drawn ? this.#cover.view.sceneAt(...this.#onScreen(clientX, clientY)) : null;
	}

	/** Where on the screen a place on the ground of the scene is seen, as the mouse would give it. */
	clientAt(place) {
		const at = this.#drawn ? this.#cover.view.screenAt(place.x, place.y) : null;
		if (!at) return null;
		const box = canvas.app.view.getBoundingClientRect();
		return { x: box.left + at.x * box.width, y: box.top + at.y * box.height };
	}

	/**
	 * PIXI's turning of a place of the mouse into a place of Foundry's flat picture, done by way
	 * of the scene in perspective. `point` gets the place of the picture where Foundry has drawn
	 * what the mouse is on.
	 * @returns {boolean} false while the view is not shown, and PIXI has to do it its own way
	 */
	mapPointer(point, clientX, clientY) {
		if (!this.#drawn) return false;
		const at = this.sceneAt(clientX, clientY);
		if (at) canvas.stage.worldTransform.apply(at, point);
		else point.set(-1e7, -1e7);
		return true;
	}

	#onDown(event) {
		if (event.target !== canvas.app?.view) return;
		if (event.button === 0) {
			// what the left button takes hold of is moved at the height it was taken hold at
			this.#cover.view.press(...this.#onScreen(event.clientX, event.clientY));
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
		if (drag.mode === 'move') this.#cover.view.drag(...this.#onScreen(drag.x, drag.y), ...this.#onScreen(event.clientX, event.clientY));
		else this.#cover.view.turn(event.clientX - drag.x, event.clientY - drag.y);
		drag.x = event.clientX;
		drag.y = event.clientY;
	}

	#onUp(event) {
		if (event.button === 0 || event.type === 'pointercancel') this.#cover.view.release();
		if (!this.#drag || event.pointerId !== this.#drag.id) return;
		event.stopImmediatePropagation();
		this.#drag = null;
	}

	#onWheel(event) {
		if (document.elementFromPoint(event.clientX, event.clientY) !== canvas.app?.view) return;
		event.stopImmediatePropagation();
		event.preventDefault();
		const { width, height } = canvas.dimensions?.rect ?? { width: 4000, height: 4000 };
		this.#cover.view.zoom(event.deltaY || event.deltaX, Math.hypot(width, height));
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

		// Foundry's picture of this frame
		const made = this.#made;
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, made.picture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, board);

		// what there is to see, with the pictures that are there to show
		const seen = this.#describe();
		if (seen.version !== this.#version) {
			this.#cover.view.scene(seen.scene);
			this.#version = seen.version;
		}
		const tokens = seen.tokens.map((token) => {
			const own = this.#image(gl, token.image);
			return { ...token, own, shows: token.image ? (own ? 1 : 2) : 0 };
		});
		const levels = seen.levels.map((level) => (level.viewed ? { picture: null, light: null } : { picture: this.#image(gl, level.image), light: this.#light(gl, level.id, level.light) }));
		const screen = canvas.app.renderer.screen;
		const frame = this.#cover.view.frame({ lies: canvas.stage.worldTransform, width: screen.width, height: screen.height, aspect: overlay.width / Math.max(overlay.height, 1),
			zoom: canvas.stage.scale.x, least: canvas.dimensions?.scale?.min ?? 0, pivot: canvas.stage.pivot, cover: seen.cover }, tokens, seen.lights, levels);
		this.#drawn = true;

		gl.viewport(0, 0, overlay.width, overlay.height);
		const back = canvas.app.renderer.background?.color;
		const [r, g, b] = typeof back === 'number' ? [(back >> 16) & 255, (back >> 8) & 255, back & 255].map((v) => v / 510) : [0.07, 0.07, 0.08];
		gl.clearColor(r, g, b, 1);
		gl.clearDepth(1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(made.program);
		const at = made.at;
		gl.uniformMatrix4fv(at.u_camera, false, frame.matrix);
		gl.uniform3fv(at.u_dark, seen.dark);
		gl.uniform3fv(at.u_bright, seen.bright);
		gl.uniform4fv(at.u_pictureArea, frame.pictureArea);
		gl.uniform4fv(at.u_lightArea, frame.lightArea);
		gl.bindBuffer(gl.ARRAY_BUFFER, made.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, frame.vertices, gl.DYNAMIC_DRAW);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.disable(gl.CULL_FACE);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		// What is solid first; then what is see-through, hidden by what is solid before it, and the lines.
		for (const draw of frame.draws) {
			if (draw.glass) gl.enable(gl.BLEND);
			else gl.disable(gl.BLEND);
			gl.depthMask(!draw.glass);
			const picture = draw.shows === 1 ? (draw.lit ? levels[draw.ref].picture : tokens[draw.ref].own) : null;
			const light = draw.light >= 0 ? levels[draw.light].light : null;
			gl.uniform1i(at.u_lit, draw.lit ? 1 : 0);
			gl.uniform1i(at.u_hasPicture, picture ? 1 : 0);
			gl.uniform1i(at.u_hasLight, light ? 1 : 0);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, light ?? made.picture);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, picture ?? made.picture);
			gl.drawArrays(draw.lines ? gl.LINES : gl.TRIANGLES, draw.first, draw.count);
		}
		gl.depthMask(true);

		// Foundry's own view goes to the part of the ground the camera sees, so that its next picture holds it
		if (frame.follow && canvas.pan) canvas.pan(frame.follow);
	}
}
