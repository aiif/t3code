import {
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type OrchestrationV2Command,
} from "@t3tools/contracts";

/**
 * What a personal-key session may do directly. An allowlist on purpose: a new
 * RPC method stays owner-only until someone decides guests need it.
 */
const PERSONAL_GUEST_RPC_METHODS: ReadonlySet<string> = new Set<string>([
  ...Object.values(ORCHESTRATION_V2_WS_METHODS),

  WS_METHODS.serverProbe,
  WS_METHODS.serverGetConfig,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.serverGetHostResources,
  WS_METHODS.serverReportClientActivity,

  WS_METHODS.projectsListEntries,
  WS_METHODS.projectsListIgnoredFiles,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsSearchContents,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsEnsureScratch,
  WS_METHODS.filesystemBrowse,
  WS_METHODS.filesystemGetMetadata,

  WS_METHODS.reviewGetBranchCommits,
  WS_METHODS.reviewGetDiffPreview,
  WS_METHODS.reviewGetDiffFileContents,

  WS_METHODS.assetsCreateUrl,
  WS_METHODS.assetsPersistChatAttachments,
  WS_METHODS.attachmentsCreateUploadUrl,
  WS_METHODS.attachmentsDelete,
  WS_METHODS.secretsAnswerRequest,

  WS_METHODS.subscribeWorktreeSetup,
  WS_METHODS.worktreeSetupCancel,

  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.subscribeVcsBranch,
  WS_METHODS.vcsRefreshBranch,
  WS_METHODS.vcsRefreshStatus,
  WS_METHODS.vcsListRefs,
  WS_METHODS.gitResolvePullRequest,
  WS_METHODS.sourceControlLookupRepository,
  WS_METHODS.sourceControlAppAccess,
  WS_METHODS.sourceControlStarred,

  WS_METHODS.pullRequestsList,
  WS_METHODS.pullRequestsListStats,
  WS_METHODS.pullRequestsFilterOptions,
  WS_METHODS.pullRequestsSummary,
  WS_METHODS.pullRequestsRouting,
  WS_METHODS.pullRequestsRoutingIdentity,
  WS_METHODS.pullRequestsStack,
  WS_METHODS.pullRequestsLinkedThreads,
  WS_METHODS.pullRequestsDetail,
  WS_METHODS.pullRequestsPreview,
  WS_METHODS.pullRequestsChecks,
  WS_METHODS.pullRequestsActivity,
  WS_METHODS.pullRequestsReviewGuide,
  WS_METHODS.pullRequestsThreadComments,
  WS_METHODS.pullRequestsDiffFileContents,
  WS_METHODS.pullRequestsFilesViewed,
  WS_METHODS.pullRequestsChangeBreakdown,
  WS_METHODS.pullRequestsInvalidate,
  WS_METHODS.pullRequestsReportState,
  WS_METHODS.pullRequestsSubscribeRefreshes,
  WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes,
  WS_METHODS.pullRequestsReviewerCandidates,
  WS_METHODS.pullRequestsLabelCandidates,

  WS_METHODS.subscribeProjectClones,
]);

/**
 * Commands a personal-key session may dispatch. Denied commands change the
 * project or repository directly: thread delete, auto-settle settings, Git
 * merge-back, pull-request links, checkpoint rollback, provider switching, and
 * project adoption are all absent.
 */
const PERSONAL_GUEST_COMMANDS: ReadonlySet<OrchestrationV2Command["type"]> = new Set<
  OrchestrationV2Command["type"]
>([
  "thread.stop",
  "thread.create",
  "thread.archive",
  "thread.unarchive",
  "thread.settle",
  "thread.auto-settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.pin",
  "thread.unpin",
  "thread.tag.set",
  "thread.pin.reorder",
  "thread.active.reorder",
  "thread.visit",
  "thread.mark-unread",
  "thread.metadata.update",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.model-selection.set",
  "message.dispatch",
  "run.interrupt",
  "queued-message.promote-to-steer",
  "queue.resume",
  "queued-run.start",
  "queued-run.reorder",
  "queued-run.cancel",
  "queued-run.edit",
  "runtime-request.respond",
  "thread.user-input.dismiss",
  "thread.fork",
  "subagent.stop",
]);

export function personalGuestMayCallRpc(method: string): boolean {
  return PERSONAL_GUEST_RPC_METHODS.has(method);
}

export function personalGuestMayDispatch(commandType: string): boolean {
  return (PERSONAL_GUEST_COMMANDS as ReadonlySet<string>).has(commandType);
}
