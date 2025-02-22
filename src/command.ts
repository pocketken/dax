import { CommandHandler } from "./command_handler.ts";
import { cdCommand } from "./commands/cd.ts";
import { echoCommand } from "./commands/echo.ts";
import { exitCommand } from "./commands/exit.ts";
import { exportCommand } from "./commands/export.ts";
import { sleepCommand } from "./commands/sleep.ts";
import { testCommand } from "./commands/test.ts";
import { delayToMs } from "./common.ts";
import { Delay } from "./common.ts";
import { Buffer, path } from "./deps.ts";
import {
  CapturingBufferWriter,
  NullPipeWriter,
  ShellPipeReader,
  ShellPipeWriter,
  ShellPipeWriterKind,
} from "./pipes.ts";
import { parseArgs, spawn } from "./shell.ts";

type BufferStdio = "inherit" | "null" | Buffer;

interface CommandBuilderState {
  command: string | undefined;
  stdin: ShellPipeReader;
  stdoutKind: ShellPipeWriterKind;
  stderrKind: ShellPipeWriterKind;
  noThrow: boolean;
  env: Record<string, string>;
  commands: Record<string, CommandHandler>;
  cwd: string;
  exportEnv: boolean;
  timeout: number | undefined;
}

const textDecoder = new TextDecoder();

const builtInCommands = {
  cd: cdCommand,
  echo: echoCommand,
  exit: exitCommand,
  export: exportCommand,
  sleep: sleepCommand,
  test: testCommand,
};

/**
 * The underlying builder API for executing commands.
 *
 * This is what `$` uses to execute commands. Using this provides
 * a way to provide a raw text command or an array of arguments.
 *
 * Command builders are immutable where each method call creates
 * a new command builder.
 *
 * ```ts
 * const builder = new CommandBuilder()
 *  .cwd("./src")
 *  .command("echo $MY_VAR");
 *
 * // outputs 5
 * console.log(await builder.env("MY_VAR", "5").text());
 * // outputs 6
 * console.log(await builder.env("MY_VAR", "6").text());
 * ```
 */
export class CommandBuilder implements PromiseLike<CommandResult> {
  #state: Readonly<CommandBuilderState> | undefined;

