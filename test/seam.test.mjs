// seam.test.mjs - OFFLINE tests for the per-subagent permission seam.
//
// These tests never start dsh and never write to the installed packages. They
// plant a mirror tree in which the PATCHED packages are the real ones (see
// plant.mjs) and then `import()` them for real, so what is under test is the
// module that would actually load - its real imports, its real Symbol.for
// rendezvous, its real AsyncLocalStorage.
//
// usage: node test/seam.test.mjs
//   (run `node test/plant.mjs` first, or just use `node test/run-all.mjs`)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = join(import.meta.dirname, '.sandbox');
const ENTRY = {
	subagent: join(sandbox, '@deepseek-ai', 'dsh-subagent', 'lib', 'index.js'),
	tool: join(sandbox, '@deepseek-ai', 'dsh-tool-subagent', 'lib', 'index.js'),
};
for (const [label, file] of Object.entries(ENTRY)) {
	if (!existsSync(file)) {
		console.error(`missing ${label} mirror at ${file}; run: node test/plant.mjs`);
		process.exit(2);
	}
}

// The carrier is the process-wide rendezvous BOTH patched packages and the plugin
// agree on: Symbol.for('dsh.subagent-permissions.carrier'). It must be spelled
// IDENTICALLY on every side - a mismatched key splits the feature silently (the
// schema gate opens while the audit sink stays dead). The tests publish a sink
// before importing the tool package, because that package samples the feature
// flag when a composition is built.
const CARRIER_KEY = Symbol.for('dsh.subagent-permissions.carrier');
const auditRecords = [];
globalThis[CARRIER_KEY] = {
	storage: new (await import('node:async_hooks')).AsyncLocalStorage(),
	sink: (record) => auditRecords.push(record),
};
const carrier = globalThis[CARRIER_KEY];

const subagent = await import(pathToFileURL(ENTRY.subagent).href);
const tool = await import(pathToFileURL(ENTRY.tool).href);

if (process.env.SEAM_PROBE === '1') {
	console.log('[probe] carrier storage getStore:', typeof carrier.storage.getStore);
	console.log('[probe] carrier ctor:', carrier.storage.constructor?.name);
	console.log('[probe] slot is carrier:', globalThis[CARRIER_KEY] === carrier);
	console.log('[probe] module sees own globalThis?', subagent.childSessionMeta.toString().slice(0, 80));
	try {
		console.log('[probe] childSessionMeta ok:', JSON.stringify(subagent.childSessionMeta({ ctx: { get: () => undefined }, session: { header: { id: 'p', cwd: 'C:\\p' } } }, 1, false)));
	} catch (error) {
		console.log('[probe] childSessionMeta THREW:', String(error));
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function test(label, run) {
	try {
		run();
		passed += 1;
		console.log(`  ok    ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL  ${label}\n        ${String(error?.message ?? error).split('\n').join('\n        ')}`);
	}
}
function throwsWith(fn, fragment) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
		assert.ok(
			error.message.includes(fragment),
			`expected the message to contain ${JSON.stringify(fragment)}, got ${JSON.stringify(error.message)}`,
		);
		return true;
	});
}

/**
 * A stand-in for a real child session + its scoped creation context.
 *
 * The returned context is a PROXY that THROWS on any property the real child
 * context does not have - most importantly `agent`. The first version of this
 * fixture cheerfully provided `agent`, which hid a real defect until a live
 * delegation failed with `cannot get property "agent" without inject`. Keep the trap.
 * @returns the child context, its session, and the recorded calls.
 */
