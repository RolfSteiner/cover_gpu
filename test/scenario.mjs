// A run through the module on the scene of module.html, with a digest of what it answered.
//
//   const { run, compare } = await import('/test/scenario.mjs');
//   const digest = await run(window.h);
//
// The digest holds numbers and short texts only, so that two runs can be compared: one with
// the module as it was, one with the module as it is (`compare`). It goes through what tokens
// see over walls and in mirrors, the path traced light and where it counts as lit, the cover
// test, a ray, the isometric view and the view in perspective.
//
// To compare with an earlier state of the repository, serve a checkout of that state next to
// this one (see server.mjs, `before`), run the scenario on its module.html, keep the digest
// (`localStorage`, which the two pages share), and compare on this one.

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The points of everything a PIXI.Graphics holds, in drawing order. */
function drawn(graphics) {
	const points = [];
	for (const data of graphics.geometry?.graphicsData ?? []) {
		const shape = data.shape;
		if (shape.points) points.push(...shape.points);
		else points.push(shape.x, shape.y, shape.radius ?? shape.width ?? 0, shape.height ?? 0);
	}
	return points.map((value) => round(value));
}

export async function run(h) {
	const digest = {};
	const layer = h.layer;
	const step = async (name, work) => {
		try {
			digest[name] = await work();
		} catch (error) {
			digest[name] = { failed: String(error?.stack ?? error) };
		}
	};
	const settle = () => h.sleep(700);

	const ann = h.makeToken('ann', 'Ann', 1950, 1650);
	const bob = h.makeToken('bob', 'Bob', 2700, 1500, 200);
	const cy = h.makeToken('cy', 'Cy', 2300, 2300);
	const dee = h.makeToken('dee', 'Dee', 1300, 1700);
	dee.document.elevation = 10;
	h.tokens.placeables.push(ann, bob, cy, dee);
	h.drawTokens();

	await step('heights', async () => {
		// low walls round Ann, a raised floor under Bob, and mirrors
		const low = [h.wallNear(2000, 1750), h.wallNear(2300, 1500), h.wallNear(2500, 1900)];
		for (const wall of low) wall.document.flags['wall-height'] = { bottom: 0, top: 3 };
		h.wallNear(2600, 2600).document.flags['wall-height'] = { bottom: 6 };
		h.makeSurface(8, [2600, 1300, 3200, 1900]);
		h.makeSurface(4, [1000, 2200, 1800, 2800], { sight: false });
		for (const at of [[2200, 2100], [1700, 1300], [2900, 2300], [1500, 2000]]) {
			h.wallNear(...at).document.flags['cover-quadtree-view'] = { metallicLeft: 1, smoothnessLeft: 1, metallicRight: 1, smoothnessRight: 1 };
		}
		await h.wallsChanged();
		await h.regionsChanged();
		return low.map((wall) => wall.document.c.join());
	});

	await step('lights', async () => {
		h.makeLight({ x: 2100, y: 1800, dim: 900, bright: 450, elevation: 4 });
		h.makeLight({ x: 3400, y: 2600, dim: 700, bright: 200, angle: 120, rotation: 40, alpha: 0.8, attenuation: 0.2 }, [1, 0.6, 0.3]);
		h.makeLight({ x: 1200, y: 900, dim: 600, bright: 300, animation: { type: 'torch' } });
		h.makeLight({ x: 4400, y: 1200, dim: 0, bright: 0 });
		await h.toggle('lights', true);
		await h.lightingChanged();
		await settle();
		const lit = [];
		const levels = [];
		for (let y = 100; y < 4600; y += 150) {
			for (let x = 100; x < 6000; x += 150) {
				lit.push(layer.isLit({ x, y }) ? 1 : 0);
				levels.push(layer.lightLevelAt({ x, y }) ?? 9);
			}
		}
		const pixels = [];
		for (let y = 100; y < 4600; y += 300) for (let x = 100; x < 6000; x += 300) pixels.push(...(await h.lightAt(x, y)));
		return { lit: lit.join(''), levels: levels.join(''), pixels, lighting: h.lighting(), label: h.labels().filter((text) => /light/i.test(text)).map((text) => text.replace(/[\d.]+ ms/, 'ms')) };
	});

	await step('mirrors', async () => {
		h.seeing(ann, 1500);
		h.seeing(cy, 900);
		await settle();
		const views = h.visionSources.filter((source) => source.mirrored).sort((p, q) => (p.sourceId < q.sourceId ? -1 : 1));
		return { count: layer.mirrorViews, ids: views.map((source) => `${source.sourceId} ${source.data.x},${source.data.y}`), outline: views.map((source) => source.los.points.map((value) => round(value))),
			effects: h.visionEffects().sort() };
	});

	await step('sight', async () => {
		const all = [ann, bob, cy, dee];
		const over = [];
		const mirrored = [];
		const tested = [];
		for (const from of all) {
			for (const to of all) {
				if (from === to) continue;
				over.push(layer.seesOver(from, to) ? 1 : 0);
				mirrored.push(layer.seesByMirrors(from, to) ? 1 : 0);
			}
		}
		for (const token of all) tested.push(canvas.visibility.testVisibility(token.center, { object: token }) ? 1 : 0);
		const places = [];
		for (let y = 1000; y < 3000; y += 125) for (let x = 1000; x < 3600; x += 125) places.push(canvas.visibility.testVisibility({ x, y }) ? 1 : 0);
		return { over: over.join(''), mirrored: mirrored.join(''), tested: tested.join(''), places: places.join('') };
	});

	await step('cover', async () => {
		await h.select(ann);
		await h.sleep(200);
		const labels = h.labels().map((text) => text.replace(/[\d.]+ ms/, 'ms')).sort();
		const shares = [];
		for (const token of [bob, cy, dee]) {
			shares.push(round(layer.coverShare({ x: 2000, y: 1700 }, token) ?? -1, 4), round(layer.coverShare(ann.center, token, ann) ?? -1, 4));
		}
		shares.push(round(layer.coverShare({ x: 2000, y: 1700, elevation: 12 }, bob) ?? -1, 4));
		return { labels, shares, drawn: drawn(layer.children[2]) };
	});

	await step('ray', async () => {
		h.tool('ray');
		h.drag({ x: 1200, y: 1200 }, { x: 3600, y: 2900 });
		await h.frame();
		const labels = h.labels().map((text) => text.replace(/[\d.]+ ms/, 'ms')).sort();
		h.tool('move');
		return { labels, marks: h.marks() };
	});

	await step('isometric', async () => {
		await h.toggle('isometric', true);
		await h.sleep(200);
		const labels = layer.children[6].children.map((label) => [label.worldTransform.a, label.worldTransform.b, label.worldTransform.c, label.worldTransform.d, label.worldTransform.tx, label.worldTransform.ty].map((v) => round(v)));
		const made = { drawnBodies: drawn(layer.children[4]), drawnWalls: drawn(layer.children[1]), drawnRays: drawn(layer.children[3]),
			stage: [canvas.stage.rotation, canvas.stage.skew.x].map((v) => round(v, 4)), drawnLabels: labels.flat() };
		await h.toggle('isometric', false);
		await h.sleep(100);
		return made;
	});

	await step('perspective', async () => {
		// a second level over the first, with a floor of its own, and Foundry's view on the busy part
		const ground = { id: 'ground', elevation: { bottom: 0, top: 12 } };
		h.sceneDocument.levels.set('ground', ground);
		h.sceneDocument.levels.set('upper', { id: 'upper', elevation: { bottom: 12, top: 30 }, background: { color: { rgb: [0.3, 0.5, 0.4] } } });
		canvas.level = ground;
		h.makeSurface(12, [1400, 1000, 2400, 1600]);
		await h.regionsChanged();
		canvas.pan({ x: 2400, y: 1900, scale: 0.25 });
		await h.toggle('perspective', true);
		await h.sleep(900);
		const overlay = document.getElementById('cover-view-3d');
		const gl = overlay.getContext('webgl2');
		const box = canvas.app.view.getBoundingClientRect();
		const picks = () => {
			const list = [];
			for (let j = 1; j < 16; j++) {
				for (let i = 1; i < 20; i++) {
					const at = layer.sceneFromClient({ x: box.left + (box.width * i) / 20, y: box.top + (box.height * j) / 16 });
					list.push(at ? round(at.x) : -1, at ? round(at.y) : -1);
				}
			}
			return list;
		};
		const pixels = () => {
			// the picture is whole right after it was drawn
			canvas.app.ticker.update();
			const all = new Uint8Array(overlay.width * overlay.height * 4);
			gl.readPixels(0, 0, overlay.width, overlay.height, gl.RGBA, gl.UNSIGNED_BYTE, all);
			const list = [];
			for (let j = 1; j < 36; j++) {
				for (let i = 1; i < 48; i++) {
					const at = (Math.round((overlay.height * j) / 36) * overlay.width + Math.round((overlay.width * i) / 48)) * 4;
					list.push(all[at], all[at + 1], all[at + 2]);
				}
			}
			return list;
		};
		const back = () => [[2000, 1700], [3000, 1600], [1000, 4000], [5500, 300]].flatMap(([x, y]) => {
			const at = layer.clientFromScene({ x, y });
			return at ? [round(at.x - box.left), round(at.y - box.top)] : [-1, -1];
		});
		const made = { size: `${overlay.width}x${overlay.height}`, first: { picks: picks(), back: back(), pixels: pixels() } };
		// the camera: closer, turned, and moved
		const mouse = (type, x, y, more = {}) => canvas.app.view.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse',
			clientX: box.left + x, clientY: box.top + y, ...more }));
		const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -400, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });
		// the wheel goes by what lies under the mouse
		const under = document.elementFromPoint;
		document.elementFromPoint = () => canvas.app.view;
		window.dispatchEvent(wheel);
		document.elementFromPoint = under;
		mouse('pointerdown', 400, 400, { button: 1, buttons: 4 });
		mouse('pointermove', 520, 340, { button: -1, buttons: 4 });
		mouse('pointerup', 520, 340, { button: 1 });
		await h.sleep(100);
		mouse('pointerdown', 600, 500, { button: 2, buttons: 2 });
		mouse('pointermove', 500, 430, { button: -1, buttons: 2 });
		mouse('pointerup', 500, 430, { button: 2 });
		await h.sleep(400);
		made.second = { picks: picks(), back: back(), pixels: pixels() };
		// the left button holds a token at the height it was taken at
		const top = layer.clientFromScene({ x: bob.center.x, y: bob.center.y });
		if (top) {
			mouse('pointerdown', top.x - box.left, top.y - box.top, { button: 0, buttons: 1 });
			const held = layer.sceneFromClient({ x: top.x + 40, y: top.y });
			made.held = held ? [round(held.x), round(held.y)] : [-1, -1];
			mouse('pointerup', top.x - box.left, top.y - box.top, { button: 0 });
		}
		made.stage = [canvas.stage.pivot.x, canvas.stage.pivot.y, canvas.stage.scale.x * 1000].map((v) => round(v));
		await h.toggle('perspective', false);
		await h.sleep(200);
		made.after = [canvas.stage.pivot.x, canvas.stage.pivot.y, canvas.stage.scale.x * 1000].map((v) => round(v));
		return made;
	});

	digest.notes = [...h.notes];
	digest.missing = [...h.missing];
	return digest;
}

