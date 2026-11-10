import { isSet } from "../system/env.js";
import type { Seams } from "../system/seams.js";

const PROMPT = "Paste your Amazon Bedrock API key (input hidden): ";
const NO_ENV_KEY_HELP =
  "No Amazon Bedrock API key in AWS_BEARER_TOKEN_BEDROCK, and HAI_ROUTE=bedrock reads no other source. Ask in the DTSSE channel for one, then run hai again and paste it when prompted.";

/** A virtual agent's tmux pane is a terminal nobody watches, so only a person is ever prompted. */
export function canPrompt(seams: Seams): boolean {
  return seams.hiddenInput.isTty && !isSet(seams.env, "AGENT_HUB_LAUNCH_TOKEN");
}

/** The environment, or a key pasted at the prompt for a named `HAI_ROUTE=bedrock`. Nothing is saved. */
export async function resolveBedrockKey(deps: { seams: Seams }): Promise<string> {
  const { seams } = deps;
  const fromEnv = seams.env.AWS_BEARER_TOKEN_BEDROCK;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }

  requirePrompt(seams, NO_ENV_KEY_HELP);
  seams.logger.say(NO_ENV_KEY_HELP);
  return promptForKey(seams);
}

/** Fail fast rather than block on a pipe nobody is typing into. */
function requirePrompt(seams: Seams, why: string): void {
  if (!canPrompt(seams)) {
    throw new Error(`${why}, and stdin is not a terminal so there is nobody to ask. Export AWS_BEARER_TOKEN_BEDROCK and run hai again.`);
  }
}

async function promptForKey(seams: Seams): Promise<string> {
  const key = (await seams.hiddenInput.readHidden(PROMPT)).trim();
  if (key === "") {
    throw new Error("no Amazon Bedrock API key entered");
  }
  return key;
}
