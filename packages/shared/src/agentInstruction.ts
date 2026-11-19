import type { AgentId } from "@t3tools/contracts";

/** Opening line of the first-message agent block. Rendered Markdown hides it. */
const AGENT_INSTRUCTION_OPEN_PREFIX = "<!-- t3:agent:";
const AGENT_INSTRUCTION_OPEN_SUFFIX = " -->";
export const AGENT_INSTRUCTION_CLOSE = "<!-- /t3:agent -->";

const OPEN_LINE = /^<!-- t3:agent:([a-z0-9][a-z0-9._-]{0,63}) -->\r?\n/;

const openLine = (agentId: AgentId) =>
  `${AGENT_INSTRUCTION_OPEN_PREFIX}${agentId}${AGENT_INSTRUCTION_OPEN_SUFFIX}`;

/**
 * Wraps the agent prompt and the task in the first-message block. Idempotent:
 * an existing leading block is replaced, so a retry never doubles the prompt.
 */
export function composeAgentInstruction(input: {
  readonly agentId: AgentId;
  readonly prompt: string;
  readonly text: string;
}): string {
  const prompt = input.prompt.trim();
  const task = parseAgentInstruction(input.text).text;
  if (prompt.length === 0) return task;
  return [openLine(input.agentId), prompt, AGENT_INSTRUCTION_CLOSE, task].join("\n");
}

/**
 * Splits a first message into its agent block and the user's task. Display
 * metadata only: never derive permissions or limits from the parsed id.
 */
export function parseAgentInstruction(text: string): {
  readonly agentId: AgentId | null;
  readonly prompt: string | null;
  readonly text: string;
} {
  const open = OPEN_LINE.exec(text);
  if (open === null) return { agentId: null, prompt: null, text };
  const body = text.slice(open[0].length);
  const closeIndex = body.indexOf(AGENT_INSTRUCTION_CLOSE);
  if (closeIndex < 0) return { agentId: null, prompt: null, text };
  const prompt = body.slice(0, closeIndex).replace(/\r?\n$/, "");
  let task = body.slice(closeIndex + AGENT_INSTRUCTION_CLOSE.length);
  if (task.startsWith("\r\n")) task = task.slice(2);
  else if (task.startsWith("\n")) task = task.slice(1);
  return { agentId: open[1] as AgentId, prompt, text: task };
}
