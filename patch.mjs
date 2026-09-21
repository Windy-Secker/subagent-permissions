// patch.mjs - build the patched copies of the two dsh packages that must change
// so a delegating agent can hand a subagent its own file permissions at spawn time.
//
// Why a patch at all (see README.md, "Why this cannot be a plugin alone"):
//   * a child session's writable root IS its immutable `SessionHeader.cwd`
//     (`dsh-sandbox-policy.resolve()` -> `session.header.cwd`), and the only place
//     that cwd is chosen for a subagent is `childSessionMeta()` inside
//     `@deepseek-ai/dsh-subagent`;
//   * the decision must be made while the child is still UNPUBLISHED, because
//     `agent/created` / `session/created` fire after publication and a session
//     header cannot be rewritten afterwards.
// So the patch teaches `childSessionMeta` + `applyChildComposition` to read one
// AsyncLocalStorage carrier that the plugin (dsh-subagent-permissions) binds
// around the `subagent` tool call, and teaches `dsh-tool-subagent` to advertise
// and validate the two model-facing arguments (`delegate_permissions`,
// `writable_root`).
//
// Every edit is a literal, single-occurrence replacement. A missing or ambiguous
// anchor THROWS: a silent partial patch is worse than no patch.
//
// Usage:
//   node patch.mjs --check          # exit 1 unless every anchor matches (touch nothing)
//   node patch.mjs --dry-run        # show what would change (touch nothing)
//   node patch.mjs --out <dir>      # write the patched files into <dir>
//   node patch.mjs --from <dir>     # read the ORIGINALS from a backup tree instead of the
//                                   #   installed packages (used to regenerate patched/ after
//                                   #   the installed packages are already patched)
//   node patch.mjs                  # patch the installed packages in place (backup first)
//   node patch.mjs --revert         # restore the pristine copies kept in backup/
//   node patch.mjs --diff --dry-run # print a context diff of every edit

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = join(HERE, 'backup');
const SUPPORTED_VERSIONS = new Set(['0.1.5-rc.2']);

// ---------------------------------------------------------------------------
// locate the installed packages (dsh keeps its dependency tree under the CLI
// package's node_modules; also handle a flat layout and an explicit override).
// ---------------------------------------------------------------------------

