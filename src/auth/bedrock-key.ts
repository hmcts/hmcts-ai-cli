import { messageOf } from "../log/error-message.js";
import { isSet } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";
import type { CredentialSource } from "./route.js";

const PROMPT = "Paste your Amazon Bedrock API key (input hidden): ";
const NO_KEY_HELP = "No Amazon Bedrock API key is stored for you. Ask in the DTSSE channel for one, then run hai again and paste it when prompted.";
/** Said when the hub is not one of this route's sources, so "none stored for you" would be a claim nobody checked. */
const NO_ENV_KEY_HELP =
  "No Amazon Bedrock API key in AWS_BEARER_TOKEN_BEDROCK. Ask in the DTSSE channel for one, then run hai again and paste it when prompted.";

/** A virtual agent's tmux pane is a terminal nobody watches, so only a person is ever prompted. */
export function canPrompt(seams: Seams): boolean {
  return seams.hiddenInput.isTty && !isSet(seams.env, "AGENT_HUB_LAUNCH_TOKEN");
}

/**
 * Fetches the key the resolved route already named a source for, rather than deciding
 * again: `source` is `resolveRoute`'s `credentialSource`, and the hub is read only when
 * that source is `agent-hub`.
 *
 * The asymmetry is deliberate. On the unset path a stored key is the *signal* that chose
 * the bedrock route at all (`hasStoredBedrockKey`), so reading the hub there is not a
 * fallback — it is the reason we are here, and `source` says so. A named `HAI_ROUTE=bedrock`
 * is one credential from one source, the environment or a paste, so the hub is not one of
 * them: it used to be read anyway, which both broke "no fallbacks" and made the launch line
 * say `prompt` for a key that came off the hub.
 *
 * A key pasted at the prompt is still saved back to agent-hub when it can be — that is a
 * write, not a source, and it is what lets a later unset run find it. When it cannot be
 * saved, it is used for this session only and the user is told so.
 */
export async function resolveBedrockKey(deps: { seams: Seams; agentHub: AgentHub; offline: boolean; source: CredentialSource }): Promise<string> {
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

  if (deps.source !== "agent-hub") {
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
