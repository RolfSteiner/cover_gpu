// Serves the repository for the test pages, on 127.0.0.1 only.
//
//   node test/server.mjs [port] [<name>=<folder> ...]
//
// The repository is served at /, so the pages are at /test/library.html and /test/module.html,
// and test/visioner at /pf2e-visioner/, where the module looks for PF2E Visioner's scripts.
// Each further <name>=<folder> serves another folder under /<name>/. The pages ask for
//   old      a folder with an earlier build of the library (test_local_gpu_api.js and its two
//            files), which library.html compares the new one against where it has to give the
//            same answers; without it those comparisons are left out;
//   foundry  the folder of a Foundry installation, which module.html takes PIXI and the
//            quadtree class from;
//   before   the folder of a checkout of an earlier state of this repository, with its library
//            built: module.html?module=/before/module runs that module in place of this one,
//            for scenario.mjs to compare the two. The stand-ins for PF2E Visioner have to be
//            served for it as well: before/pf2e-visioner=<this repository>/test/visioner.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]) || 8377;
const here = path.dirname(fileURLToPath(import.meta.url));
// the module asks for PF2E Visioner's scripts next to its own folder; module.html gets stand-ins
const roots = [['pf2e-visioner/', path.join(here, 'visioner')], ['', path.resolve(here, '..')]];
for (const extra of process.argv.slice(3)) {
	const at = extra.indexOf('=');
	roots.unshift([extra.slice(0, at) + '/', path.resolve(extra.slice(at + 1))]);
}
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' };

http.createServer((request, response) => {
	const name = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/^\/+/, '') || 'test/library.html';
	const [prefix, folder] = roots.find(([p]) => name.startsWith(p));
	const file = path.join(folder, name.slice(prefix.length));
	if (!file.startsWith(folder) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
		response.writeHead(404);
		response.end('not found');
		return;
	}
	const stat = fs.statSync(file);
	// never from the browser's cache: a page is to test the files as they are now
	response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache',
		'last-modified': stat.mtime.toUTCString(), 'content-length': stat.size });
	if (request.method === 'HEAD') {
		response.end();
		return;
	}
	fs.createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/test/library.html`));
