// The sheet of a wall (WallConfig, an ApplicationV2 document sheet) gets four more fields: how
// metallic and how smooth each of the two faces of the wall is, which is what the path traced
// light goes by when it falls on the wall. They are form fields named after the flags they
// set, so the sheet saves them with the rest of the wall: flags.cover-quadtree-view.metallicLeft,
// .smoothnessLeft, .metallicRight and .smoothnessRight.

import { MODULE_ID, SURFACE } from './settings.mjs';
import { wallSurface } from './quadtree.mjs';

const MARK = 'cover-view-surface';

/** A field for a share from 0 to 1: Foundry's slider with a number next to it, where it has one. */
function shareInput(name, share, id) {
	const Picker = foundry.applications.elements?.HTMLRangePickerElement;
	if (Picker) return Picker.create({ name, id, value: share, min: 0, max: 1, step: 0.05 });
	const input = document.createElement('input');
	Object.assign(input, { type: 'number', name, id, min: '0', max: '1', step: '0.05', value: String(share) });
	return input;
}

/**
 * Adds the fields to a wall's sheet that has just been drawn. To be called from the
 * renderWallConfig hook; drawing the sheet again draws its body anew, without the fields, and
 * the hook adds them again.
 *
 * @param {WallConfig} app the sheet
 * @param {HTMLElement} element the element of the sheet, its form
 */
export function addSurfaceFields(app, element) {
	const body = element?.querySelector?.('.standard-form.scrollable') ?? element?.querySelector?.('.window-content');
	if (!body || !app.document || body.querySelector('.' + MARK)) return;
	const shares = wallSurface(app.document);
	const make = (tag, className, text) => {
		const made = document.createElement(tag);
		if (className) made.className = className;
		if (text) made.textContent = text;
		return made;
	};
	const fieldset = make('fieldset', MARK);
	fieldset.append(make('legend', '', game.i18n.localize('COVERQV.Wall.Legend')));
	for (const face of Object.keys(SURFACE)) {
		const id = `${app.id}-${MODULE_ID}-${face}`;
		const group = make('div', 'form-group');
		const label = make('label', '', game.i18n.localize(`COVERQV.Wall.${face}`));
		label.htmlFor = id;
		const fields = make('div', 'form-fields');
		fields.append(shareInput(`flags.${MODULE_ID}.${face}`, shares[face], id));
		group.append(label, fields);
		fieldset.append(group);
	}
	fieldset.append(make('p', 'hint', game.i18n.localize('COVERQV.Wall.Hint')));
	// after the restrictions, which hold the Direction the sides are named by
	const restrictions = body.querySelector('fieldset');
	if (restrictions) restrictions.after(fieldset);
	else body.append(fieldset);
}
