// probe-anchor.mjs - compare patch.mjs's literal anchors with the pristine backup files
// and report the real bytes whenever one does not match exactly once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { PATCHES } = await import(pathToFileURL(join(import.meta.dirname, 'patch.mjs')).href);
const backupRoot = join(import.meta.dirname, 'backup');

let failures = 0;
for (const file of PATCHES) {
	// backup/<pkg>-<version>/<relPath>
	const pkgDir = `${file.pkgName.replace('@deepseek-ai/', '')}-0.1.5-rc.2`;
	const path = join(backupRoot, pkgDir, file.relPath);
	const text = readFileSync(path, 'utf8');
	console.log(`=== ${file.pkgName} ${file.relPath}`);
	for (const item of file.edits) {
		const count = text.split(item.before).length - 1;
		if (count === 1) {
			console.log(`  ok      ${item.id}`);
			continue;
		}
		failures += 1;
		console.log(`  FAIL    ${item.id}: ${count} matches`);
		const firstLine = item.before.split('\n')[0];
		const at = text.indexOf(firstLine.trimStart());
		if (at === -1) {
			console.log(`          first line absent: ${JSON.stringify(firstLine)}`);
			continue;
		}
		const lineNumber = text.slice(0, at).split('\n').length;
		console.log(`          file line ${lineNumber}, real bytes:`);
		for (const line of text.slice(at, at + item.before.length + 80).split('\n').slice(0, 10)) {
			console.log(`            ${JSON.stringify(line)}`);
		}
		console.log('          patch expects:');
		for (const line of item.before.split('\n').slice(0, 10)) console.log(`            ${JSON.stringify(line)}`);
	}
}
console.log(failures === 0 ? '\nall anchors match the backups exactly once' : `\n${failures} anchor(s) need re-deriving`);
process.exitCode = failures === 0 ? 0 : 1;
