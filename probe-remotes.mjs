// probe-remotes.mjs - does each candidate remote repository already exist and can
// this deploy key reach it? Pushes are irreversible-ish, so answer this first.
import { execFileSync } from 'node:child_process';

const CANDIDATES = [
	['github', 'git@dsh-memory-github:Windy-Secker/subagent-permissions.git'],
	['gitee', 'git@dsh-memory-gitee:Windy-Secker/subagent-permissions.git'],
];

for (const [name, url] of CANDIDATES) {
	let output = '';
	let ok = true;
	try {
		output = execFileSync('git', ['ls-remote', '--heads', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		ok = false;
		output = `${error.stdout ?? ''}${error.stderr ?? error.message}`;
	}
	const heads = output.split('\n').filter((line) => line.includes('refs/heads/'));
	console.log(`=== ${name}: ${url}`);
	console.log(`    reachable: ${ok}`);
	console.log(`    remote heads: ${heads.length === 0 ? '(none - empty repo or no such repo)' : heads.map((line) => line.split('refs/heads/')[1]).join(', ')}`);
	if (!ok) console.log(`    detail: ${output.trim().split('\n').slice(-2).join(' | ')}`);
}
