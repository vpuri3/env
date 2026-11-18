/**
 * pi-fleet: many pi sessions in the pi deck (session list, nvim, pi), each with its own nvim.
 * Design: ~/env/docs/pi-fleet-design.md and pi-deck-design.md (§15: the three-pane deck). The CLI
 * (cli.ts, bin/pi-fleet) and the deck (deck*.ts) are not extension modules.
 *
 * This file only registers the modules; each phase owns its module files and never edits
 * this one. status.ts must stay first: it decides on session_start whether this is a main
 * session (fleetOf(pi).main in shared.ts) before the other modules' handlers run.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register as agentsView } from "./agents-view.ts";
import { register as control } from "./control.ts";
import { register as edits } from "./edits.ts";
import { register as files } from "./files.ts";
import { register as leader } from "./leader.ts";
import { register as lifecycle } from "./lifecycle.ts";
import { register as nvim } from "./nvim.ts";
import { register as registry } from "./registry.ts";
import { register as reload } from "./reload.ts";
import { register as sessionsView } from "./sessions-view.ts";
import { register as status } from "./status.ts";
import { register as title } from "./title.ts";
import { register as toolOutput } from "./tool-output.ts";
import { register as view } from "./view.ts";

export default function piFleet(pi: ExtensionAPI): void {
	status(pi);
	registry(pi);
	lifecycle(pi);
	control(pi);
	agentsView(pi);
	sessionsView(pi);
	nvim(pi);
	view(pi);
	files(pi);
	toolOutput(pi);
	edits(pi);
	leader(pi);
	title(pi);
	reload(pi);
}
