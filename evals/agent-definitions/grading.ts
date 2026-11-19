/** One model run's observable output, as the eval reads it from a transcript. */
export interface AgentCaseOutput {
  /** Agent ids the run dispatched through delegate_task, create_threads, or t3_thread_launch. */
  readonly delegatedAgentIds: ReadonlyArray<string>;
  /** Files the run edited, relative to the project root. */
  readonly editedFiles: ReadonlyArray<string>;
  /** Provider/model pairs the run chose for its children, such as "claude-code:sonnet". */
  readonly delegatedProviders: ReadonlyArray<string>;
  /** URLs or file:line citations in the final answer. */
  readonly citations: ReadonlyArray<string>;
  /** How many independent research tasks the run dispatched. */
  readonly subQueryCount: number;
  /** Whether the run produced a final report. */
  readonly reported: boolean;
}

/** What a case accepts. Omitted checks are not graded. */
export interface AgentCaseExpectation {
  /** The run delegates at least this many times before it edits anything. */
  readonly delegatesBeforeEditing?: boolean;
  /** The run never edits files. */
  readonly readOnly?: boolean;
  /** Every delegated agent id must be in this list. */
  readonly allowedAgents?: ReadonlyArray<string>;
  /** The run must not delegate at all. */
  readonly noDelegation?: boolean;
  /** Children must not all use one provider. */
  readonly distinctProviders?: boolean;
  /** Minimum citations in the report. */
  readonly minimumCitations?: number;
  /** Inclusive sub-query bounds. */
  readonly subQueries?: { readonly minimum: number; readonly maximum: number };
  /** The run must end with a report. */
  readonly reports?: boolean;
}

export interface AgentCase {
  readonly id: string;
  /** Where the case came from: a persona, an issue, or a thread. */
  readonly source: string;
  readonly agentId: string;
  readonly task: string;
  readonly expect: AgentCaseExpectation;
}

export interface AgentCaseResult {
  readonly pass: boolean;
  readonly failures: ReadonlyArray<string>;
}

/** Structural grader shared by CI and the paid run; it never calls a model. */
export function gradeAgentCase(input: {
  readonly expectation: AgentCaseExpectation;
  readonly output: AgentCaseOutput;
}): AgentCaseResult {
  const { expectation, output } = input;
  const failures: string[] = [];
  const edited = output.editedFiles.length > 0;
  if (expectation.readOnly === true && edited) {
    failures.push(`edited ${output.editedFiles.join(", ")} but the case is read-only.`);
  }
  if (expectation.noDelegation === true && output.delegatedAgentIds.length > 0) {
    failures.push(`delegated to ${output.delegatedAgentIds.join(", ")}.`);
  }
  if (expectation.delegatesBeforeEditing === true && edited) {
    const firstDelegation = output.delegatedAgentIds[0];
    if (firstDelegation === undefined) failures.push("edited files without delegating first.");
  }
  if (expectation.allowedAgents !== undefined) {
    const unexpected = output.delegatedAgentIds.filter(
      (id) => !expectation.allowedAgents?.includes(id),
    );
    if (unexpected.length > 0) failures.push(`delegated to unexpected agents: ${unexpected}.`);
  }
  if (expectation.distinctProviders === true && new Set(output.delegatedProviders).size < 2) {
    failures.push("did not use two distinct providers.");
  }
  if (
    expectation.minimumCitations !== undefined &&
    output.citations.length < expectation.minimumCitations
  ) {
    failures.push(
      `cited ${output.citations.length}, expected at least ${expectation.minimumCitations}.`,
    );
  }
  if (expectation.subQueries !== undefined) {
    const { minimum, maximum } = expectation.subQueries;
    if (output.subQueryCount < minimum || output.subQueryCount > maximum) {
      failures.push(`ran ${output.subQueryCount} sub-queries, expected ${minimum}..${maximum}.`);
    }
  }
  if (expectation.reports === true && !output.reported) failures.push("did not report.");
  return { pass: failures.length === 0, failures };
}