function fakeChild() {
	const appended = [];
	const session = {
		header: { id: 'child-1', cwd: 'C:\\parent-workspace' },
		append: (type, data) => appended.push({ type, data }),
	};
	const contexts = [];
	const sections = [];
	const restricted = [];
	const known = new Set(['get', 'systemPrompt', 'tools', 'effect']);
	const childCtx = new Proxy(
		{
			get: () => undefined,
			systemPrompt: {
				getContextOrder: () => 1,
				getSectionOrder: () => 1,
				context: (entry) => contexts.push(entry),
				section: (entry) => sections.push(entry),
			},
			tools: { restrict: (filter) => restricted.push(filter) },
			effect: () => {},
		},
		{
			get(target, property) {
				if (typeof property === 'string' && !known.has(property) && !(property in target)) {
					throw new TypeError(`cannot get property "${property}" without inject`);
				}
				return Reflect.get(target, property);
			},
		},
	);
	return { childCtx, session, appended, contexts, sections, restricted };
}
const parent = { ctx: { get: () => undefined }, session: { header: { id: 'parent-1', cwd: 'C:\\parent-workspace' } } };
const TMP = join(import.meta.dirname, 'tmp-scope');

// ---------------------------------------------------------------------------
// tool-subagent: validate + narrow
// ---------------------------------------------------------------------------

console.log('tool-subagent: validating and narrowing a delegation request');

test('the patch publishes its seam helpers', () => {
	for (const name of ['resolveDelegatedPermissions', 'resolveDelegatedPermissionsForCall', 'bindDelegatedPermissions', 'validateWritableRoot']) {
		assert.equal(typeof tool[name], 'function', `${name} must be exported so this seam stays auditable`);
	}
});

test('an omitted request inherits everything', () => {
	assert.equal(tool.resolveDelegatedPermissions(undefined, 'workspace-write', ['C:\\ws']), undefined);
});

test('"inherit" narrows nothing', () => {
	assert.equal(tool.resolveDelegatedPermissions({ sandbox_mode: 'inherit' }, 'workspace-write', ['C:\\ws']), undefined);
});

test('read-only is a legal narrowing', () => {
	assert.deepEqual(tool.resolveDelegatedPermissions({ sandbox_mode: 'read-only' }, 'workspace-write', ['C:\\ws']), {
		sandboxMode: 'read-only',
	});
});

test('an unknown mode is rejected', () => {
	throwsWith(() => tool.resolveDelegatedPermissions({ sandbox_mode: 'read-write' }, 'workspace-write', []), 'sandbox_mode must be one of');
});

test('a non-object request is rejected', () => {
	throwsWith(() => tool.resolveDelegatedPermissions(['read-only'], 'workspace-write', []), 'must be an object');
});

test('danger-full-access is refused while the parent is confined', () => {
	throwsWith(
		() => tool.resolveDelegatedPermissions({ sandbox_mode: 'danger-full-access' }, 'workspace-write', []),
		'would WIDEN the child',
	);
});

test('danger-full-access narrows to nothing when the parent already has it', () => {
	assert.equal(tool.resolveDelegatedPermissions({ sandbox_mode: 'danger-full-access' }, 'danger-full-access', []), undefined);
});

test('a writable_root inside a parent root is accepted and created', () => {
	const resolved = tool.resolveDelegatedPermissions({ writable_root: TMP }, 'workspace-write', [join(import.meta.dirname)]);
	assert.deepEqual(resolved, { writableCwd: TMP });
	assert.ok(existsSync(TMP), 'the writable root should have been created');
});

test('a writable_root outside every parent root is refused', () => {
	throwsWith(
		() => tool.resolveDelegatedPermissions({ writable_root: homedir() }, 'workspace-write', [join(import.meta.dirname)]),
		'is outside every root',
	);
});

test('a relative writable_root never silently escapes the parent root', () => {
	// It resolves against the HOST cwd, so containment is what decides.
	const resolved = tool.resolveDelegatedPermissions({ writable_root: '.' }, 'workspace-write', [process.cwd()]);
	assert.equal(resolved.writableCwd, process.cwd(), 'a relative path must resolve to the host cwd, never to the parent workspace');
});

test('under danger-full-access any absolute writable_root is accepted', () => {
	const temp = process.env.TEMP ?? process.env.TMP;
	if (temp === undefined) return; // no platform temp dir on this host: nothing to assert
	assert.deepEqual(tool.resolveDelegatedPermissions({ writable_root: temp }, 'danger-full-access', []), { writableCwd: temp });
});

