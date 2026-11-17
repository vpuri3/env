// Shared by the view*.test.ts files: find pi's installed packages and resolve
// `@earendil-works/*` imports from them in this process.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** node_modules holding pi's packages: $PI_FLEET_PI_PACKAGES, else from `realpath(which pi)`. */
export function piPackages(): string | undefined {
	const has = (dir: string) => existsSync(join(dir, "@earendil-works", "pi-tui", "package.json"));
	if (process.env.PI_FLEET_PI_PACKAGES) return has(process.env.PI_FLEET_PI_PACKAGES) ? process.env.PI_FLEET_PI_PACKAGES : undefined;
	let real: string;
	try {
		real = realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim());
	} catch {
		return undefined;
	}
	const agent = resolve(real, "..", "..");
	try {
		const v = readFileSync(join(agent, "install", "current-version"), "utf8").trim();
		const dir = join(agent, "install", "releases", v, "node_modules");
		if (has(dir)) return dir;
	} catch {
		// npm install
	}
	for (let dir = dirname(real); dir !== dirname(dir); dir = dirname(dir)) {
		if (has(join(dir, "node_modules"))) return join(dir, "node_modules");
	}
	return undefined;
}

/** Resolve `@earendil-works/*` from `packages` for every later import in this process. */
export async function usePackages(packages: string): Promise<void> {
	const { registerHooks } = await import("node:module");
	const parentURL = pathToFileURL(join(packages, "resolve.js")).href;
	registerHooks({
		resolve(specifier, context, next) {
			return specifier.startsWith("@earendil-works/") ? next(specifier, { ...context, parentURL }) : next(specifier, context);
		},
	});
}
