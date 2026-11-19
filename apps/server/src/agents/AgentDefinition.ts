import { AgentDefinition, AgentDelegation, DEFAULT_AGENT_DELEGATION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
// @effect-diagnostics nodeBuiltinImport:off - definitions live in user-selected directories, not the server's Effect filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { isMap, isScalar, isSeq, parseAllDocuments, type Document } from "yaml";

import { AgentRegistryError } from "./AgentRegistry.ts";

export const MAX_AGENT_DEFINITION_BYTES = 256 * 1024;
export const MAX_AGENT_FILES_PER_SCOPE = 100;

export interface AgentValidationIssue {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
}

export interface AgentDecodeResult {
  readonly definition?: AgentDefinition;
  readonly issues: ReadonlyArray<AgentValidationIssue>;
}

const AgentDelegationInput = Schema.Struct({
  enabled: Schema.optional(AgentDelegation.fields.enabled),
  allowedAgents: AgentDelegation.fields.allowedAgents,
  maxDepth: Schema.optional(AgentDelegation.fields.maxDepth),
  maxParallel: Schema.optional(AgentDelegation.fields.maxParallel),
  defaultIsolation: Schema.optional(AgentDelegation.fields.defaultIsolation),
  defaultMode: Schema.optional(AgentDelegation.fields.defaultMode),
});

const AgentDefinitionInput = Schema.Struct({
  ...AgentDefinition.fields,
  delegation: Schema.optional(AgentDelegationInput),
});

const decodeAgentDefinitionInput = Schema.decodeUnknownResult(AgentDefinitionInput, {
  onExcessProperty: "error",
});

const formatFieldPath = (path: ReadonlyArray<PropertyKey>): string => {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
    } else {
      formatted = formatted.length === 0 ? String(segment) : `${formatted}.${String(segment)}`;
    }
  }
  return formatted;
};

const offsetToLineColumn = (
  contents: string,
  offset: number,
): { readonly line: number; readonly column: number } => {
  const before = contents.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - lastBreak,
  };
};

const nodeRangeStart = (node: unknown): number | undefined => {
  if (typeof node !== "object" || node === null || !("range" in node)) return undefined;
  const range = (node as { readonly range?: ReadonlyArray<number> }).range;
  return range?.[0];
};

const locatePath = (
  contents: string,
  document: Document.Parsed,
  path: ReadonlyArray<PropertyKey>,
): { readonly line: number; readonly column: number } | undefined => {
  let node: unknown = document.contents;
  let keyStart: number | undefined;
  for (const segment of path) {
    if (isMap(node)) {
      const pair = node.items.find(
        (item) => isScalar(item.key) && String(item.key.value) === String(segment),
      );
      if (pair === undefined) return undefined;
      keyStart = nodeRangeStart(pair.key);
      node = pair.value;
    } else if (isSeq(node)) {
      const index = typeof segment === "number" ? segment : Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.items.length) return undefined;
      keyStart = undefined;
      node = node.items[index];
    } else {
      return undefined;
    }
  }
  const offset = keyStart ?? nodeRangeStart(node);
  return offset === undefined ? undefined : offsetToLineColumn(contents, offset);
};

const yamlErrorMessage = (error: { readonly message: string }): string => error.message;

const issuesFromSchemaError = (
  path: string,
  contents: string,
  document: Document.Parsed,
  error: Schema.SchemaError,
): ReadonlyArray<AgentValidationIssue> => {
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue);
  return formatted.issues.map((issue) => {
    const issuePath = (issue.path ?? []).map((segment): PropertyKey =>
      typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment,
    );
    const fieldPath = formatFieldPath(issuePath);
    const position = locatePath(contents, document, issuePath);
    return {
      path,
      ...(position === undefined ? {} : { line: position.line, column: position.column }),
      message: fieldPath.length === 0 ? issue.message : `${fieldPath}: ${issue.message}`,
    };
  });
};