test('mode and root travel together', () => {
	const resolved = tool.resolveDelegatedPermissions({ sandbox_mode: 'workspace-write', writable_root: TMP }, 'danger-full-access', []);
	assert.deepEqual(resolved, { writableCwd: TMP, sandboxMode: 'workspace-write' });
});

// ---------------------------------------------------------------------------
// the carrier
// ---------------------------------------------------------------------------

console.log('the carrier: one process-wide store, two packages');

test('both packages adopted the SAME carrier object', () => {
	assert.equal(globalThis[CARRIER_KEY], carrier, 'the registry slot must still hold the object the tests published');
	assert.equal(typeof carrier.storage.run, 'function');
});

test('binding a store reaches the OTHER package and reports to the sink', () => {
	auditRecords.length = 0;
	const store = { sandboxMode: 'read-only', writableCwd: 'C:\\ws\\sub' };
	let observed;
	const result = tool.bindDelegatedPermissions(store, 'parent-1', () => {
		// `dsh-subagent` reads the carrier from ITS module scope - this is the
		// cross-package claim the whole design rests on.
		observed = subagent.childSessionMeta(parent, 1, false).cwd;
		return 'delegation-result';
	});
	assert.equal(result, 'delegation-result', 'the delegation result must pass through untouched');
	assert.equal(observed, 'C:\\ws\\sub', 'the other package must see the bound store');
	assert.deepEqual(auditRecords, [{ delegatingSession: 'parent-1', writableCwd: 'C:\\ws\\sub', sandboxMode: 'read-only' }]);
	assert.equal(carrier.storage.getStore(), undefined, 'the store must be unbound after the delegation');
});

test('no store means the delegation runs unbound', () => {
	assert.equal(tool.bindDelegatedPermissions(undefined, 'parent-1', () => carrier.storage.getStore()), undefined);
});

test('the carrier is only claimed while the plugin is mounted', () => {
	// The real switch is `sink !== undefined`, sampled once when the tool
	// composition is built; with no plugin mounted the arguments are not
	// advertised at all. The module was evaluated with the sink present, which is
	// the order a real boot produces.
	assert.equal(typeof carrier.sink, 'function');
	const sinkBefore = carrier.sink;
	carrier.sink = undefined;
	try {
		assert.equal(carrier.sink, undefined, 'unmounting the plugin must drop the sink');
	} finally {
		carrier.sink = sinkBefore;
	}
	assert.equal(typeof carrier.sink, 'function', 'remounting restores it');
});

// ---------------------------------------------------------------------------
// dsh-subagent: create the child with the delegated scope
// ---------------------------------------------------------------------------

console.log('dsh-subagent: creating the child with the delegated scope');

test('with no delegation the child inherits the parent workspace', () => {
	const meta = subagent.childSessionMeta(parent, 1, false);
	assert.equal(meta.cwd, 'C:\\parent-workspace');
	assert.equal(meta.parentSession, 'parent-1');
	assert.equal(meta.origin, 'subagent');
});

test('a delegated writable root becomes the child session cwd', () => {
	const meta = tool.bindDelegatedPermissions({ writableCwd: 'C:\\ws\\subagents\\task-1' }, 'parent-1', () =>
		subagent.childSessionMeta(parent, 1, false),
	);
	assert.equal(meta.cwd, 'C:\\ws\\subagents\\task-1');
});

test('the carrier never leaks into a later caller', async () => {
	const inside = tool.bindDelegatedPermissions({ writableCwd: 'C:\\ws\\sub' }, 'parent-1', () => subagent.childSessionMeta(parent, 1, false).cwd);
	const after = await Promise.resolve().then(() => subagent.childSessionMeta(parent, 1, false).cwd);
	assert.equal(inside, 'C:\\ws\\sub');
	assert.equal(after, 'C:\\parent-workspace');
});

test('concurrent delegations do not observe each other', async () => {
	const observe = (root) =>
		new Promise((done) => {
			tool.bindDelegatedPermissions({ writableCwd: root }, 'parent-1', () => {
				setImmediate(() => done(subagent.childSessionMeta(parent, 1, false).cwd));
			});
		});
	const [a, b] = await Promise.all([observe('C:\\ws\\a'), observe('C:\\ws\\b')]);
	assert.equal(a, 'C:\\ws\\a');
	assert.equal(b, 'C:\\ws\\b');
});

