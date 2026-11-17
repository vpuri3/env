/**
 * fleet/control: stub from phase 1.
 *
 * Phase 3: the control socket <id>.pi.sock (ping, kill, user_write; §10).
 * Check fleetOf(pi).main (./shared.ts) before acting: false in subagent sessions and
 * print/json modes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function register(_pi: ExtensionAPI): void {}