/**
 * Where two digests differ. Texts have to be the same. Numbers may be a little apart, by what
 * they are: places on the scene and on the screen by a unit (the library works with single
 * floats where the module worked with doubles), colors of pixels by `slack` in each part (a
 * picture is drawn by the graphics card). Of a list of numbers that differs, the answer says how
 * many of them do and by how much at most, not each one.
 * @returns {object[]} `{ path, before, after }` or `{ path, differing, of, most }` each
 */
export function compare(before, after, slack = 12, path = '') {
	const allowed = /pixels/.test(path) ? slack : (/drawn|outline|picks|back|held|stage|after/.test(path) ? 1.5 : (/shares/.test(path) ? 0.002 : 0));
	if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
		if (before.every((value) => typeof value === 'number') && after.every((value) => typeof value === 'number')) {
			let differing = 0;
			let most = 0;
			before.forEach((value, i) => {
				const apart = Math.abs(value - after[i]);
				if (apart > allowed) differing++;
				most = Math.max(most, apart);
			});
			return differing ? [{ path, differing, of: before.length, most }] : [];
		}
		return before.flatMap((value, i) => compare(value, after[i], slack, `${path}[${i}]`));
	}
	if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
		return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => compare(before[key], after[key], slack, `${path}.${key}`));
	}
	if (before === after) return [];
	if (typeof before === 'string' && typeof after === 'string' && before.length === after.length && /^[0-9]+$/.test(before) && before.length > 40) {
		// a row of digits, one per place: how many places differ
		let differing = 0;
		for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differing++;
		return [{ path, differing, of: before.length }];
	}
	return [{ path, before, after }];
}
