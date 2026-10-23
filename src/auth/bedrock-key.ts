import { messageOf } from "../log/error-message.js";
import { isSet } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";

const PROMPT = "Paste your Amazon Bedrock API key (input hidden): ";
const NO_KEY_HELP = "No Amazon Bedrock API key is stored for you. Ask in the DTSSE channel for one, then run hai again and paste it when prompted.";
/** Only for a named HAI_ROUTE=bedrock, whose sources are the environment and a paste: "none stored for you" would be a claim nobody checked. */
const NO_ENV_KEY_HELP =
  "No Amazon Bedrock API key in AWS_BEARER_TOKEN_BEDROCK, and HAI_ROUTE=bedrock reads no other source. Ask in the DTSSE channel for one, then run hai again and paste it when prompted.";

/** A virtual agent's tmux pane is a terminal nobody watches, so only a person is ever prompted. */
export function canPrompt(seams: Seams): boolean {
  return seams.hiddenInput.isTty && !isSet(seams.env, "AGENT_HUB_LAUNCH_TOKEN");
}

/**
 * How far this may look is the route's own `byName`, not a second decision of its own.
 *
 * A named `HAI_ROUTE=bedrock` is one credential from one source — the environment, or a
 * paste — so agent-hub is not one of them. Reading it anyway broke "no fallbacks" and made
 * the launch line say `prompt` for a key that had come off the hub.
 *
 * The unset path keeps the whole chain, env → agent-hub → prompt, whichever branch of
 * `resolveRoute` sent it here. `credentialSource` cannot stand in for this: `prompt` is
 * also what the AI-Gateway downgrade reports, and there a hub read is exactly right —
 * `gatherSignals`' probe may have thrown (a 5xx, or its 15s timeout) while the Key Vault
 * failed separately for a VPN that is down, and asking someone to paste a key the hub
 * already holds both wastes the key and overwrites it on the way back out.
 *
 * A key pasted at the prompt is still saved back to agent-hub when it can be — that is a
 * write, not a source, and it is what lets a later unset run find it. When it cannot be
 * saved, it is used for this session only and the user is told so.
 */
export async function resolveBedrockKey(deps: { seams: Seams; agentHub: AgentHub; offline: boolean; byName: boolean }): Promise<string> {
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

  if (deps.byName) {
    return await promptAndSave(seams, agentHub, NO_ENV_KEY_HELP);
  }

  let stored: string | null = null;
  try {
    stored = await agentHub.getCredential("bedrock");
  } catch (err) {
    requirePrompt(seams, `could not read your Amazon Bedrock API key from agent-hub (${messageOf(err)})`);
    seams.logger.say(`could not read your Amazon Bedrock API key from agent-hub (${messageOf(err)}); it will not be saved this time`);
    return promptForKey(seams);
  }
  if (stored !== null) {
    return stored;
  }

  return await promptAndSave(seams, agentHub, NO_KEY_HELP);
}

async function promptAndSave(seams: Seams, agentHub: AgentHub, help: string): Promise<string> {
  requirePrompt(seams, help);
  seams.logger.say(`${help} It is saved to agent-hub for your next session.`);
  const key = await promptForKey(seams);
  try {
    await agentHub.putCredential("bedrock", key);
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