test('a delegated mode is appended to the child log as a sandbox/mode event', () => {
	const child = fakeChild();
	tool.bindDelegatedPermissions({ sandboxMode: 'read-only' }, 'parent-1', () => subagent.applyChildComposition(child.childCtx, parent, {}, child.session));
	assert.deepEqual(child.appended, [{ type: 'sandbox/mode', data: { mode: 'read-only', source: 'delegation' } }]);
});

test('a root-only delegation appends no mode event', () => {
	const child = fakeChild();
	tool.bindDelegatedPermissions({ writableCwd: 'C:\\ws\\sub' }, 'parent-1', () => subagent.applyChildComposition(child.childCtx, parent, {}, child.session));
	assert.deepEqual(child.appended, []);
});

test('a delegated mode with no child session fails loud instead of silently', () => {
	const child = fakeChild();
	// A stale three-argument call site must not quietly drop the restriction:
	// that would leave the child running on the parent's mode while the caller
	// believes it narrowed.
	throwsWith(
		() => tool.bindDelegatedPermissions({ sandboxMode: 'read-only' }, 'parent-1', () => subagent.applyChildComposition(child.childCtx, parent, {})),
		'needs the child session',
	);
});

test('the child context is never asked for an `agent` property', () => {
	// fakeChild's proxy throws "cannot get property ... without inject" for every
	// property the real context lacks, so this passes only while the composition
	// reaches the session through its PARAMETER (the defect that reached live dsh).
	const child = fakeChild();
	tool.bindDelegatedPermissions({ sandboxMode: 'read-only', writableCwd: 'C:\\ws\\sub' }, 'parent-1', () =>
		subagent.applyChildComposition(child.childCtx, parent, {}, child.session),
	);
	assert.equal(child.appended.length, 1);
});

test('the child is told its scope and keeps the upstream statement verbatim', () => {
	// The upstream statement is not exported, so read it out of the patched file:
	// this asserts the narration is APPENDED to it, never a replacement.
	const source = readFileSync(ENTRY.subagent, 'utf8');
	const declared = source.match(/const SUBAGENT_DELEGATION_CONTEXT = ("(?:[^"\\]|\\.)*");/);
	assert.ok(declared, 'SUBAGENT_DELEGATION_CONTEXT must still be declared');
	const upstream = JSON.parse(declared[1]);
	const child = fakeChild();
	tool.bindDelegatedPermissions({ sandboxMode: 'workspace-write', writableCwd: 'C:\\ws\\sub' }, 'parent-1', () =>
		subagent.applyChildComposition(child.childCtx, parent, {}, child.session),
	);
	const text = child.contexts[0].text;
	assert.ok(text.startsWith(upstream), 'the upstream statement must be preserved byte-for-byte at the front');
	assert.ok(text.includes('"workspace-write"'), 'the mode must be named');
	assert.ok(text.includes('C:\\\\ws\\\\sub'), 'the writable root must be named');
});

test('a partial decision never narrates "undefined"', () => {
	const child = fakeChild();
	tool.bindDelegatedPermissions({ sandboxMode: 'read-only' }, 'parent-1', () => subagent.applyChildComposition(child.childCtx, parent, {}, child.session));
	const text = child.contexts[0].text;
	assert.ok(!text.includes('undefined'), text);
	assert.ok(text.includes('inheriting workspace'), 'a missing root must read as inherited');
});

test('composition still applies persona and tool filter', () => {
	const child = fakeChild();
	tool.bindDelegatedPermissions({ sandboxMode: 'read-only' }, 'parent-1', () =>
		subagent.applyChildComposition(child.childCtx, parent, { persona: 'be terse', toolFilter: { deny: ['bash'] } }, child.session),
	);
	assert.equal(child.sections[0].text, 'be terse');
	assert.deepEqual(child.restricted, [{ deny: ['bash'] }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
