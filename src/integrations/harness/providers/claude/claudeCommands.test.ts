import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  killChild: vi.fn(),
  onLine: undefined as ((line: string) => void) | undefined,
  onExit: undefined as (() => void) | undefined,
  resolveClaudeBinary: vi.fn(),
  spawnChild: vi.fn(),
  unwatchChild: vi.fn(),
  watchChild: vi.fn(),
  writeChild: vi.fn(),
}));

vi.mock("../../core/child", () => ({
  killChild: mocks.killChild,
  resolveClaudeBinary: mocks.resolveClaudeBinary,
  spawnChild: mocks.spawnChild,
  unwatchChild: mocks.unwatchChild,
  watchChild: mocks.watchChild,
  writeChild: mocks.writeChild,
}));

import {
  claudeCommandsFromInitialize,
  discoverClaudeCommands,
} from "./claudeCommands";

function initializeResponse(response: Record<string, unknown>): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "monocode_commands_init",
      response,
    },
  });
}

describe("claudeCommandsFromInitialize", () => {
  it("maps names, aliases, and argument hints", () => {
    expect(
      claudeCommandsFromInitialize({
        commands: [
          {
            name: "code-review",
            description: "Review the current diff",
            argumentHint: "[low|medium|high] [--fix]",
            aliases: ["review"],
            builtin: true,
          },
          { name: "commit", description: "Commit", argumentHint: "" },
        ],
      }),
    ).toEqual([
      {
        name: "code-review",
        invocation: "code-review",
        source: "claude",
        description: "Review the current diff",
        origin: "builtin",
        aliases: ["review"],
        inputHint: "[low|medium|high] [--fix]",
      },
      {
        name: "commit",
        invocation: "commit",
        source: "claude",
        description: "Commit",
      },
    ]);
  });

  it("hides commands MonoCode owns, internals, and duplicates", () => {
    const commands = claudeCommandsFromInitialize({
      commands: [
        { name: "compact" },
        { name: "clear", aliases: ["reset", "new"] },
        { name: "model" },
        { name: "__remote-workflow" },
        { name: "bad name" },
        { name: "init" },
        { name: "init" },
        { name: "usage", aliases: ["cost", "plan", "a b"] },
      ],
    });
    expect(commands.map((command) => command.name)).toEqual(["init", "usage"]);
    expect(commands[1]?.aliases).toEqual(["cost"]);
  });

  it("rejects a payload without commands", () => {
    expect(() => claudeCommandsFromInitialize({})).toThrow(/no commands/);
  });
});

describe("discoverClaudeCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveClaudeBinary.mockResolvedValue({ path: "/bin/claude" });
    mocks.killChild.mockResolvedValue(undefined);
    mocks.spawnChild.mockResolvedValue(undefined);
    mocks.watchChild.mockImplementation(
      (_id: string, onLine: (line: string) => void, onExit: () => void) => {
        mocks.onLine = onLine;
        mocks.onExit = onExit;
      },
    );
  });

  it("initializes a hookless CLI in the project and reads its commands", async () => {
    mocks.writeChild.mockImplementation(async () => {
      mocks.onLine?.(
        initializeResponse({ commands: [{ name: "simplify" }] }),
      );
    });

    await expect(discoverClaudeCommands("/repo")).resolves.toEqual([
      {
        name: "simplify",
        invocation: "simplify",
        source: "claude",
        description: "",
      },
    ]);
    const [, , args, cwd, account] = mocks.spawnChild.mock.calls[0] ?? [];
    expect(cwd).toBe("/repo");
    expect(account).toEqual({ provider: "claude", id: "default" });
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args.join(" ")).toContain('"disableAllHooks":true');
    expect(JSON.parse(mocks.writeChild.mock.calls[0]?.[1])).toMatchObject({
      request: { subtype: "initialize" },
    });
    expect(mocks.killChild).toHaveBeenCalled();
    expect(mocks.unwatchChild).toHaveBeenCalled();
  });

  it("runs the probe under the session's account", async () => {
    mocks.writeChild.mockImplementation(async () => {
      mocks.onLine?.(initializeResponse({ commands: [] }));
    });

    await discoverClaudeCommands("/repo", "work");
    expect(mocks.spawnChild.mock.calls[0]?.[4]).toEqual({
      provider: "claude",
      id: "work",
    });
  });

  it("fails when the CLI exits before answering", async () => {
    mocks.writeChild.mockImplementation(async () => mocks.onExit?.());

    await expect(discoverClaudeCommands("/repo")).rejects.toThrow(/exited/);
    expect(mocks.killChild).toHaveBeenCalled();
  });

  it("leaves no unhandled rejection when the CLI exits before the write fails", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    mocks.writeChild.mockImplementation(async () => {
      mocks.onExit?.();
      throw new Error("pipe closed");
    });

    await expect(discoverClaudeCommands("/repo")).rejects.toThrow(/pipe closed/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