const normalizeDelegation = (
  input: typeof AgentDelegationInput.Type | undefined,
): AgentDelegation => ({
  enabled: input?.enabled ?? DEFAULT_AGENT_DELEGATION.enabled,
  ...(input?.allowedAgents === undefined ? {} : { allowedAgents: input.allowedAgents }),
  maxDepth: input?.maxDepth ?? DEFAULT_AGENT_DELEGATION.maxDepth,
  maxParallel: input?.maxParallel ?? DEFAULT_AGENT_DELEGATION.maxParallel,
  defaultIsolation: input?.defaultIsolation ?? DEFAULT_AGENT_DELEGATION.defaultIsolation,
  defaultMode: input?.defaultMode ?? DEFAULT_AGENT_DELEGATION.defaultMode,
});

/** Decodes one YAML file without touching the filesystem. Callers supply the display path. */
export function decodeAgentDefinition(input: {
  readonly path: string;
  readonly contents: string;
}): AgentDecodeResult {
  const byteLength = new TextEncoder().encode(input.contents).byteLength;
  if (byteLength > MAX_AGENT_DEFINITION_BYTES) {
    return {
      issues: [
        {
          path: input.path,
          message: `The file is ${byteLength} bytes; the limit is ${MAX_AGENT_DEFINITION_BYTES} bytes (256 KiB).`,
        },
      ],
    };
  }

  let documents: ReadonlyArray<Document.Parsed>;
  try {
    documents = parseAllDocuments(input.contents, { prettyErrors: true, uniqueKeys: true });
  } catch (cause) {
    return {
      issues: [
        {
          path: input.path,
          message: `The YAML could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
    };
  }

  if (documents.length !== 1) {
    const second = documents[1];
    const offset = second?.range?.[0];
    const position = offset === undefined ? undefined : offsetToLineColumn(input.contents, offset);
    return {
      issues: [
        {
          path: input.path,
          ...(position === undefined ? {} : { line: position.line, column: position.column }),
          message: `A file must contain exactly one YAML document; found ${documents.length}.`,
        },
      ],
    };
  }

  const document = documents[0]!;
  if (document.errors.length > 0) {
    return {
      issues: document.errors.map((error) => {
        const position = error.linePos?.[0];
        return {
          path: input.path,
          ...(position === undefined ? {} : { line: position.line, column: position.col }),
          message: yamlErrorMessage(error),
        };
      }),
    };
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (cause) {
    return {
      issues: [
        {
          path: input.path,
          message: `The YAML could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
    };
  }

  const decoded = decodeAgentDefinitionInput(value);
  if (Result.isFailure(decoded)) {
    return {
      issues: issuesFromSchemaError(input.path, input.contents, document, decoded.failure),
    };
  }

  const definition = decoded.success;
  const issues: Array<AgentValidationIssue> = [];
  const provider = definition.provider;
  if (
    provider?.instance !== undefined &&
    provider.driver !== undefined &&
    String(provider.instance) !== String(provider.driver)
  ) {
    const position = locatePath(input.contents, document, ["provider", "driver"]);
    issues.push({
      path: input.path,
      ...(position === undefined ? {} : { line: position.line, column: position.column }),
      message: `provider.driver "${provider.driver}" does not match provider.instance "${provider.instance}".`,
    });
  }
  if (definition.id.includes("..")) {
    const position = locatePath(input.contents, document, ["id"]);
    issues.push({
      path: input.path,
      ...(position === undefined ? {} : { line: position.line, column: position.column }),
      message: "id: must not contain consecutive dots.",
    });
  }
  if (issues.length > 0) {
    return { issues };
  }

  return {
    definition: {
      ...definition,
      delegation: normalizeDelegation(definition.delegation),
    },
    issues: [],
  };
}

export const decodeAgentDefinitionYaml = Effect.fn("AgentDefinition.decodeYaml")(function* (input: {
  readonly path: string;
  readonly contents: string;
}) {
  const result = decodeAgentDefinition(input);
  if (result.definition === undefined) {
    return yield* new AgentRegistryError({
      path: input.path,
      reason: "invalid",
      cause: { issues: result.issues },
    });
  }
  return result.definition;
});

const isYamlFile = (filePath: string): boolean => {
  const extension = NodePath.extname(filePath).toLowerCase();
  return extension === ".yaml" || extension === ".yml";
};

const isNotFound = (cause: unknown): boolean => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

type IoResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly cause: unknown };

const attempt = async <A>(operation: () => Promise<A>): Promise<IoResult<A>> => {
  try {
    return { ok: true, value: await operation() };
  } catch (cause) {
    return { ok: false, cause };
  }
};

export const listAgentDefinitionFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const files: Array<string> = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch (cause) {
      if (isNotFound(cause)) return;
      throw cause;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && isYamlFile(entry.name)) {
        files.push(entryPath);
      }
    }
  };
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right));
};