function candidateRoots() {
	const roots = [];
	if (process.env.DSH_NODE_MODULES) roots.push(process.env.DSH_NODE_MODULES);
	try {
		roots.push(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')));
	} catch {}
	if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
	if (process.env.USERPROFILE) roots.push(join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
	return roots.filter((root) => root.length > 0 && existsSync(root));
}

function findPackage(name) {
	const seen = new Set();
	for (const root of candidateRoots()) {
		for (const mods of [join(root, 'node_modules'), join(root, '..', '..'), join(root, '..', '..', '..')]) {
			const pkgDir = join(mods, name);
			if (seen.has(pkgDir)) continue;
			seen.add(pkgDir);
			const manifest = join(pkgDir, 'package.json');
			if (existsSync(manifest)) {
				return {
					name,
					dir: pkgDir,
					mainFile: join(pkgDir, 'lib', 'index.js'),
					version: JSON.parse(readFileSync(manifest, 'utf8')).version,
				};
			}
		}
	}
	throw new Error(`cannot locate package ${name}; set DSH_NODE_MODULES to the directory holding @deepseek-ai/*`);
}

// ---------------------------------------------------------------------------
// the patch table - one entry per literal, single-occurrence replacement
// ---------------------------------------------------------------------------

function edit(id, before, after, note) {
	return { id, before, after, note };
}

function patchFile(pkgName, relPath, edits) {
	return { pkgName, relPath, edits };
}

const CHILD_META_DOC = `/**
* Resolve the child's delegation depth from its parent and enforce an optional
* cap. The persisted parent header is the monotone floor, so a resumed parent
* cannot delegate as if it were top-level.`;

const SUBAGENT_EDITS = [
	edit(
		'subagent.import-als',
		`import { randomUUID } from "node:crypto";`,
		`import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";`,
		'import AsyncLocalStorage for the delegated-permission carrier',
	),
	edit(
		'subagent.carrier',
		CHILD_META_DOC,
		`/** The Key of this carrier in the process-wide symbol registry (shared with dsh-tool-subagent). */
const DELEGATED_PERMISSIONS_KEY = Symbol.for("dsh.subagent-permissions.carrier");
/**
 * Module-scope AsyncLocalStorage so dsh-tool-subagent - which links against this
 * very module instance - can bind the delegating agent's permission decision
 * around one \`subagent\` tool call, and this module can read it back while the
 * child session is still UNPUBLISHED. The store rides the async context: a
 * detached child turn sees \`undefined\` and correctly reports no delegation,
 * while concurrent delegations each see their own value.
 */
// An explicit presence test rather than a nullish assignment to a member
// expression: the nullish-assignment form resolved to the wrong object inside
// the shipped ESM output, while this two-step form is unambiguous either way.
if (globalThis[DELEGATED_PERMISSIONS_KEY] === void 0) globalThis[DELEGATED_PERMISSIONS_KEY] = { storage: new AsyncLocalStorage(), sink: void 0 };
// NOTE: the carrier OBJECT holds the store on .storage; calling getStore() on the
// carrier itself is the bug this line exists to prevent.
const delegatedPermissionsStorage = globalThis[DELEGATED_PERMISSIONS_KEY].storage;
/**
 * Read the permission decision bound to the CURRENT async context.
 * @returns the pending decision, or undefined outside a delegating tool call.
 */
function pendingDelegatedPermissions() {
	return delegatedPermissionsStorage.getStore();
}

` + CHILD_META_DOC,
		'add the process-wide AsyncLocalStorage carrier',
	),
	edit(
		'subagent.child-session-meta',
		`function childSessionMeta(parent, childDepth, isSeeded) {
	const parentHeader = parent.session.header;
	const agentPreset = parent.ctx.get("agentPresets")?.composedPreset(parent.ctx);
	return {
		...parentHeader.cwd !== void 0 ? { cwd: parentHeader.cwd } : {},`,
		`function childSessionMeta(parent, childDepth, isSeeded) {
	const parentHeader = parent.session.header;
	const agentPreset = parent.ctx.get("agentPresets")?.composedPreset(parent.ctx);
	const delegatedPermissions = pendingDelegatedPermissions();
	return {
		...delegatedPermissions?.writableCwd !== void 0 ? { cwd: delegatedPermissions.writableCwd } : parentHeader.cwd !== void 0 ? { cwd: parentHeader.cwd } : {},`,
		'a delegation may give the child its own writable root',
	),
	edit(
		'subagent.child-composition',
		`function applyChildComposition(childCtx, parent, composition) {
	childCtx.get("agentPresets")?.composeFrom(childCtx, parent.ctx);
	childCtx.systemPrompt.context({
		name: "subagent:delegation",
		order: childCtx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION"),
		text: SUBAGENT_DELEGATION_CONTEXT
	});`,
		`function applyChildComposition(childCtx, parent, composition, childSession) {
	childCtx.get("agentPresets")?.composeFrom(childCtx, parent.ctx);
	const delegatedPermissions = pendingDelegatedPermissions();
	if (delegatedPermissions?.sandboxMode !== void 0) {
		if (childSession === void 0) throw new Error("subagent: a delegated sandbox mode needs the child session, but the caller passed none - the applyChildComposition call site is out of date");
		// One "sandbox/mode" event, appended while the session is still unpublished,
		// so the child's effective mode is reconstructable from its own log by
		// replay and OUTRANKS the delegated-policy seed written just before this
		// call (that seed only copies the parent's own explicit override).
		//
		// The session arrives as a PARAMETER on purpose: the child's scoped context
		// carries no "agent" property, so reaching for childCtx.agent here fails at
		// runtime with "cannot get property \\"agent\\" without inject".
		childSession.append("sandbox/mode", {
			mode: delegatedPermissions.sandboxMode,
			source: "delegation"
		});
	}
	childCtx.systemPrompt.context({
		name: "subagent:delegation",
		order: childCtx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION"),
		text: delegatedPermissions === void 0 ? SUBAGENT_DELEGATION_CONTEXT : SUBAGENT_DELEGATION_CONTEXT + " Your file permission scope for this delegation was fixed by the delegating agent: " + (delegatedPermissions.sandboxMode === void 0 ? "the standing policy applies" : "sandbox mode " + JSON.stringify(delegatedPermissions.sandboxMode)) + (delegatedPermissions.writableCwd === void 0 ? "; your session workspace is the inheriting workspace." : "; your writable workspace root is " + JSON.stringify(delegatedPermissions.writableCwd) + ", so under a workspace-write mode you may modify files only under it, plus platform temporary areas.")
	});`,
		'apply the delegated sandbox mode from the child session and narrate the child scope',
	),
	edit(
		'subagent.composition-call-site',
		`			applyChildComposition(childCtx, parent, inputs.composition);`,
		`			applyChildComposition(childCtx, parent, inputs.composition, child.session);`,
		'hand the child session to the composition (the continuable path)',
	),
	edit(
		'subagent.capability-exemption',
		`				{
					when: request.toolFilter !== void 0,
					cap: "toolFilter"
				},`,
		`				{
					when: request.toolFilter !== void 0,
					cap: "toolFilter"
				},
				{
					// The delegated-permission carrier is consumed by the in-process
					// child composition (childSessionMeta / applyChildComposition), not
					// by a provider feature, so a provider need not advertise it.
					// Declared here only to document the deliberate exemption from the
					// capability gate.
					when: false,
					cap: "delegatedPermissions"
				},`,
		'document that the permission carrier is not a provider capability',
	),
];

const TOOL_SUBAGENT_EDITS = [
	edit(
		'tool.imports',
		`import { scopeChainOf, scopeOf } from "@deepseek-ai/dsh-scope";`,
		`import { scopeChainOf, scopeOf } from "@deepseek-ai/dsh-scope";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { writableRoots } from "@deepseek-ai/dsh-sandbox";`,
		'import fs/path/sandbox helpers for permission validation',
	),
	edit(
		'tool.helpers',
		`/**
* Install one delegation-tool composition.`,
		`/** The narrowest child-writable root the model may name; a drive root is never an intent worth honoring. */
const MIN_DELEGATED_WRITABLE_ROOT_LENGTH = 4;
/** The Key of the carrier store, shared with @deepseek-ai/dsh-subagent through the global symbol registry. */
const DELEGATED_PERMISSIONS_KEY = Symbol.for("dsh.subagent-permissions.carrier");
/**
 * The delegation-permission carrier. dsh-tool-subagent and dsh-subagent are two
 * package instances, so a module-local singleton would NOT be shared; the global
 * symbol registry is the process-wide rendezvous (and it survives HMR and a
 * duplicated package instance).
 *
 * The rendezvous holds TWO things:
 *   * \`storage\` - the AsyncLocalStorage that carries one delegation's decision
 *     from the tool call to the child's creation;
 *   * \`sink\` - the audit callback published by the dsh-subagent-permissions
 *     plugin, whose presence is ALSO the feature switch for the model-facing
 *     \`delegate_permissions\` arguments. Unmount that plugin and the arguments
 *     disappear from the tool schema again.
 */
// Same explicit presence test as dsh-subagent: one process-wide object,
// whichever package module evaluates first.
if (globalThis[DELEGATED_PERMISSIONS_KEY] === void 0) globalThis[DELEGATED_PERMISSIONS_KEY] = { storage: new AsyncLocalStorage(), sink: void 0 };
const DELEGATED_PERMISSIONS = globalThis[DELEGATED_PERMISSIONS_KEY];
/** Every accepted sandbox mode, narrowest first. */
const DELEGATED_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
/** Numeric rank used to clamp a child to its parent's standing mode. */
const SANDBOX_MODE_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
/** Whether one path is the other or lies beneath it, case-insensitively on Windows. */
function isPathUnder(child, parent) {
	const rel = relative(parent, child);
	if (rel === "") return true;
	return !rel.startsWith("..") && !isAbsolute(rel);
}
/**
 * Validate that the delegating agent named a sane, usable writable root. The
 * path must exist or be creatable as a directory: a child workspace that cannot
 * be entered would fail its first tool call, so it fails here instead.
 * @param raw - the model-supplied writable_root.
 * @returns the absolute, validated directory.
 */
function validateWritableRoot(raw) {
	if (typeof raw !== "string" || raw.trim().length === 0) throw new Error("delegate_permissions.writable_root must be a non-empty absolute path");
	const target = resolve(raw);
	if (!isAbsolute(target)) throw new Error(\`delegate_permissions.writable_root must be an absolute path, got "\${raw}"\`);
	if (target.length < MIN_DELEGATED_WRITABLE_ROOT_LENGTH) throw new Error(\`delegate_permissions.writable_root "\${target}" is too broad to be a delegation scope\`);
	let info;
	try {
		info = statSync(target);
	} catch (error) {
		if (error?.code !== "ENOENT") throw new Error(\`delegate_permissions.writable_root "\${target}" is not usable: \${String(error?.message ?? error)}\`);
		try {
			mkdirSync(target, { recursive: true });
		} catch (createError) {
			throw new Error(\`delegate_permissions.writable_root "\${target}" does not exist and could not be created: \${String(createError?.message ?? createError)}\`);
		}
		return target;
	}
	if (!info.isDirectory()) throw new Error(\`delegate_permissions.writable_root "\${target}" is not a directory\`);
	return target;
}
/**
 * Turn the model's \`delegate_permissions\` request into the decision the child is
 * actually created with. A parent may only NARROW what it holds: the child is
 * clamped to the parent's standing mode, and a child writable root must live
 * inside a root the parent itself may write under (a parent already in
 * danger-full-access has no boundary, so any absolute directory is accepted).
 * @param request - the raw model-facing object, if the model supplied one.
 * @param parentMode - the delegating session's effective sandbox mode.
 * @param parentRoots - canonical roots the delegating session may write under (empty under danger-full-access).
 * @returns the carrier store (mode and cwd each optional), or undefined when the child inherits everything.
 */
function resolveDelegatedPermissions(request, parentMode, parentRoots) {
	if (request === void 0 || request === null) return void 0;
	if (typeof request !== "object" || Array.isArray(request)) throw new Error("delegate_permissions must be an object");
	const named = request.sandbox_mode;
	if (named !== void 0 && named !== "inherit" && !DELEGATED_SANDBOX_MODES.includes(named)) throw new Error(\`delegate_permissions.sandbox_mode must be one of inherit, \${DELEGATED_SANDBOX_MODES.join(", ")}, got "\${String(named)}"\`);
	const writableCwd = request.writable_root === void 0 ? void 0 : validateWritableRoot(request.writable_root);
	if (writableCwd !== void 0 && parentMode !== "danger-full-access" && !parentRoots.some((root) => isPathUnder(writableCwd, root))) throw new Error(\`delegate_permissions.writable_root "\${writableCwd}" is outside every root this session may write under, so the child could not write there; pick a path inside the delegating session's own workspace\`);
	if (named === "danger-full-access" && parentMode !== "danger-full-access") throw new Error(\`delegate_permissions.sandbox_mode "danger-full-access" would WIDEN the child beyond this session's "\${parentMode}" mode; a delegation may only narrow permissions\`);
	const sandboxMode = named === void 0 || named === "inherit" ? parentMode : SANDBOX_MODE_RANK[named] > SANDBOX_MODE_RANK[parentMode] ? parentMode : named;
	if (sandboxMode === parentMode && writableCwd === void 0) return void 0;
	return {
		...writableCwd === void 0 ? {} : { writableCwd },
		...sandboxMode === parentMode ? {} : { sandboxMode }
	};
}
/**
 * Read the delegating session's standing policy and turn the model's request
 * into the decision the child will be created with. Called INSIDE the tool body,
 * so the returned carrier travels from here to the child's creation through the
 * async context alone - nothing has to be threaded through the subagent service.
 * @param raw - the model-facing \`delegate_permissions\` argument, if any.
 * @param parent - the delegating agent.
 * @returns the resolved decision store, or undefined when the child inherits everything.
 */
function resolveDelegatedPermissionsForCall(raw, parent) {
	const parentPolicy = parent.ctx.get("sandboxPolicy")?.resolve({ session: parent.session });
	const parentMode = parentPolicy === void 0 ? "danger-full-access" : parentPolicy.mode;
	return resolveDelegatedPermissions(raw, parentMode, parentPolicy === void 0 ? [] : writableRoots(parentPolicy));
}
/**
 * Run one delegation with the permission carrier bound, then report the decision
 * to the audit sink the plugin published.
 *
 * The sink is read from the global registry at CALL time, never through a
 * module-scope capture of the carrier object. The plugin claims the sink on
 * whatever object the registry holds at THAT moment, so reading a captured
 * object here silently lost the plugin's sink: the feature still worked (the
 * schema gate reads the registry) while the audit trail stayed empty.
 * @param store - the resolved decision, or undefined to inherit everything.
 * @param delegatingSession - the delegating session's id, for the audit record.
 * @param run - the delegation to perform inside the scope.
 * @returns the delegation's own result.
 */
function bindDelegatedPermissions(store, delegatingSession, run) {
	if (store === void 0) return run();
	const carrier = globalThis[DELEGATED_PERMISSIONS_KEY];
	carrier?.sink?.({
		delegatingSession,
		writableCwd: store.writableCwd,
		sandboxMode: store.sandboxMode
	});
	const storage = carrier?.storage ?? DELEGATED_PERMISSIONS.storage;
	return storage.run(store, run);
}
/**
 * Whether the subagent-permissions plugin is mounted: its audit sink carries the
 * feature flag, so unmounting it removes the model-facing \`delegate_permissions\`
 * arguments again. Sampled when a tool composition is BUILT rather than at module
 * load, so activation order between this tool and the plugin cannot leave the
 * arguments unadvertised until a second restart.
 * @returns whether the delegating agent may scope a child's file permissions.
 */
function delegatePermissionsEnabled() {
	return globalThis[DELEGATED_PERMISSIONS_KEY]?.sink !== void 0;
}
/**
* Install one delegation-tool composition.`,
		'add the permission resolver and carrier-binding helpers',
	),
	edit(
		'tool.exports',
		`export { Config, apply, inject, name };`,
		`export { Config, apply, inject, name };
/** Exported for the dsh-subagent-permissions seam test and for audits. */
export { bindDelegatedPermissions, resolveDelegatedPermissions, resolveDelegatedPermissionsForCall, validateWritableRoot };`,
		'publish the seam helpers so the offline tests can exercise them directly',
	),
	edit(
		'tool.schema-fields',
		`						...backgroundEnabled ? { run_in_background: {
							type: "boolean",
							description: continuable ? "Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it." : "Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill."
						} } : {}`,
		`						...backgroundEnabled ? { run_in_background: {
							type: "boolean",
							description: continuable ? "Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it." : "Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill."
						} } : {},
						...delegatePermissionsEnabled() ? { delegate_permissions: {
							type: "object",
							description: "Optional file-permission scope for THIS child, fixed at spawn time and impossible for the child to widen. Omit it to inherit the standing policy and workspace root. A delegation may only NARROW: a mode wider than your own standing mode is rejected, and a writable_root outside your own writable roots is rejected. The child's file tools are fenced to writable_root when one is given.",
							properties: {
								sandbox_mode: {
									type: "string",
									enum: ["inherit", "read-only", "workspace-write", "danger-full-access"],
									description: "File-effect mode for the child. \\"inherit\\" (default) keeps your standing mode; \\"read-only\\" denies every file mutation in the child (it can still read, and can still write platform temporary areas); \\"workspace-write\\" confines child writes to its writable_root; \\"danger-full-access\\" is accepted only when your own standing mode is already danger-full-access."
								},
								writable_root: {
									type: "string",
									description: "Absolute path that becomes the child session's workspace and the boundary of its workspace-write mode. Created when missing. Must be inside a root this session may write under; omit to inherit your workspace. Relative paths are rejected."
								}
							}
						} } : {}`,
		'advertise delegate_permissions on the subagent tool',
	),
	edit(
		'tool.capture',
		`					async execute(args, exec) {
						const parent = exec.agent;
						if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
						const modelRequest = args;`,
		`					async execute(args, exec) {
						const parent = exec.agent;
						if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
						const modelRequest = args;
						const delegatedPermissions = resolveDelegatedPermissionsForCall(args.delegate_permissions, parent);`,
		'resolve the requested permission scope inside the delegating call',
	),
	edit(
		'tool.bind-foreground',
		`						return settleForegroundRun(await runtimeCtx.subagents.start(config.provider, {
							...request,
							signal: exec.signal
						}));`,
		`						return settleForegroundRun(await bindDelegatedPermissions(delegatedPermissions, parent.session.id, () => runtimeCtx.subagents.start(config.provider, {
							...request,
							signal: exec.signal
						})));`,
		'bind the carrier around the foreground delegation',
	),
	edit(
		'tool.bind-background',
		`										return {
											cancel: (reason) => {
												controller.abort(reason ?? "background subagent task killed");
											},
											done: settleStart(runtimeCtx.subagents.start(config.provider, {
												...request,
												signal: controller.signal
											}), controller.signal)
										};`,
		`										return {
											cancel: (reason) => {
												controller.abort(reason ?? "background subagent task killed");
											},
											done: settleStart(bindDelegatedPermissions(delegatedPermissions, parent.session.id, () => runtimeCtx.subagents.start(config.provider, {
												...request,
												signal: controller.signal
											})), controller.signal)
										};`,
		'bind the carrier around the background (one-shot) delegation',
	),
	edit(
		'tool.bind-continuable',
		`							if (continuable) return {
								kind: "continuable",
								subagentId: (await runtimeCtx.subagents.startContinuable({
									provider: config.provider,
									label: args.description,
									request,
									signal: exec.signal
								})).childId
							};`,
		`							if (continuable) return {
								kind: "continuable",
								subagentId: (await bindDelegatedPermissions(delegatedPermissions, parent.session.id, () => runtimeCtx.subagents.startContinuable({
									provider: config.provider,
									label: args.description,
									request,
									signal: exec.signal
								}))).childId
							};`,
		'bind the carrier around the continuable delegation',
	),
];

const TYPES_LAYER_ENTRY_EDITS = [
	edit(
		'types.activation.composition-call-site',
		`            applyChildComposition(childCtx, parent, inputs.composition);`,
		`            applyChildComposition(childCtx, parent, inputs.composition, child.session);`,
		'hand the child session to the composition (the types-layer activation, same fix as the bundle)',
	),
];

const TYPES_CHILD_AGENT_EDITS = [
	edit(
		'types.child-agent.carrier-import',
		`export function childSessionMeta(parent, childDepth, isSeeded) {`,
		`const DELEGATED_PERMISSIONS_KEY = Symbol.for("dsh.subagent-permissions.carrier");
/** The store the patched tool half binds; see the bundled child-agent for the full note. */
const delegatedPermissionsStorage = globalThis[DELEGATED_PERMISSIONS_KEY] === void 0
    ? new AsyncLocalStorage()
    : globalThis[DELEGATED_PERMISSIONS_KEY].storage;
/**
 * Read the permission decision bound to the CURRENT async context.
 * @returns the pending decision, or undefined outside a delegating tool call.
 */
function pendingDelegatedPermissions() {
    return delegatedPermissionsStorage.getStore();
}
export function childSessionMeta(parent, childDepth, isSeeded) {`,
		'share the carrier with the bundled half',
	),
	edit(
		'types.child-agent.als-import',
		`import { delegationDepthOf } from "./depth.js";`,
		`import { AsyncLocalStorage } from "node:async_hooks";
import { delegationDepthOf } from "./depth.js";`,
		'import AsyncLocalStorage',
	),
	edit(
		'types.child-agent.child-meta',
		`export function childSessionMeta(parent, childDepth, isSeeded) {
    const parentHeader = parent.session.header;
    const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx);
    return {
        ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},`,
		`export function childSessionMeta(parent, childDepth, isSeeded) {
    const parentHeader = parent.session.header;
    const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx);
    const delegatedPermissions = pendingDelegatedPermissions();
    return {
        ...delegatedPermissions?.writableCwd !== undefined ? { cwd: delegatedPermissions.writableCwd } : parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},`,
		'a delegation may give the child its own writable root',
	),
	edit(
		'types.child-agent.child-composition',
		`export function applyChildComposition(childCtx, parent, composition) {
    childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx);
    childCtx.systemPrompt.context({
        name: 'subagent:delegation',
        order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
        text: SUBAGENT_DELEGATION_CONTEXT,
    });`,
		`export function applyChildComposition(childCtx, parent, composition, childSession) {
    childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx);
    const delegatedPermissions = pendingDelegatedPermissions();
    if (delegatedPermissions?.sandboxMode !== undefined) {
        if (childSession === undefined)
            throw new Error('subagent: a delegated sandbox mode needs the child session, but the caller passed none - the applyChildComposition call site is out of date');
        childSession.append('sandbox/mode', { mode: delegatedPermissions.sandboxMode, source: 'delegation' });
    }
    childCtx.systemPrompt.context({
        name: 'subagent:delegation',
        order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
        text: delegatedPermissions === undefined ? SUBAGENT_DELEGATION_CONTEXT : SUBAGENT_DELEGATION_CONTEXT + ' Your file permission scope for this delegation was fixed by the delegating agent: '
            + (delegatedPermissions.sandboxMode === undefined ? 'the standing policy applies' : 'sandbox mode ' + JSON.stringify(delegatedPermissions.sandboxMode))
            + (delegatedPermissions.writableCwd === undefined ? '; your session workspace is the inheriting workspace.' : '; your writable workspace root is ' + JSON.stringify(delegatedPermissions.writableCwd) + ', so under a workspace-write mode you may modify files only under it, plus platform temporary areas.'),
    });`,
		'apply the delegated sandbox mode from the child session and narrate it',
	),
];

const DRIVER_EDITS = [
	edit(
		'driver.composition-call-site',
		`		applyChildComposition(childCtx, parent, {
			persona: request.persona,
			toolFilter: request.toolFilter
		});`,
		`		applyChildComposition(childCtx, parent, {
			persona: request.persona,
			toolFilter: request.toolFilter
		}, child.session);`,
		'hand the child session to the composition (the one-shot path the subagent tool uses)',
	),
];

const PATCHES = [
	patchFile('@deepseek-ai/dsh-subagent', join('lib', 'index.js'), SUBAGENT_EDITS),
	patchFile('@deepseek-ai/dsh-subagent', join('lib', 'types', 'child-agent.js'), TYPES_CHILD_AGENT_EDITS),
	patchFile('@deepseek-ai/dsh-subagent', join('lib', 'types', 'continuation-activation.js'), TYPES_LAYER_ENTRY_EDITS),
	patchFile('@deepseek-ai/dsh-tool-subagent', join('lib', 'index.js'), TOOL_SUBAGENT_EDITS),
	patchFile('@deepseek-ai/dsh-subagent-in-process-driver', join('lib', 'index.js'), DRIVER_EDITS),
];

/** Exported for the offline test suite (probe-anchor.mjs), which loads this module. */
export { PATCHES, findPackage, applyEdits, TOOL_SUBAGENT_EDITS, SUBAGENT_EDITS };

// ---------------------------------------------------------------------------
// the mechanical parts
// ---------------------------------------------------------------------------

function applyEdits(source, file) {
	let text = source;
	const applied = [];
	for (const item of file.edits) {
		const occurrences = text.split(item.before).length - 1;
		if (occurrences !== 1) {
			throw new Error(`${file.pkgName}/${file.relPath}: anchor "${item.id}" matched ${occurrences} times (need exactly 1). The installed package differs from the version this patch was written against; re-derive that anchor before patching.`);
		}
		text = text.replace(item.before, item.after);
		applied.push(item.id);
	}
	return { text, applied };
}

function sha256(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Minimal context diff: enough to eyeball every edit, not a patch format. */
function contextDiff(beforeText, afterText, label) {
	const before = beforeText.split('\n');
	const after = afterText.split('\n');
	const out = [`--- ${label} (original)`, `+++ ${label} (patched)`];
	let i = 0;
	let j = 0;
	while (i < before.length || j < after.length) {
		if (before[i] === after[j]) {
			i += 1;
			j += 1;
			continue;
		}
		let lookahead = -1;
		for (let probe = 0; probe < 40 && j + probe < after.length; probe += 1) {
			if (after[j + probe] === before[i]) {
				lookahead = probe;
				break;
			}
		}
		const removed = [];
		while (i < before.length && (lookahead === -1 || before[i] !== after[j])) {
			removed.push(before[i]);
			i += 1;
			if (removed.length > 200) break;
		}
		out.push(`@@ original line ${i - removed.length + 1} @@`);
		for (const line of removed) out.push(`- ${line}`);
		for (let add = 0; add < lookahead; add += 1) out.push(`+ ${after[j + add]}`);
		j += Math.max(lookahead, 0);
	}
	return out.join('\n');
}

function backupPathOf(pkg, relPath) {
	return join(BACKUP_DIR, `${pkg.name.replace('@deepseek-ai/', '')}-${pkg.version}`, relPath);
}

function run(argv) {
	const outIndex = argv.indexOf('--out');
	const outDir = outIndex === -1 ? undefined : argv[outIndex + 1];
	const fromIndex = argv.indexOf('--from');
	const fromDir = fromIndex === -1 ? undefined : argv[fromIndex + 1];
	const checkOnly = argv.includes('--check');
	const dryRun = argv.includes('--dry-run') || checkOnly;
	const wantDiff = argv.includes('--diff');
	const revert = argv.includes('--revert');
	const report = [];

	for (const file of PATCHES) {
		const pkg = findPackage(file.pkgName);
		const sourcePath = fromDir === undefined
			? join(pkg.dir, file.relPath)
			: join(fromDir, `${pkg.name.replace('@deepseek-ai/', '')}-${pkg.version}`, file.relPath);
		if (!existsSync(sourcePath)) throw new Error(`original not found at ${sourcePath} (--from expects a backup/ tree)`);
		const original = readFileSync(sourcePath, 'utf8');
		const backupPath = backupPathOf(pkg, file.relPath);

		if (revert) {
			// A file added to the patch table AFTER the installed packages were already
			// patched has no backup yet; it is either not patched (nothing to do) or
			// was shipped patched by -Apply (which backs up before writing). Report it
			// rather than aborting the whole restore.
			if (!existsSync(backupPath)) {
				report.push(`SKIP  ${file.pkgName}/${file.relPath}: no backup to restore from (${backupPath})`);
				continue;
			}
			writeFileSync(sourcePath, readFileSync(backupPath, 'utf8'), 'utf8');
			report.push(`restored ${sourcePath} from ${backupPath}`);
			continue;
		}

		const alreadyPatched = original.includes('DELEGATED_PERMISSIONS_KEY');
		let result;
		try {
			result = applyEdits(original, file);
		} catch (error) {
			if (alreadyPatched) {
				report.push(`SKIP  ${file.pkgName}: already patched (anchors no longer match, which is expected)`);
				continue;
			}
			throw error;
		}

		if (!SUPPORTED_VERSIONS.has(pkg.version)) {
			report.push(`WARN  ${file.pkgName} version ${pkg.version} is not one this patch was validated against; the anchors did still match.`);
		}
		if (checkOnly) {
			report.push(`OK    ${file.pkgName}@${pkg.version}: all ${result.applied.length} anchors match`);
			continue;
		}
		if (!existsSync(backupPath)) {
			mkdirSync(dirname(backupPath), { recursive: true });
			writeFileSync(backupPath, original, 'utf8');
			report.push(`backup ${relative(HERE, backupPath)}  sha256=${sha256(original)}`);
		}

		const targetPath = outDir === undefined ? sourcePath : join(outDir, file.pkgName.replace('@deepseek-ai/', ''), file.relPath);
		if (!dryRun) {
			mkdirSync(dirname(targetPath), { recursive: true });
			writeFileSync(targetPath, result.text, 'utf8');
		}
		report.push(`${dryRun ? 'WOULD ' : 'PATCH '}${targetPath}  (${result.applied.length} edits, sha256 ${sha256(original).slice(0, 12)} -> ${sha256(result.text).slice(0, 12)})`);
		if (wantDiff) report.push(contextDiff(original, result.text, `${file.pkgName}/${file.relPath}`));
	}

	process.stdout.write(report.join('\n') + '\n');
}

// Run the CLI only when this file is the entry point; importing it (the test
// suite does) must not patch anything.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
	try {
		run(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`patch.mjs: ${error.message}\n`);
		process.exitCode = 1;
	}
}
