import { launch } from "./launch.js";
import { messageOf } from "./log/error-message.js";
import { launchSbx } from "./sbx-launch.js";
import { createSeams, type Seams } from "./system/seams.js";

export async function main(processArgv: string[], seams: Seams = createSeams()): Promise<void> {
  await reported(seams, () => launch({ seams, processArgv }));
}

/** The `sbx-hai` entrypoint: the same contract, in a Docker Sandboxes microVM. */
export async function sbxMain(processArgv: string[], seams: Seams = createSeams()): Promise<void> {
  await reported(seams, () => launchSbx({ seams, processArgv }));
}

async function reported(seams: Seams, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    // Everything user-facing goes through the logger, which redacts: an error carrying a
    // pasted key or a token from a failed az call must not land in a terminal scrollback.
    seams.logger.say(messageOf(err));
    seams.exit(1);
  }
}