  #getClonedState(): CommandBuilderState {
    const state = this.#state;
    if (state == null) {
      return this.#getDefaultState();
    }
    return {
      // be explicit here in order to evaluate each property on a case by case basis
      command: state.command,
      stdin: state.stdin,
      stdoutKind: state.stdoutKind,
      stderrKind: state.stderrKind,
      noThrow: state.noThrow,
      env: { ...state.env },
      cwd: state.cwd,
      commands: { ...state.commands },
      exportEnv: state.exportEnv,
      timeout: state.timeout,
    };
  }

  #getDefaultState(): CommandBuilderState {
    return {
      command: undefined,
      stdin: "inherit",
      stdoutKind: "default",
      stderrKind: "default",
      noThrow: false,
      env: Deno.env.toObject(),
      cwd: Deno.cwd(),
      commands: { ...builtInCommands },
      exportEnv: false,
      timeout: undefined,
    };
  }

  #newWithState(action: (state: CommandBuilderState) => void): CommandBuilder {
    const builder = new CommandBuilder();
    const state = this.#getClonedState();
    action(state);
    builder.#state = state;
    return builder;
  }

  then<TResult1 = CommandResult, TResult2 = never>(
    onfulfilled?: ((value: CommandResult) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this.spawn().then(onfulfilled).catch(onrejected);
  }

  /**
   * Explicit way to spawn a command.
   *
   * This is an alias for awaiting the command builder or calling `.then(...)`
   */
  spawn(): Promise<CommandResult> {
    // store a snapshot of the current command
    // in case someone wants to spawn multiple
    // commands with different state
    return parseAndSpawnCommand(this.#getClonedState());
  }

  /**
   * Register a command.
   */
  registerCommand(command: string, handleFn: CommandHandler) {
    validateCommandName(command);
    return this.#newWithState(state => {
      state.commands[command] = handleFn;
    });
  }

  /**
   * Register multilple commands.
   */
  registerCommands(commands: Record<string, CommandHandler>) {
    let command: CommandBuilder = this;
    for (const [key, value] of Object.entries(commands)) {
      command = command.registerCommand(key, value);
    }
    return command;
  }

  /**
   * Unregister a command.
   */
  unregisterCommand(command: string) {
    return this.#newWithState(state => {
      delete state.commands[command];
    });
  }

  /** Sets the raw command to execute. */
  command(command: string | string[]) {
    return this.#newWithState(state => {
      if (typeof command === "string") {
        state.command = command;
      } else {
        state.command = command.map(escapeArg).join(" ");
      }
    });
  }

  /** The command should not throw when it fails or times out. */
  noThrow(value = true) {
    return this.#newWithState(state => {
      state.noThrow = value;
    });
  }

  /** Sets the stdin to use for the command. */
  stdin(reader: ShellPipeReader | string | Uint8Array) {
    return this.#newWithState(state => {
      if (typeof reader === "string") {
        // todo: support cloning these buffers so that
        // the state is immutable when creating a new
        // builder... this is a bug
        state.stdin = new Buffer(new TextEncoder().encode(reader));
      } else if (reader instanceof Uint8Array) {
        state.stdin = new Buffer(reader);
      } else {
        state.stdin = reader;
      }
    });
  }

  /** Set the stdout kind. */
  stdout(kind: ShellPipeWriterKind) {
    return this.#newWithState(state => {
      state.stdoutKind = kind;
    });
  }

  /** Set the stderr kind. */
  stderr(kind: ShellPipeWriterKind) {
    return this.#newWithState(state => {
      state.stderrKind = kind;
    });
  }

  /** Sets multiple environment variables to use at the same time via an object literal. */
  env(items: Record<string, string | undefined>): CommandBuilder;
  /** Sets a single environment variable to use. */
  env(name: string, value: string | undefined): CommandBuilder;
  env(nameOrItems: string | Record<string, string | undefined>, value?: string) {
    return this.#newWithState(state => {
      if (typeof nameOrItems === "string") {
        setEnv(state, nameOrItems, value);
      } else {
        for (const [key, value] of Object.entries(nameOrItems)) {
          setEnv(state, key, value);
        }
      }
    });

    function setEnv(state: CommandBuilderState, key: string, value: string | undefined) {
      if (Deno.build.os === "windows") {
        key = key.toUpperCase();
      }
      if (value == null) {
        delete state.env[key];
      } else {
        state.env[key] = value;
      }
    }
  }

  /** Sets the current working directory to use when executing this command. */
  cwd(dirPath: string) {
    return this.#newWithState(state => {
      state.cwd = path.resolve(dirPath);
    });
  }

  /**
   * Exports the environment of the command to the executing process.
   *
   * So for example, changing the directory in a command or exporting
   * an environment variable will actually change the environment
   * of the executing process.
   *
   * ```ts
   * await $`cd src && export SOME_VALUE=5`;
   * console.log(Deno.env.get("SOME_VALUE")); // 5
   * console.log(Deno.cwd()); // will be in the src directory
   * ```
   */
  exportEnv(value = true) {
    return this.#newWithState(state => {
      state.exportEnv = value;
    });
  }

  /**
   * Ensures stdout and stderr are piped if they have the default behaviour or are inherited.
   *
   * ```ts
   * // ensure both stdout and stderr is not logged to the console
   * await $`echo 1`.quiet();
   * // ensure stdout is not logged to the console
   * await $`echo 1`.quiet("stdout");
   * // ensure stderr is not logged to the console
   * await $`echo 1`.quiet("stderr");
   * ```
   */
  quiet(kind: "stdout" | "stderr" | "both" = "both") {
    return this.#newWithState(state => {
      if (kind === "both" || kind === "stdout") {
        state.stdoutKind = getQuietKind(state.stdoutKind);
      }
      if (kind === "both" || kind === "stderr") {
        state.stderrKind = getQuietKind(state.stderrKind);
      }
    });

    function getQuietKind(kind: ShellPipeWriterKind): ShellPipeWriterKind {
      switch (kind) {
        case "default":
        case "inherit":
          return "piped";
        case "null":
        case "piped":
          return kind;
        default:
          const _assertNever: never = kind;
          throw new Error(`Unhandled kind ${kind}.`);
      }
    }
  }

  /**
   * Specifies a timeout for the command. The command will exit with
   * exit code `124` (timeout) if it times out.
   *
   * Note that when using `.noThrow()` this won't cause an error to
   * be thrown when timing out.
   */
  timeout(delay: Delay) {
    return this.#newWithState(state => {
      state.timeout = delayToMs(delay);
    });
  }

  /**
   * Sets stdout as quiet, spawns the command, and gets stdout as a Uint8Array.
   *
   * Shorthand for:
   *
   * ```ts
   * const data = (await $`command`.quiet("stdout")).stdoutBytes;
   * ```
   */
  async bytes() {
    return (await this.quiet("stdout")).stdoutBytes;
  }

  /**
   * Sets stdout as quiet, spawns the command, and gets stdout as a string without the last newline.
   *
   * Shorthand for:
   *
   * ```ts
   * const data = (await $`command`.quiet("stdout")).stdout.replace(/\r?\n$/, "");
   * ```
   */
  async text() {
    return (await this.quiet("stdout")).stdout.replace(/\r?\n$/, "");
  }

  /** Gets the text as an array of lines. */
  async lines() {
    const text = await this.text();
    return text.split(/\r?\n/g);
  }

  /**
   * Sets stdout as quiet, spawns the command, and gets stdout as JSON.
   *
   * Shorthand for:
   *
   * ```ts
   * const data = (await $`command`.quiet("stdout")).stdoutJson;
   * ```
   */
  async json<TResult = any>(): Promise<TResult> {
    return (await this.quiet("stdout")).stdoutJson;
  }
}

