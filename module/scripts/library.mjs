// Loads the script library (lib/test_local_gpu_api.js, which loads the two files next to it).
//
// The three files of the library belong together: a wrapper, the script's JavaScript half and
// its wasm half. A browser, or something between it and the server, may hold an older copy of
// one of them and hand that out, and then the wrapper and the scripts of this module do not fit
// each other any more. So the files are not asked for by their plain address. The server is
// first asked what each of them is right now (a HEAD request, which fetches no file, under an
// address nothing can have an answer stored for), and what it says is made part of the address
// the library is loaded by. That address is new whenever one of the files has changed, so no
// stored copy answers to it; while nothing changes it stays the same, and a stored copy is used.

/** The files of the library, the first being the one that is imported. */
const FILES = ['test_local_gpu_api.js', 'test_local_gpu_lib.mjs', 'test_local_gpu_lib.wasm'];

/** What the scripts of this module call on the library. */
const NEEDED = ['test', 'testCover', 'traceLights', 'readPicture', 'canvas'];

const address = (file) => new URL(`../lib/${file}`, import.meta.url);

/**
 * A short text that is another one whenever one of the library's files is: what the server
 * says of each when it was last changed and how large it is.
 * @returns {Promise<string>} empty when the server would not say
 */
async function stamp() {
	const said = await Promise.all(FILES.map(async (file) => {
		const url = address(file);
		url.searchParams.set('ask', Date.now().toString(36));
		const { ok, headers } = await fetch(url, { method: 'HEAD', cache: 'no-store' });
		if (!ok) return '';
		return [headers.get('etag'), headers.get('last-modified'), headers.get('content-length')].filter(Boolean).join(' ');
	}));
	// as letters and digits: a sum over the text, in two halves so that it does not repeat soon
	let low = 0x811c9dc5;
	let high = 0x01000193;
	for (const character of said.join('|')) {
		low = Math.imul(low ^ character.codePointAt(0), 0x01000193) >>> 0;
		high = Math.imul(high + character.codePointAt(0), 0x85ebca6b) >>> 0;
	}
	return said.some(Boolean) ? low.toString(36) + high.toString(36) : '';
}

/**
 * Loads the library and makes sure it is the one these scripts were written for.
 * @returns {Promise<object>} `cover` of lib/test_local_gpu_api.js
 */
export async function loadLibrary() {
	let asked = '';
	try {
		asked = await stamp();
	} catch (error) {
		// without an answer the plain address has to do
		console.warn('cover-quadtree-view: could not ask the server about the library files', error);
	}
	const url = address(FILES[0]);
	if (asked) url.searchParams.set('v', asked);
	const { cover } = await import(url.href);
	const missing = NEEDED.filter((name) => !(name in cover));
	if (missing.length) {
		throw new Error(`an older copy of the library was loaded (it has no ${missing.join(', ')}). Reload the page without its cache (Ctrl+F5).`);
	}
	return cover;
}
