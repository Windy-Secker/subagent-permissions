// probe-schema.mjs - run EVERY tool composition the patched package can build
// through dsh's real author-time schema validator, before anyone restarts dsh.
//
// This exists because the first mount shipped a schema dsh refused to load:
// `parameters.delegate_permissions.additionalProperties must be explicitly true or
// false`, which failed the whole `standard` agent preset and stopped dsh from
// resuming a session. A schema error is a BOOT error, so it is worth proving here
// rather than discovering it at the next restart.
//
// usage: node probe-schema.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = join(import.meta.dirname, 'test', '.sandbox');
const { defineTool } = await import(pathToFileURL(join(sandbox, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href);

// The patched source is the authority for what the composition ships. Extract the
// delegate_permissions subtree from it so this probe cannot drift from the patch.
const source = readFileSync(join(import.meta.dirname, 'patched', 'dsh-tool-subagent', 'lib', 'index.js'), 'utf8');
const start = source.indexOf('...delegatePermissionsEnabled() ? { delegate_permissions: {');
if (start === -1) throw new Error('delegate_permissions field not found in the patched source');
const body = source.slice(source.indexOf('{', start + '...delegatePermissionsEnabled() ? '.length));
// Take the balanced object literal that follows `{ delegate_permissions:`.
const open = source.indexOf('delegate_permissions: {') + 'delegate_permissions: '.length;
let depth = 0;
let end = -1;
for (let i = open; i < source.length; i += 1) {
	const c = source[i];
	if (c === '"') {
		for (i += 1; i < source.length; i += 1) {
			if (source[i] === '\\') i += 1;
			else if (source[i] === '"') break;
		}
		continue;
	}
	if (c === '{') depth += 1;
	else if (c === '}') {
		depth -= 1;
		if (depth === 0) {
			end = i + 1;
			break;
		}
	}
}
if (end === -1) throw new Error('could not delimit the delegate_permissions object literal');
const literal = source.slice(open, end);
const delegatePermissions = new Function(`return (${literal});`)();
console.log('delegate_permissions as shipped:');
console.log(JSON.stringify(delegatePermissions, null, 2));

/** Every composition shape the mount closure can produce. */
const COMPOSITIONS = [
	{ label: 'continuable + background + model selection', enabled: true, background: true, continuable: true, selection: true },
	{ label: 'one-shot + background, no selection', enabled: true, background: true, continuable: false, selection: false },
	{ label: 'foreground only', enabled: true, background: false, continuable: false, selection: false },
	{ label: 'no delegate_permissions (plugin unmounted)', enabled: false, background: true, continuable: true, selection: false },
];

function build({ enabled, background, continuable, selection }) {
	return defineTool({
		name: 'subagent',
		description: 'probe',
		parameters: {
			description: { type: 'string', required: true, description: 'label' },
			prompt: { type: 'string', required: true, description: 'task' },
			...(enabled ? { delegate_permissions: delegatePermissions } : {}),
			...(selection
				? {
						provider: { type: 'string', description: 'route' },
						model: { type: 'string', description: 'model' },
						reasoning_effort: { type: 'string', description: 'effort' },
					}
				: {}),
			...(background ? { run_in_background: { type: 'boolean', description: 'background' } } : {}),
		},
		// The shipped output declaration, verbatim in shape.
		output: {
			schema: {
				oneOf: [
					{ type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'background' }, jobId: { type: 'string', required: true } } },
					{ type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'continuable' }, subagentId: { type: 'string', required: true } } },
					{
						type: 'object',
						additionalProperties: false,
						properties: {
							kind: { type: 'string', required: true, const: 'foreground' },
							runId: { type: 'string', required: true },
							output: { type: 'array', required: true, items: { type: 'json' } },
						},
					},
				],
			},
			render: () => [{ type: 'text', text: 'ok' }],
		},
		isConcurrencySafe: () => true,
		async execute() {
			return { kind: 'foreground', runId: 'r', output: [] };
		},
	});
}

let failures = 0;
for (const composition of COMPOSITIONS) {
	try {
		const tool = build(composition);
		const hasArgument = Object.hasOwn(tool.parameters.properties, 'delegate_permissions');
		console.log(`OK   ${composition.label} (delegate_permissions advertised: ${hasArgument})`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${composition.label}: ${error.message}`);
	}
}
console.log(failures === 0 ? '\nevery composition compiles under the real validator' : `\n${failures} composition(s) rejected`);
process.exitCode = failures === 0 ? 0 : 1;
