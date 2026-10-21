import { messageOf } from "../log/error-message.js";
import { isSet } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";

const PROMPT = "Paste your Amazon Bedrock API key (input hidden): ";
const NO_KEY_HELP = "No Amazon Bedrock API key is stored for you. Ask in the DTSSE channel for one, then run hai again and paste it when prompted.";

/** A virtual agent's tmux pane is a terminal nobody watches, so only a person is ever prompted. */
export function canPrompt(seams: Seams): boolean {
  return seams.hiddenInput.isTty && !isSet(seams.env, "AGENT_HUB_LAUNCH_TOKEN");
}

/**
 * Mirrors run.sh's bedrock_key(): environment first, then agent-hub, then a hidden
 * prompt. A key pasted at the prompt is saved back to agent-hub when it can be; when it
 * cannot, it is used for this session only and the user is told so.
 */
export async function resolveBedrockKey(deps: { seams: Seams; agentHub: AgentHub; offline: boolean }): Promise<string> {
  const { seams, agentHub } = deps;
  const fromEnv = seams.env.AWS_BEARER_TOKEN_BEDROCK;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }

  if (deps.offline) {
    requirePrompt(seams, "HAI_OFFLINE=1 and no AWS_BEARER_TOKEN_BEDROCK in the environment");
    seams.logger.say("HAI_OFFLINE=1, so the key cannot be read from agent-hub; it will not be saved this time");
    return promptForKey(seams);
  }

  let stored: string | null = null;
  try {
    stored = await agentHub.getBedrockKey();
  } catch (err) {
    requirePrompt(seams, `could not read your Amazon Bedrock API key from agent-hub (${messageOf(err)})`);
    seams.logger.say(`could not read your Amazon Bedrock API key from agent-hub (${messageOf(err)}); it will not be saved this time`);
    return promptForKey(seams);
  }
  if (stored !== null) {
    return stored;
  }

  requirePrompt(seams, NO_KEY_HELP);
  seams.logger.say(`${NO_KEY_HELP} It is saved to agent-hub for your next session.`);
  const key = await promptForKey(seams);
  try {
    await agentHub.putBedrockKey(key);
    seams.logger.say("saved to agent-hub");
  } catch (err) {
    seams.logger.say(`could not save the key to agent-hub (${messageOf(err)}); using it for this session only`);
  }
  return key;
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
