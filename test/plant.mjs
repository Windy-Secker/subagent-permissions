// plant.mjs - plant a mirror tree inside the workspace in which the PATCHED
// dsh packages are the real ones, so a test can `import()` them normally.
//
// The patched packages must be reachable as `@deepseek-ai/<name>` while every
// OTHER dependency keeps resolving to the installed originals. The mirror does
// that with directory junctions (tags-J not required, no elevation on Windows):
//
//   test/.sandbox/@deepseek-ai/<name>            -> junction to the installed package
//   test/.sandbox/@deepseek-ai/dsh-subagent      -> real directory, PATCHED file
//   test/.sandbox/@deepseek-ai/dsh-tool-subagent -> real directory, PATCHED file
//   test/.sandbox/node_modules/@deepseek-ai/*    -> junctions to the installed copies
//
// A module loaded from the mirror resolves its own dependencies by walking up
// from its real (non-symlinked) path, i.e. through the mirror - which is the
// whole point.
//
// usage: node test/plant.mjs

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = import.meta.dirname;
const sandbox = join(here, '.sandbox');
const PATCHED = new Set(['dsh-subagent', 'dsh-tool-subagent']);

function findInstalledScope() {
	if (process.env.DSH_NODE_MODULES) return process.env.DSH_NODE_MODULES;
	// Stable anchor for the relocated layout: `$DSH_HOME/profiles/node_modules/
	// @deepseek-ai/dsh` is a junction to the current CLI checkout, so this holds
	// even though the CLI's own install directory has already moved once.
	if (process.env.DSH_HOME) {
		const farmCli = join(process.env.DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh');
		if (existsSync(join(farmCli, 'package.json'))) return farmCli;
	}
	try {
		const require = createRequire(import.meta.url);
		return dirname(require.resolve('@deepseek-ai/dsh/package.json'));
	} catch {}
	// The workspace does not depend on dsh itself; older layouts had a global install.
	for (const prefix of [process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : undefined, process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules') : undefined]) {
		if (prefix === undefined) continue;
		const candidate = join(prefix, '@deepseek-ai', 'dsh');
		if (existsSync(join(candidate, 'package.json'))) return candidate;
	}
	throw new Error('cannot locate the installed @deepseek-ai/dsh CLI; set DSH_NODE_MODULES');
}

const cliRoot = findInstalledScope();
const installedScope = existsSync(join(cliRoot, 'node_modules', '@deepseek-ai'))
	? join(cliRoot, 'node_modules', '@deepseek-ai')
	: join(cliRoot, '..');
if (!existsSync(installedScope)) throw new Error(`cannot find the installed @deepseek-ai scope (looked in ${installedScope})`);

rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });

let linked = 0;
let planted = 0;
for (const name of readdirSync(installedScope)) {
	const target = join(installedScope, name);
	if (PATCHED.has(name)) continue;
	for (const holder of [join(sandbox, '@deepseek-ai'), join(sandbox, 'node_modules', '@deepseek-ai')]) {
		mkdirSync(holder, { recursive: true });
		const link = join(holder, name);
		try {
			symlinkSync(target, link, 'junction');
			linked += 1;
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
		}
	}
}
// The mirror also needs the packages the WORKSPACE already links (schemastery is
// not under the CLI's scope), so a resolved dependency never escapes the mirror.
const workspaceScope = join(here, '..', '..', 'node_modules', '@deepseek-ai');
if (existsSync(workspaceScope)) {
	for (const name of readdirSync(workspaceScope)) {
		const link = join(sandbox, 'node_modules', '@deepseek-ai', name);
		if (existsSync(link)) continue;
		symlinkSync(join(workspaceScope, name), link, 'junction');
		linked += 1;
	}
}
// Unscoped third-party dependencies (zod, js-yaml, ...) live beside the scope.
for (const holder of [join(cliRoot, 'node_modules'), join(cliRoot, '..', '..')]) {
	if (!existsSync(holder)) continue;
	for (const name of readdirSync(holder)) {
		if (name === '@deepseek-ai' || name.startsWith('.')) continue;
		const link = join(sandbox, 'node_modules', name);
		if (existsSync(link)) continue;
		const target = join(holder, name);
		if (!existsSync(join(target, 'package.json'))) continue;
		try {
			symlinkSync(target, link, 'junction');
			linked += 1;
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
		}
	}
}
for (const name of PATCHED) {
	const destination = join(sandbox, '@deepseek-ai', name);
	mkdirSync(join(destination, 'lib'), { recursive: true });
	cpSync(join(here, '..', 'patched', name, 'lib', 'index.js'), join(destination, 'lib', 'index.js'));
	cpSync(join(installedScope, name, 'package.json'), join(destination, 'package.json'));
	planted += 1;
}
// node_modules must also resolve the PLANTED packages for a caller inside the mirror.
for (const name of PATCHED) {
	const holder = join(sandbox, 'node_modules', '@deepseek-ai');
	mkdirSync(holder, { recursive: true });
	const link = join(holder, name);
	if (!existsSync(link)) symlinkSync(join(sandbox, '@deepseek-ai', name), link, 'junction');
}

console.log(`planted ${planted} patched package(s) and linked ${linked} dependency(s) into ${sandbox}`);
