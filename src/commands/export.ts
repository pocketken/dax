import { CommandContext } from "../command_handler.ts";
import { EnvChange, ExecuteResult } from "../result.ts";

export async function exportCommand(context: CommandContext): Promise<ExecuteResult> {
  const changes: EnvChange[] = [];
  for (const arg of context.args) {
    let equalsIndex = arg.indexOf("=");
    // ignore if it doesn't contain an equals sign
    if (equalsIndex >= 0) {
      changes.push({
        kind: "envvar",
        name: arg.substring(0, equalsIndex),
        value: arg.substring(equalsIndex + 1),
      });
    }
  }
  return {
    kind: "continue",
    code: 0,
    changes,
  };
}
