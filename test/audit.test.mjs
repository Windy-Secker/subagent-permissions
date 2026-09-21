// audit.test.mjs - does the delegated-permission AUDIT chain actually write?
//
// The live verification showed enforcement working perfectly while
// `~/.dsh/subagent-permissions.audit.jsonl` never appeared. This test settles why,
// offline, against the REAL plugin module and the REAL patched tool-subagent.
//
// It separates the two writers that can each be the culprit:
//   A. the PLUGIN's own writer, called through the carrier sink;
//   B. the PATCH's call into that sink (`bindDelegatedPermissions`, which the
//      patched tool-subagent invokes when a delegation narrows anything).
//
// usage: node test/audit.test.mjs   (run test/plant.mjs first)

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = join(import.meta.dirname, '.sandbox');
const ENTRY = {
	tool: join(sandbox, '@deepseek-ai', 'dsh-tool-subagent', 'lib', 'index.js'),
	plugin: join(import.meta.dirname, '..', 'dsh-subagent-permissions', 'lib', 'index.js'),
};

const CARRIER_KEY = Symbol.for('dsh.subagent-permissions.carrier');
const carrier = { storage: new (await import('node:async_hooks')).AsyncLocalStorage(), sink: undefined };
globalThis[CARRIER_KEY] = carrier;

const tool = await import(pathToFileURL(ENTRY.tool).href);
const plugin = await import(pathToFileURL(ENTRY.plugin).href);

const auditDir = mkdtempSync(join(tmpdir(), 'subagent-permissions-audit-'));
const auditFile = join(auditDir, 'audit.jsonl');

let passed = 0;
let failed = 0;
async function test(label, run) {
	try {
		await run();
		passed += 1;
		console.log(`  ok    ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL  ${label}\n        ${String(error?.message ?? error)}`);
	}
}
function records() {
	if (!existsSync(auditFile)) return [];
	return readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** The smallest Cordis context the plugin's apply() actually touches. */
function fakeCtx() {
	const hooks = [];
	const logged = [];
	return {
		baseDir: auditDir,
		logger: {
			info: (message) => logged.push(`info: ${message}`),
			warn: (message) => logged.push(`warn: ${message}`),
		},
		effect: () => () => {},
		on: (name, handler) => {
			hooks.push({ name, handler });
			return () => {};
		},
		hooks,
		logged,
	};
}

// --- A. the plugin's writer, reached through the carrier sink -----------------
console.log('A. plugin writer (through the carrier sink)');

const ctx = fakeCtx();
await test('the plugin applies and claims the carrier sink', () => {
	plugin.apply(ctx, { auditLog: true, auditFile });
	assert.equal(typeof carrier.sink, 'function');
	console.log(`        ${ctx.logged.join(' | ')}`);
});

await test('calling the sink writes one JSONL record', () => {
	carrier.sink({ delegatingSession: 'sink-probe', sandboxMode: 'read-only', writableCwd: null });
	const written = records();
	assert.equal(written.length, 1, `expected 1 record, file has ${written.length}; exists=${existsSync(auditFile)}`);
	assert.equal(written[0].delegatingSession, 'sink-probe');
	assert.equal(written[0].applied, true);
	rmSync(auditFile, { force: true });
});

// --- B. the patch's call into that sink ---------------------------------------
console.log('B. patch -> sink (the live delegation path)');

await test('bindDelegatedPermissions reports the applied decision', () => {
	// This is the live delegation path: the patch reports the applied decision to
	// whatever sink the carrier holds. It is also the path that stayed silently
	// dead while the two halves disagreed about the carrier key - enforcement
	// still worked (the schema gate read the plugin's key) and the audit trail
	// did not. Keep this assertion.
	tool.bindDelegatedPermissions({ sandboxMode: 'read-only', writableCwd: 'C:\\ws\\probe' }, 'parent-1', () => {});
	const written = records();
	assert.equal(written.length, 1, `expected 1 record, got ${written.length}`);
	assert.equal(written[0].sandboxMode, 'read-only');
	assert.equal(written[0].writableCwd, 'C:\\ws\\probe');
	rmSync(auditFile, { force: true });
});

// --- C. the tools/execute hook ------------------------------------------------
console.log('C. tools/execute hook (records the model request)');

const hook = ctx.hooks.find((entry) => entry.name === 'tools/execute')?.handler;
await test('the hook is registered', () => {
	assert.equal(typeof hook, 'function');
});

await test('a subagent call with delegate_permissions is recorded and still dispatched', () => {
	let proceeded = false;
	hook(
		{
			name: 'subagent',
			arguments: { description: 'probe', delegate_permissions: { sandbox_mode: 'read-only' } },
			agent: { session: { id: 'parent-9', header: { cwd: 'C:\\ws' } } },
		},
		() => {
			proceeded = true;
			return 'next-result';
		},
	);
	assert.equal(proceeded, true, 'a permitted request must still reach next()');
	const written = records();
	assert.equal(written.length, 1, `expected 1 record, got ${written.length}`);
	assert.equal(written[0].delegatingSession, 'parent-9');
	assert.deepEqual(written[0].requested, { sandbox_mode: 'read-only' });
	rmSync(auditFile, { force: true });
});

await test('an unrelated tool call is passed through with no audit line', () => {
	let proceeded = false;
	hook({ name: 'read', arguments: { filePath: 'x' }, agent: undefined }, () => {
		proceeded = true;
		return 'ok';
	});
	assert.equal(proceeded, true);
	assert.equal(records().length, 0);
});

await test('an out-of-base writable_root is refused by the hook', async () => {
	const base = mkdtempSync(join(tmpdir(), 'subagent-permissions-base-'));
	const scoped = fakeCtx();
	plugin.apply(scoped, { auditLog: false, writableRootBase: base });
	const scopedHook = scoped.hooks.find((entry) => entry.name === 'tools/execute').handler;
	// The hook is async, so the refusal surfaces as a rejected promise.
	await assert.rejects(
		() => scopedHook({ name: 'subagent', arguments: { delegate_permissions: { writable_root: join(tmpdir(), 'elsewhere') } }, agent: undefined }, () => 'ok'),
		/outside the configured delegation base/,
	);
	rmSync(base, { recursive: true, force: true });
});

rmSync(auditDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
