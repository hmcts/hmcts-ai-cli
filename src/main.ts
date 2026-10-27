import { launchHair } from "./hair-launch.js";
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

/** The `hair` entrypoint: claims a conversation out of the session registry and hands it to `launch`. */
export async function hairMain(processArgv: string[], seams: Seams = createSeams()): Promise<void> {
  await reported(seams, () => launchHair({ seams, processArgv }));
}

async function reported(seams: Seams, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    // The logger redacts: an error carrying a pasted key or an az token must not land in a scrollback.
    seams.logger.say(messageOf(err));
    seams.exit(1);
  }
}
