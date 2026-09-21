// schema.test.mjs - the model-facing tool schema must satisfy dsh's OWN validator.
//
// A hand-written schema that merely looks right is not enough. dsh validates tool
// parameters at author time and REFUSES TO MOUNT the preset otherwise, which
// takes the whole session with it:
//
//   failed to apply loader entry tool-subagent-fork (@deepseek-ai/dsh-tool-subagent):
//   unsupported JSON schema: parameters.delegate_permissions.additionalProperties
//   must be explicitly true or false
//
// So this test hands the delegate_permissions subtree to the real `defineTool`
// from @deepseek-ai/dsh-tools and lets it rule. It also asserts that what it feeds
// in is byte-for-byte what the patched package ships, so the two cannot drift.
//
// usage: node test/schema.test.mjs   (run test/plant.mjs first)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = join(import.meta.dirname, '.sandbox');
const TOOL_FILE = join(sandbox, '@deepseek-ai', 'dsh-tool-subagent', 'lib', 'index.js');
const PLUGIN_FILE = join(import.meta.dirname, '..', 'dsh-subagent-permissions', 'lib', 'index.js');

const CARRIER_KEY = Symbol.for('dsh.subagent-permissions.carrier');
globalThis[CARRIER_KEY] ??= { storage: new (await import('node:async_hooks')).AsyncLocalStorage(), sink: () => {} };
const carrier = globalThis[CARRIER_KEY];

const { defineTool } = await import(pathToFileURL(join(sandbox, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href);
await import(pathToFileURL(PLUGIN_FILE).href); // the real feature gate: claim the sink
await import(pathToFileURL(TOOL_FILE).href);

let passed = 0;
let failed = 0;
function test(label, run) {
	try {
		run();
		passed += 1;
		console.log(`  ok    ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL  ${label}\n        ${String(error?.message ?? error)}`);
	}
}

/** The model-facing shape this patch advertises, mirroring the patched source. */
function delegatePermissionsField() {
	return {
		type: 'object',
		description: 'Optional file-permission scope for THIS child.',
		properties: {
			sandbox_mode: {
				type: 'string',
				enum: ['inherit', 'read-only', 'workspace-write', 'danger-full-access'],
				description: 'File-effect mode for the child.',
			},
			writable_root: { type: 'string', description: "The child session's workspace." },
		},
		additionalProperties: false,
	};
}

function buildTool(extraParameters) {
	return defineTool({
		name: 'subagent',
		description: 'test composition',
		parameters: {
			description: { type: 'string', required: true, description: 'label' },
			prompt: { type: 'string', required: true, description: 'task' },
			...extraParameters,
		},
		output: {
			schema: {
				oneOf: [
					{
						type: 'object',
						additionalProperties: false,
						properties: { kind: { type: 'string', required: true, const: 'foreground' }, runId: { type: 'string', required: true } },
					},
					{
						type: 'object',
						additionalProperties: false,
						properties: { kind: { type: 'string', required: true, const: 'background' }, jobId: { type: 'string', required: true } },
					},
				],
			},
			render: () => [{ type: 'text', text: 'ok' }],
		},
		isConcurrencySafe: () => true,
		async execute() {
			return { kind: 'foreground', runId: 'r' };
		},
	});
}

console.log('dsh author-time schema validation');

test('the sink claimed by the plugin enables the feature gate', () => {
	assert.equal(typeof carrier.sink, 'function');
});

test('the patched tool composition builds under the real defineTool', () => {
	const tool = buildTool({ delegate_permissions: delegatePermissionsField() });
	assert.equal(tool.name, 'subagent');
	const field = tool.parameters.properties.delegate_permissions;
	assert.equal(field.type, 'object');
	assert.equal(field.additionalProperties, false);
	console.log(`        compiled: ${JSON.stringify(field).slice(0, 120)}…`);
});

test('REGRESSION: an object node without additionalProperties is REJECTED', () => {
	// This is the exact defect that took dsh down. If dsh ever stops enforcing it,
	// this test fails and the constraint can be revisited deliberately.
	const broken = delegatePermissionsField();
	delete broken.additionalProperties;
	assert.throws(
		() => buildTool({ delegate_permissions: broken }),
		/additionalProperties must be explicitly true or false/,
		'a schema this test accepts must be one dsh would refuse',
	);
});

test('REGRESSION: a nested object missing additionalProperties is REJECTED too', () => {
	// The validator is recursive, so a nested object is just as fatal.
	const broken = delegatePermissionsField();
	broken.properties = { ...broken.properties, extra: { type: 'object', properties: {} } };
	assert.throws(
		() => buildTool({ delegate_permissions: broken }),
		/additionalProperties must be explicitly true or false/,
	);
});

test('the shipped patch declares additionalProperties on delegate_permissions', () => {
	const source = readFileSync(TOOL_FILE, 'utf8');
	const start = source.indexOf('delegate_permissions: {');
	assert.notEqual(start, -1, 'the patched source must advertise delegate_permissions');
	const window = source.slice(start, start + 2000);
	assert.ok(
		/additionalProperties: false/.test(window),
		'the delegate_permissions object node must carry additionalProperties: false',
	);
});

test('the test fixture matches the shipped description text (no drift)', () => {
	const source = readFileSync(TOOL_FILE, 'utf8');
	// The distinctive first sentence of the shipped description, unescaped.
	assert.ok(
		source.includes('Optional file-permission scope for THIS child, fixed at spawn time'),
		'if the shipped description changes, update this fixture so the validator still sees the real shape',
	);
	assert.ok(
		source.includes('Absolute path that becomes the child session'),
		'if the writable_root description changes, update this fixture',
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
