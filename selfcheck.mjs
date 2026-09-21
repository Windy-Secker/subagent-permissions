// selfcheck.mjs - OFFLINE self-check for the subagent-permissions deliverable.
//
// Runs the whole chain without touching the installed packages or a live dsh:
//   1. every patch anchor must match the installed package exactly once;
//   2. the patched files must parse;
//   3. the patched files must be planted as real modules and pass the seam tests;
//   4. the plugin must have the shape the Cordis loader requires.
//
// usage: node selfcheck.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const results = [];

/** The installed dsh dependency scope, so a check can compare what would run. */
function installedScope() {
	if (process.env.DSH_NODE_MODULES) return process.env.DSH_NODE_MODULES;
	try {
		const cli = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'));
		if (existsSync(join(cli, 'node_modules', '@deepseek-ai'))) return join(cli, 'node_modules', '@deepseek-ai');
	} catch {}
	for (const prefix of [process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : undefined, process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules') : undefined]) {
		if (prefix === undefined) continue;
		const candidate = join(prefix, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
		if (existsSync(candidate)) return candidate;
	}
	throw new Error('cannot locate the installed @deepseek-ai scope; set DSH_NODE_MODULES');
}

function run(label, command, args) {
	process.stdout.write(`\n=== ${label}\n`);
	try {
		// stdio: 'inherit' rather than a pipe: under the DSH sandbox a child
		// process with piped stdio fails with EPERM (named pipes are unavailable),
		// and inheriting keeps the child's own output in front of the reader.
		execFileSync(command, args, { stdio: 'inherit' });
		results.push({ label, ok: true });
	} catch {
		results.push({ label, ok: false });
	}
}

function check(label, condition, detail) {
	results.push({ label, ok: Boolean(condition) });
	process.stdout.write(`\n=== ${label}\n${detail}\n`);
}

run('patch anchors match the pristine backups', 'node', [join(here, 'probe-anchor.mjs')]);
run('patched tree parses', 'node', ['--check', join(here, 'patched', 'dsh-subagent', 'lib', 'index.js')]);
run('patched types layer parses', 'node', ['--check', join(here, 'patched', 'dsh-subagent', 'lib', 'types', 'child-agent.js')]);

// The installed packages must be the ones these tests describe: compare them
// with the freshly generated patched/ output byte for byte. Every patched file
// is listed, not just the bundle, because a half-patched site is a silent
// behaviour difference (the types layer serves dsh-tool-subagent-control).
const PATCHED_FILES = [
	['dsh-subagent', join('lib', 'index.js')],
	['dsh-subagent', join('lib', 'types', 'child-agent.js')],
	['dsh-subagent', join('lib', 'types', 'continuation-activation.js')],
	['dsh-tool-subagent', join('lib', 'index.js')],
	['dsh-subagent-in-process-driver', join('lib', 'index.js')],
];
for (const [name, rel] of PATCHED_FILES) {
	const generated = readFileSync(join(here, 'patched', name, rel), 'utf8');
	const installed = readFileSync(join(installedScope(), name, rel), 'utf8');
	check(
		`installed ${name}/${rel} matches the generated patch`,
		generated === installed,
		generated === installed ? 'byte-identical' : 'DIFFERS - regenerate with: node patch.mjs --from backup --out patched, then the installer with -Apply',
	);
}

// The feature switch must be sampled when a tool composition is built, not at
// module load, so activation order cannot leave the arguments unadvertised.
const toolSource = readFileSync(join(here, 'patched', 'dsh-tool-subagent', 'lib', 'index.js'), 'utf8');
check(
	'the delegate_permissions gate is evaluated at composition build time',
	toolSource.includes('...delegatePermissionsEnabled() ? { delegate_permissions: {'),
	'found the dynamic gate',
);
run('plant the patched packages as real modules', 'node', [join(here, 'test', 'plant.mjs')]);
run('seam behaviour tests', 'node', [join(here, 'test', 'seam.test.mjs')]);
run('audit chain tests', 'node', [join(here, 'test', 'audit.test.mjs')]);

// The loader contract: named `name` / `inject` / `apply`, and NO default export.
// (A default export would make cordis-plugin-loader unwrap the module into a bare
// value and silently drop `inject`; see the dsh-memory notes for that defect.)
const plugin = await import(pathToFileURL(join(here, 'dsh-subagent-permissions', 'lib', 'index.js')).href);
check(
	'plugin shape (named name/inject/apply, no default export)',
	typeof plugin.name === 'string' && Array.isArray(plugin.inject) && typeof plugin.apply === 'function' && plugin.default === undefined,
	`name=${JSON.stringify(plugin.name)} inject=${JSON.stringify(plugin.inject)} apply=${typeof plugin.apply} default=${String(plugin.default)}`,
);

// The halves rendezvous on ONE process-wide key. A mismatch splits the feature
// silently - the schema gate opens while the audit sink stays dead - which is
// exactly the defect the first live verification caught. Compare the whole
// expression, not just its argument: `Symbol.for(x)` and the bare string `x` are
// two different keys.
const CARRIER_EXPRESSION = 'Symbol.for("dsh.subagent-permissions.carrier")';
const halfKeys = PATCHED_FILES
	.map(([name, rel]) => [name + '/' + rel, readFileSync(join(here, 'patched', name, rel), 'utf8')])
	.filter(([, text]) => text.includes('dsh.subagent-permissions.carrier'))
	.map(([label, text]) => [label, text.match(/(Symbol\.for\("[^"]*"\)|"dsh\.subagent-permissions\.carrier")/)?.[1]]);
const pluginKey = readFileSync(join(here, 'dsh-subagent-permissions', 'lib', 'index.js'), 'utf8').match(/(Symbol\.for\("[^"]*"\))/)?.[1];
check(
	'every half uses the same carrier key expression',
	pluginKey === CARRIER_EXPRESSION && halfKeys.length > 0 && halfKeys.every(([, key]) => key === CARRIER_EXPRESSION),
	`plugin=${JSON.stringify(pluginKey)}; halves: ${halfKeys.map(([label, key]) => `${label}=${JSON.stringify(key)}`).join(', ')}`,
);

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length > 0) {
	for (const result of failed) process.stderr.write(`FAILED: ${result.label}\n`);
	process.exitCode = 1;
}
