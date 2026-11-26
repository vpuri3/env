// Temp dirs for tests that run tmux, nvim or git in them.
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * A fresh dir under /tmp, by its real path. Not os.tmpdir(): on macOS that is a long path under the
 * /var -> /private/var symlink, so `<dir>/run/<uuid>.nvim.sock` exceeds the 104-byte unix socket
 * limit (nvim --listen fails), and git and tmux report /private/var/… where the test expects /var/….
 * The product keeps its sockets under /tmp too (cli.ts runtimeDir).
 */
export function tempRoot(prefix: string): string {
	return realpathSync(mkdtempSync(join("/tmp", prefix)));
}