interface ValidationScope {
  readonly root: string;
  readonly files: ReadonlyArray<string>;
}

const duplicateIdIssues = (
  definitions: ReadonlyArray<{ readonly path: string; readonly id: string }>,
): ReadonlyArray<AgentValidationIssue> => {
  const firstPathById = new Map<string, string>();
  const issues: Array<AgentValidationIssue> = [];
  for (const definition of definitions) {
    const firstPath = firstPathById.get(definition.id);
    if (firstPath === undefined) {
      firstPathById.set(definition.id, definition.path);
      continue;
    }
    issues.push({
      path: definition.path,
      message: `Duplicate agent id "${definition.id}" in this scope; it is also defined in ${firstPath}.`,
    });
  }
  return issues;
};

/** Strict whole-scope validation. Every issue is collected instead of stopping at the first file. */
export const validateAgentPaths = Effect.fn("AgentDefinition.validatePaths")(function* (
  paths: ReadonlyArray<string>,
) {
  const scopes: Array<ValidationScope> = [];
  const issues: Array<AgentValidationIssue> = [];

  for (const inputPath of paths) {
    const absolutePath = NodePath.resolve(inputPath);
    const stat = yield* Effect.promise(() => attempt(() => NodeFSP.stat(absolutePath)));
    if (!stat.ok) {
      issues.push({
        path: absolutePath,
        message: isNotFound(stat.cause)
          ? "The path does not exist."
          : `The path could not be read: ${stat.cause instanceof Error ? stat.cause.message : String(stat.cause)}`,
      });
      continue;
    }
    const stats = stat.value;

    if (stats.isDirectory()) {
      const listing = yield* Effect.promise(() =>
        attempt(() => listAgentDefinitionFiles(absolutePath)),
      );
      if (!listing.ok) {
        issues.push({
          path: absolutePath,
          message: `The directory could not be read: ${listing.cause instanceof Error ? listing.cause.message : String(listing.cause)}`,
        });
        continue;
      }
      const files = listing.value;
      if (files.length > MAX_AGENT_FILES_PER_SCOPE) {
        issues.push({
          path: absolutePath,
          message: `The directory holds ${files.length} YAML files; the limit is ${MAX_AGENT_FILES_PER_SCOPE}.`,
        });
      }
      scopes.push({ root: absolutePath, files });
    } else if (stats.isFile() && isYamlFile(absolutePath)) {
      scopes.push({ root: NodePath.dirname(absolutePath), files: [absolutePath] });
    }
  }

  let fileCount = 0;
  const decodedByScope = new Map<string, Array<{ readonly path: string; readonly id: string }>>();

  for (const scope of scopes) {
    const decoded = decodedByScope.get(scope.root) ?? [];
    for (const filePath of scope.files) {
      fileCount += 1;
      const read = yield* Effect.promise(() => attempt(() => NodeFSP.readFile(filePath, "utf8")));
      if (!read.ok) {
        issues.push({
          path: filePath,
          message: `The file could not be read: ${read.cause instanceof Error ? read.cause.message : String(read.cause)}`,
        });
        continue;
      }
      const result = decodeAgentDefinition({ path: filePath, contents: read.value });
      issues.push(...result.issues);
      if (result.definition !== undefined) {
        decoded.push({ path: filePath, id: result.definition.id });
      }
    }
    decodedByScope.set(scope.root, decoded);
  }

  for (const decoded of decodedByScope.values()) {
    issues.push(...duplicateIdIssues(decoded));
  }

  return { issues, fileCount };
});
