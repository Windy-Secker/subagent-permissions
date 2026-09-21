// inspect-session.mjs - decompress dsh session logs (zstd JSONL) and report the facts
// the permission verification cares about: the header cwd, any `sandbox/mode` event,
// the policy line the child was actually given, and the delegated-scope sentence.
//
// usage: node inspect-session.mjs <file-or-directory> [<more>...]
//   a directory is searched recursively for session.v3.jsonl.zstd

import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

/**
 * Decode one dsh session log. The file is a SEQUENCE of concatenated zstd
 * frames (a header frame plus one frame per flushed event batch), so the
 * one-shot `zstdDecompressSync` would return only the header - the streaming
 * decoder is what walks every frame.
 * @param path - the session log.
 * @returns the decoded JSONL text.
 */
function decode(path) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		createReadStream(path)
			.pipe(createZstdDecompress())
			.on('data', (chunk) => chunks.push(chunk))
			.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
			.on('error', reject);
	});
}

/** Expand the arguments into session-log paths. */
function expand(inputs) {
	const files = [];
	for (const input of inputs) {
		const info = statSync(input);
		if (info.isFile()) {
			files.push(input);
			continue;
		}
		const walk = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl')) files.push(path);
			}
		};
		walk(input);
	}
	return files;
}

for (const path of expand(process.argv.slice(2))) {
	let text;
	try {
		text = await decode(path);
	} catch (error) {
		console.log(`${path}\n  DECODE FAILED: ${error.message}`);
		continue;
	}
	const events = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			events.push(JSON.parse(trimmed));
		} catch {
			// a partially flushed tail line is normal in an append-only log
		}
	}
	console.log(`=== ${path}`);
	console.log(`  events: ${events.length}`);
	const header = events.find((event) => event.type === 'session/header') ?? events[0];
	const cwd = header?.data?.cwd ?? header?.cwd;
	if (cwd !== undefined) console.log(`  header cwd: ${cwd}`);
	for (const event of events) {
		if (event.type === 'sandbox/mode') console.log(`  sandbox/mode: ${JSON.stringify(event.data)}`);
	}
	const grep = (needle, pattern, label) => {
		for (const event of events) {
			const blob = JSON.stringify(event);
			if (!blob.includes(needle)) continue;
			const match = blob.match(pattern);
			if (match !== null) {
				console.log(`  ${label}: ${match[0]}`);
				return;
			}
		}
	};
	grep('Current DSH file policy', /Current DSH file policy:[^"\\]{0,150}/, 'policy line');
	grep('fixed by the delegating agent', /Your file permission scope for this delegation[^"\\]{0,240}/, 'delegation line');
}

