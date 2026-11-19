/** One model run's observable output, as the eval reads it from a transcript. */
export interface AgentCaseOutput {
  /** Agent ids the run called delegate_task with, including calls the tool rejected. */
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
  /** Delegations that started a child. Defaults to `delegatedAgentIds` when omitted. */
  readonly completedAgentIds?: ReadonlyArray<string>;
  /** Most delegate_task calls the run issued in one assistant turn. */
  readonly maxSameTurnDispatches?: number;
  /** Whether the first successful delegation came before the first edit. True if it did not edit. */
  readonly delegationPrecededEdits?: boolean;
  /** Whether the run ran the tests and its final report states the result. */
  readonly testEvidence?: boolean;
  /** Successful children in order, with the provider each one started on. */
  readonly delegations?: ReadonlyArray<{
    readonly agentId: string;
    readonly provider: string;
  }>;
}

/** What a case accepts. Omitted checks are not graded. */
export interface AgentCaseExpectation {
  /** The run delegates before it edits anything. */
  readonly delegatesBeforeEditing?: boolean;
  /** The run never edits files. */
  readonly readOnly?: boolean;
  /** The run edits at least one file. */
  readonly editsFiles?: boolean;
  /** Every delegated agent id must be in this list. */
  readonly allowedAgents?: ReadonlyArray<string>;
  /** The run must not delegate at all. */
  readonly noDelegation?: boolean;
  /** Children that started must number at least this many. */
  readonly minimumDelegations?: number;
  /** These two agents must both start, and no provider may run both. */
  readonly differentProviderAgents?: readonly [string, string];
  /** Children must not all use one provider. */
  readonly distinctProviders?: boolean;
  /** At least this many delegate_task calls in one assistant turn. */
  readonly sameTurnDispatches?: number;
  /** Minimum citations in the report. */
  readonly minimumCitations?: number;
  /** Inclusive sub-query bounds. */
  readonly subQueries?: { readonly minimum: number; readonly maximum: number };
  /** The run must run tests and report their result. */
  readonly testEvidence?: boolean;
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
  const completed = output.completedAgentIds ?? output.delegatedAgentIds;
  if (expectation.readOnly === true && edited) {
    failures.push(`edited ${output.editedFiles.join(", ")} but the case is read-only.`);
  }
  if (expectation.noDelegation === true && output.delegatedAgentIds.length > 0) {
    failures.push(`delegated to ${output.delegatedAgentIds.join(", ")}.`);
  }
  if (expectation.delegatesBeforeEditing === true && edited) {
    if (completed.length === 0) {
      failures.push("edited files without delegating first.");
    } else if (output.delegationPrecededEdits === false) {
      failures.push("edited files before delegating.");
    }
  }
  if (expectation.editsFiles === true && !edited) {
    failures.push("did not edit any files.");
  }
  if (expectation.allowedAgents !== undefined) {
    const unexpected = output.delegatedAgentIds.filter(
      (id) => !expectation.allowedAgents?.includes(id),
    );
    if (unexpected.length > 0) failures.push(`delegated to unexpected agents: ${unexpected}.`);
  }
  if (expectation.distinctProviders === true) {
    // A pair is "provider:model", so two models on one provider are still one provider.
    const providers = new Set(
      output.delegatedProviders.map((pair) => {
        const separator = pair.indexOf(":");
        return separator < 0 ? pair : pair.slice(0, separator);
      }),
    );
    if (providers.size < 2) failures.push("did not use two distinct providers.");
  }
  if (
    expectation.minimumDelegations !== undefined &&
    completed.length < expectation.minimumDelegations
  ) {
    failures.push(
      `delegated ${completed.length}, expected at least ${expectation.minimumDelegations}.`,
    );
  }
  if (expectation.differentProviderAgents !== undefined) {
    const [left, right] = expectation.differentProviderAgents;
    const providersFor = (agentId: string) =>
      new Set(
        (output.delegations ?? [])
          .filter((delegation) => delegation.agentId === agentId)
          .map((delegation) => delegation.provider),
      );
    const leftProviders = providersFor(left);
    const rightProviders = providersFor(right);
    if (leftProviders.size === 0 || rightProviders.size === 0) {
      const missing = [
        ...(leftProviders.size === 0 ? [left] : []),
        ...(rightProviders.size === 0 ? [right] : []),
      ];
      failures.push(`did not delegate to ${missing.join(", ")}.`);
    } else if ([...leftProviders].some((provider) => rightProviders.has(provider))) {
      failures.push(`${left} and ${right} used the same provider.`);
    }
  }
  if (
    expectation.sameTurnDispatches !== undefined &&
    (output.maxSameTurnDispatches ?? 0) < expectation.sameTurnDispatches
  ) {
    failures.push(
      `dispatched ${output.maxSameTurnDispatches ?? 0} in one turn, expected at least ${expectation.sameTurnDispatches}.`,
    );
  }
  if (expectation.testEvidence === true && output.testEvidence !== true) {
    failures.push("did not report test evidence.");
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
