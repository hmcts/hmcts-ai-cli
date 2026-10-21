import { launch } from "./launch.js";
import { messageOf } from "./log/error-message.js";
import { createSeams, type Seams } from "./system/seams.js";

export async function main(processArgv: string[], seams: Seams = createSeams()): Promise<void> {
  try {
    await launch({ seams, processArgv });
  } catch (err) {
    // Everything user-facing goes through the logger, which redacts: an error carrying a
    // pasted key or a token from a failed az call must not land in a terminal scrollback.
    seams.logger.say(messageOf(err));
    seams.exit(1);
  }
}
