/**
 * dsh-subagent-permissions - the plugin half of per-subagent file permissions.
 *
 * THE PROBLEM
 * -----------
 * dsh freezes a child session's permission scope the moment the child is created:
 * `dsh-sandbox-policy.resolve()` reads the immutable `SessionHeader.cwd` for the
 * writable root and the session's own `sandbox/mode` event for the mode, and a
 * subagent inherits both from its parent. Nothing in the model-facing `subagent`
 * tool let a delegating agent choose anything else - and because the header is
 * frozen at creation and `agent/created` fires only after publication, a plain
 * plugin cannot reach in and change it later.
 *
 * THE FIX (two halves, both shipped here)
 * ---------------------------------------
 * 1. `patch.mjs` teaches the two installed packages a delegation scope:
 *    `@deepseek-ai/dsh-subagent` reads one AsyncLocalStorage carrier while the
 *    child session is still unpublished (`childSessionMeta` picks the cwd,
 *    `applyChildComposition` appends the `sandbox/mode` event), and
 *    `@deepseek-ai/dsh-tool-subagent` advertises and validates the two new
 *    arguments. A delegation may only NARROW: the child is clamped to the
 *    parent's standing mode, and its writable root must sit inside a root the
 *    parent itself may write under.
 * 2. THIS plugin owns everything that is policy rather than plumbing: the audit
 *    record of every delegated scope, an extra containment policy on top of the
 *    patch, and the feature switch itself - the patched tool advertises
 *    `delegate_permissions` only while this plugin has claimed the carrier's
 *    sink.
 *
 * The two halves meet on ONE process-wide object keyed by
 * `Symbol.for("dsh.subagent-permissions.carrier")`: `{ storage, sink }`. The
 * store rides the async context, so concurrent delegations never see each
 * other's scope and a detached child turn sees none.
 *
 * MODEL EXPERIENCE
 * ----------------
 * `subagent({ ..., delegate_permissions: { sandbox_mode, writable_root } })`.
 * Omitting the object inherits the standing policy and workspace root exactly as
 * before this package existed; unmounting the plugin removes the arguments from
 * the tool schema again.
 *
 * @module dsh-subagent-permissions
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const name = "subagent-permissions";
export const inject = ["tools"];

/** The process-wide rendezvous the patched packages read (see patch.mjs). */
const CARRIER_KEY = Symbol.for("dsh.subagent-permissions.carrier");
/** Accepted sandbox modes, narrowest first. Kept in sync with the patch's vocabulary. */
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
/** Where the audit trail goes when no explicit file is configured. */
const DEFAULT_AUDIT_FILE = "subagent-permissions.audit.jsonl";

/**
 * Whether one path is the other or lies beneath it.
 * @param child - the candidate descendant.
 * @param parent - the containing root.
 * @returns whether `child` is `parent` or below it.
 */
export function isPathUnder(child, parent) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Apply this plugin's own containment policy to one delegation request. The
 * patched tool already refuses a root outside the delegating session's writable
 * roots; `writableRootBase` narrows that further, to one deployment-chosen
 * subtree (for example a per-project `subagents/` directory), so an operator can
 * fence delegations without trusting the model.
 * @param request - the raw `delegate_permissions` argument, if present.
 * @param base - the configured base directory, or undefined to allow anything the patch allows.
 * @param sessionCwd - the delegating session's workspace, used to resolve a relative request.
 * @returns nothing; throws when the policy refuses the request.
 */
export function assertWritableRootPolicy(request, base, sessionCwd) {
	if (base === undefined || request === null || typeof request !== "object") return;
	const requested = request.writable_root;
	if (typeof requested !== "string" || requested.trim().length === 0) return;
	const absolute = isAbsolute(requested) ? requested : resolve(sessionCwd ?? process.cwd(), requested);
	if (isPathUnder(absolute, base)) return;
	throw new Error(`delegate_permissions.writable_root "${absolute}" is outside the configured delegation base "${base}"; a subagent may only be given a workspace under that base`);
}