export async function parseAndSpawnCommand(state: CommandBuilderState) {
  if (state.command == null) {
    throw new Error("A command must be set before it can be spawned.");
  }

  const stdoutBuffer = state.stdoutKind === "default"
    ? new CapturingBufferWriter(Deno.stderr, new Buffer())
    : state.stdoutKind === "null"
    ? "null"
    : state.stdoutKind === "inherit"
    ? "inherit"
    : new Buffer();
  const stdout = new ShellPipeWriter(
    state.stdoutKind,
    stdoutBuffer === "null"
      ? new NullPipeWriter()
      : stdoutBuffer === "inherit"
      ? Deno.stdout
      : stdoutBuffer,
  );
  const stderrBuffer = state.stderrKind === "default"
    ? new CapturingBufferWriter(Deno.stderr, new Buffer())
    : state.stderrKind === "null"
    ? "null"
    : state.stderrKind === "inherit"
    ? "inherit"
    : new Buffer();
  const stderr = new ShellPipeWriter(
    state.stderrKind,
    stderrBuffer === "null"
      ? new NullPipeWriter()
      : stderrBuffer === "inherit"
      ? Deno.stderr
      : stderrBuffer,
  );

  const abortController = new AbortController();
  let timeoutId: number | undefined;
  if (state.timeout != null) {
    timeoutId = setTimeout(() => abortController.abort(), state.timeout);
  }

  try {
    const list = await parseArgs(state.command);
    const code = await spawn(list, {
      stdin: state.stdin,
      stdout,
      stderr,
      env: state.env,
      commands: state.commands,
      cwd: state.cwd,
      exportEnv: state.exportEnv,
      signal: abortController.signal,
    });
    if (code !== 0 && !state.noThrow) {
      if (abortController.signal.aborted) {
        throw new Error(`Timed out with exit code: ${code}`);
      } else {
        throw new Error(`Exited with code: ${code}`);
      }
    }
    return new CommandResult(
      code,
      stdoutBuffer instanceof CapturingBufferWriter ? stdoutBuffer.getBuffer() : stdoutBuffer,
      stderrBuffer instanceof CapturingBufferWriter ? stderrBuffer.getBuffer() : stderrBuffer,
    );
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
  }
}

/** Result of running a command. */
export class CommandResult {
  #stdout: BufferStdio;
  #stderr: BufferStdio;
  /** The exit code. */
  readonly code: number;

  constructor(code: number, stdout: BufferStdio, stderr: BufferStdio) {
    this.code = code;
    this.#stdout = stdout;
    this.#stderr = stderr;
  }

  #memoizedStdout: string | undefined;

  /** Raw decoded stdout text. */
  get stdout() {
    if (!this.#memoizedStdout) {
      this.#memoizedStdout = textDecoder.decode(this.stdoutBytes);
    }
    return this.#memoizedStdout;
  }

  #memoizedStdoutJson: any | undefined;

  /**
   * Stdout text as JSON.
   *
   * @remarks Will throw if it can't be parsed as JSON.
   */
  get stdoutJson() {
    if (this.#memoizedStdoutJson == null) {
      this.#memoizedStdoutJson = JSON.parse(this.stdout);
    }
    return this.#memoizedStdoutJson;
  }

  /** Raw stdout bytes. */
  get stdoutBytes(): Uint8Array {
    if (typeof this.#stdout === "string") {
      throw new Error(`Stdout was not piped (was ${this.#stdout}). By default stdout is piped.`);
    }
    return this.#stdout.bytes();
  }

  #memoizedStderr: string | undefined;

  /** Raw decoded stdout text. */
  get stderr() {
    if (!this.#memoizedStderr) {
      this.#memoizedStderr = textDecoder.decode(this.stderrBytes);
    }
    return this.#memoizedStderr;
  }

  #memoizedStderrJson: any | undefined;

  /**
   * Stderr text as JSON.
   *
   * @remarks Will throw if it can't be parsed as JSON.
   */
  get stderrJson() {
    if (this.#memoizedStderrJson == null) {
      this.#memoizedStderrJson = JSON.parse(this.stderr);
    }
    return this.#memoizedStderrJson;
  }

  /** Raw stderr bytes. */
  get stderrBytes(): Uint8Array {
    if (typeof this.#stderr === "string") {
      throw new Error(`Stderr was not piped (was ${this.#stderr}). Call .stderr("pipe") on the process.`);
    }
    return this.#stderr.bytes();
  }
}

export function escapeArg(arg: string) {
  // very basic for now
  if (/^[A-Za-z0-9]*$/.test(arg)) {
    return arg;
  } else {
    return `'${arg.replace("'", `'"'"'`)}'`;
  }
}

function validateCommandName(command: string) {
  if (command.match(/^[a-zA-Z0-9-_]+$/) == null) {
    throw new Error("Invalid command name");
  }
}
