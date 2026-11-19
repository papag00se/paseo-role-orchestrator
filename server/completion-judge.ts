import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CompletionJudgeSchema, type CompletionJudge } from "../shared/roles";

// The former completion gate's settings file, so an existing judge choice carries over.
// Its old `modeId` and `prompt` fields are ignored.
const file = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "role-orchestrator-completion-gate.json");
const defaults: CompletionJudge = { provider: "", model: "", thinkingOptionId: null };

export async function getCompletionJudge(): Promise<CompletionJudge> {
  try {
    const raw = JSON.parse(await readFile(file(), "utf8"));
    return CompletionJudgeSchema.parse({ provider: raw.provider ?? "", model: raw.model ?? "", thinkingOptionId: raw.thinkingOptionId ?? null });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw error;
  }
}

export async function saveCompletionJudge(input: CompletionJudge): Promise<CompletionJudge> {
  const judge = CompletionJudgeSchema.parse(input);
  await mkdir(dirname(file()), { recursive: true });
  const temporary = `${file()}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(judge, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file());
  return judge;
}