/**
 * Render one audit line's payload for a delegated scope.
 * @param exec - the pending tool call.
 * @param request - the model-supplied `delegate_permissions` object.
 * @returns the record to append.
 */
function auditRecord(exec, request) {
	return {
		at: new Date().toISOString(),
		delegatingSession: exec.agent?.session?.id,
		tool: exec.name,
		delegatedSession: exec.arguments?.session_id,
		label: exec.arguments?.description,
		requested: request ?? null,
	};
}

/**
 * Append one audit record. Never throws: an audit failure must not fail the
 * delegation it describes.
 * @param path - the JSONL file to append to.
 * @param record - the record to write.
 * @param logger - the context logger, for the warning path.
 */
export function appendAuditRecord(path, record, logger) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	} catch (error) {
		logger?.warn(`subagent-permissions: could not append the audit record to ${path}: ${String(error)}`);
	}
}

/**
 * Install the plugin.
 * @param ctx - the Cordis context owning the registrations.
 * @param config - see the README's configuration table.
 */
export function apply(ctx, config = {}) {
	const enabled = config.delegatePermissions !== false;
	const auditWanted = config.auditLog !== false;
	const base = config.writableRootBase === undefined ? undefined : resolve(config.writableRootBase);
	const auditPath = config.auditFile === undefined ? join(ctx.baseDir ?? process.cwd(), DEFAULT_AUDIT_FILE) : resolve(config.auditFile);
	const carrier = globalThis[CARRIER_KEY];

	if (carrier === undefined || typeof carrier.storage?.run !== "function") {
		ctx.logger.warn(
			"subagent-permissions: the patched @deepseek-ai/dsh-subagent / @deepseek-ai/dsh-tool-subagent are not installed, so delegate_permissions is inert. Run install-subagent-permissions.ps1 -Apply and restart dsh.",
		);
		return;
	}

	// Claiming the sink is what makes the patched tool ADVERTISE the arguments,
	// so this is the feature switch. It also routes the patch's own record of an
	// applied scope into the audit trail.
	const previousSink = carrier.sink;
	carrier.sink = (record) => {
		if (!auditWanted) return;
		appendAuditRecord(auditPath, { at: new Date().toISOString(), applied: true, ...record }, ctx.logger);
	};
	ctx.effect(() => () => {
		if (carrier.sink !== undefined) carrier.sink = previousSink;
	}, "subagent-permissions.claim-sink()");

	if (!enabled) {
		ctx.logger.info("subagent-permissions: delegatePermissions is false, so the delegate_permissions arguments are NOT advertised on the subagent tool");
		return;
	}

	// The deployment-level containment policy, checked before anything dispatches.
	// A failure here must never take a delegation down: a POLICY refusal is
	// re-thrown as-is (that is the feature), while an UNEXPECTED failure is
	// recorded and the call proceeds, so an audit or policy bug can never turn a
	// working delegation into a hard error.
	ctx.on("tools/execute", async (exec, next) => {
		try {
			if (exec.name !== (config.toolName ?? "subagent")) return next();
			const request = exec.arguments?.delegate_permissions;
			if (request === undefined) return next();
			assertWritableRootPolicy(request, base, exec.agent?.session?.header?.cwd);
			if (auditWanted) appendAuditRecord(auditPath, auditRecord(exec, request), ctx.logger);
			return next();
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("delegate_permissions.")) throw error;
			if (auditWanted) appendAuditRecord(auditPath, { at: new Date().toISOString(), hookError: String(error) }, ctx.logger);
			return next();
		}
	});

	ctx.logger.info(
		`subagent-permissions: per-subagent file permissions are ON (modes: ${SANDBOX_MODES.join(", ")}; writable-root base: ${base ?? "the delegating session's writable roots"}; audit: ${auditWanted ? auditPath : "off"})`,
	);
}
