import {
  AuthPersonalGuestScopes,
  ORCHESTRATION_V2_WS_METHODS,
  PERSONAL_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { personalGuestMayCallRpc, personalGuestMayDispatch } from "./personalGuestPolicy.ts";

describe("personal guest scopes", () => {
  it("grants only orchestration and read-only filesystem access", () => {
    expect(AuthPersonalGuestScopes).toEqual([
      "orchestration:read",
      "orchestration:operate",
      "filesystem:read",
    ]);
  });
});

describe("personal guest RPC allowlist", () => {
  it("allows every orchestration method, since dispatch commands are guarded separately", () => {
    for (const method of Object.values(ORCHESTRATION_V2_WS_METHODS)) {
      expect(personalGuestMayCallRpc(method)).toBe(true);
    }
  });

  it("allows reading projects, files, diffs, assets, and pull requests", () => {
    for (const method of [
      WS_METHODS.projectsListEntries,
      WS_METHODS.projectsReadFile,
      WS_METHODS.projectsSearchContents,
      WS_METHODS.filesystemBrowse,
      WS_METHODS.filesystemGetMetadata,
      WS_METHODS.reviewGetDiffPreview,
      WS_METHODS.assetsCreateUrl,
      WS_METHODS.attachmentsCreateUploadUrl,
      WS_METHODS.secretsAnswerRequest,
      WS_METHODS.pullRequestsDetail,
      WS_METHODS.subscribeWorktreeSetup,
      PERSONAL_WS_METHODS.guestRoutes,
    ]) {
      expect(personalGuestMayCallRpc(method)).toBe(true);
    }
  });

  it("denies administration, terminals, previews, devices, project lifecycle, and Git writes", () => {
    for (const method of [
      WS_METHODS.serverUpdateSettings,
      WS_METHODS.serverUpdateProvider,
      WS_METHODS.serverUpdateServer,
      WS_METHODS.subscribeAuthAccess,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.previewOpen,
      WS_METHODS.deviceOpen,
      WS_METHODS.projectsMutate,
      WS_METHODS.projectsCreateNew,
      WS_METHODS.projectsWriteFile,
      WS_METHODS.shellOpenInEditor,
      WS_METHODS.scheduledTasksSubscribe,
      WS_METHODS.cloudInstallRelayClient,
      WS_METHODS.serverGetTraceDiagnostics,
      WS_METHODS.agentSessionsImport,
      WS_METHODS.mcpAppsCallTool,
    ]) {
      expect(personalGuestMayCallRpc(method)).toBe(false);
    }
  });

  it("denies methods it has never heard of", () => {
    expect(personalGuestMayCallRpc("server.somethingNew")).toBe(false);
    expect(personalGuestMayCallRpc("personal.startSharing")).toBe(false);
    expect(personalGuestMayCallRpc("personal.rotateSharingKey")).toBe(false);
    expect(personalGuestMayCallRpc("personal.listRelays")).toBe(false);
    expect(personalGuestMayCallRpc("personal.saveRelay")).toBe(false);
    expect(personalGuestMayCallRpc("personal.forgetRelay")).toBe(false);
  });
});

describe("personal guest command allowlist", () => {
  it("allows driving threads, messages, runs, queues, interactions, and forks", () => {
    for (const command of [
      "thread.create",
      "thread.stop",
      "thread.fork",
      "thread.archive",
      "thread.unarchive",
      "thread.settle",
      "thread.unsettle",
      "thread.snooze",
      "thread.unsnooze",
      "thread.runtime-mode.set",
      "message.dispatch",
      "run.interrupt",
      "queued-run.start",
      "runtime-request.respond",
      "thread.user-input.dismiss",
    ]) {
      expect(personalGuestMayDispatch(command)).toBe(true);
    }
  });

  it("denies thread deletion, project adoption, Git and pull-request writes, and rollbacks", () => {
    for (const command of [
      "thread.delete",
      "thread.merge_back",
      "thread.project.adopt-folder",
      "thread.pull-request.link",
      "thread.pull-request.unlink",
      "checkpoint.rollback",
      "provider.switch",
      "thread.auto-settle.set",
      "thread.created.record",
    ]) {
      expect(personalGuestMayDispatch(command)).toBe(false);
    }
  });
});
