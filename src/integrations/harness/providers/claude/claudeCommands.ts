import {
  killChild,
  resolveClaudeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
  writeChild,
} from "../../core/child";
import type {
  NativeCommand,
  NativeCommandProvider,
} from "../../core/nativeCommands";
import {
  asRecord,
  buildClaudeSpawnArgs,
  buildControlRequest,
  parseControlResponse,
  parseJsonLine,
} from "./claudeProtocol";

const INIT_REQUEST_ID = "monocode_commands_init";
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Commands MonoCode already owns (its own picker entries, or session state
 * such as the model and thread it tracks), plus CLI internals.
 */
const HIDDEN_COMMANDS = new Set([
  "add-to-folder",
  "btw",
  "compact",
  "draft",
  "mcp",
  "operator",
  "orchestrator",
  "plan",
  "clear",
  "color",
  "config",
  "effort",
  "fast",
  "heapdump",
  "model",
  "rename",
  "workflow-launch-exec",
]);

export const claudeCommandProvider: NativeCommandProvider = {
  monocodeSkills: true,
  discover: ({ cwd, accountId }) => discoverClaudeCommands(cwd, accountId),
};

/** Ask a throwaway CLI in `cwd` for the commands its `initialize` reports. */
export async function discoverClaudeCommands(
  cwd: string,
  accountId?: string,
): Promise<NativeCommand[]> {
  const { path } = await resolveClaudeBinary();
  const childId = `monocode-claude-commands-${crypto.randomUUID()}`;

  let settle: {
    resolve: (commands: NativeCommand[]) => void;
    reject: (error: Error) => void;
  } | null = null;
  const pending = new Promise<NativeCommand[]>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The CLI can exit while spawn or write is still pending; the race below
  // reports that failure, so it must not also surface as unhandled.
  pending.catch(() => undefined);

  watchChild(
    childId,
    (line) => {
      const rec = parseJsonLine(line);
      const response = rec ? parseControlResponse(rec) : null;
      if (response?.requestId !== INIT_REQUEST_ID) return;
      if (!response.ok) {
        settle?.reject(new Error(response.error ?? "initialize failed"));
        return;
      }
      try {
        settle?.resolve(claudeCommandsFromInitialize(response.payload));
      } catch (error) {
        settle?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    () => settle?.reject(new Error("Claude Code command probe exited")),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Same setting sources as a live session so project, user, and plugin
    // commands match, but no hooks, MCP servers, or saved transcript.
    const args = buildClaudeSpawnArgs({
      settings: { disableAllHooks: true },
      includePartialMessages: false,
    });
    args.push(
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
    );
    await spawnChild(
      childId,
      path,
      args,
      cwd,
      { provider: "claude", id: accountId ?? "default" },
      "claude",
    );
    await writeChild(
      childId,
      JSON.stringify(
        buildControlRequest(INIT_REQUEST_ID, { subtype: "initialize" }),
      ),
    );
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude Code command probe timed out")),
          DISCOVERY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    unwatchChild(childId);
    await killChild(childId).catch(() => undefined);
  }
}

export function claudeCommandsFromInitialize(
  payload: Record<string, unknown> | null,
): NativeCommand[] {
  const commands = payload?.commands;
  if (!Array.isArray(commands))
    throw new Error("Claude Code initialize returned no commands array");
  const seen = new Set<string>();
  return commands.flatMap((value): NativeCommand[] => {
    const row = asRecord(value);
    const name = row?.name;
    if (
      typeof name !== "string" ||
      !isCommandName(name) ||
      name.startsWith("__") ||
      HIDDEN_COMMANDS.has(name) ||
      seen.has(name)
    )
      return [];
    seen.add(name);
    const aliases = Array.isArray(row?.aliases)
      ? row.aliases.filter(
          (alias): alias is string =>
            typeof alias === "string" &&
            isCommandName(alias) &&
            !HIDDEN_COMMANDS.has(alias),
        )
      : [];
    const hint = row?.argumentHint;
    return [
      {
        name,
        invocation: name,
        source: "claude",
        description:
          typeof row?.description === "string" ? row.description : "",
        ...(row?.builtin === true ? { origin: "builtin" } : {}),
        ...(aliases.length ? { aliases } : {}),
        ...(typeof hint === "string" && hint ? { inputHint: hint } : {}),
      },
    ];
  });
}

function isCommandName(name: string): boolean {
  return !!name && !/[\s/\\]/.test(name);
}
