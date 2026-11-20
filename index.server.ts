import type { PluginServerContext } from "@getpaseo/plugin/server";
import { addRole, editRole, getRoles, publishJukeProfiles, removeRole } from "./server/roles";
import { installPeriodicPrompts } from "./server/periodic-prompts";
import { installCompactionReread } from "./server/compaction-reread";
import { installChildPolicy } from "./server/child-policy";
import { installRoleTools } from "./server/role-tools";
import { ManualLaunchSummary } from "./server/role-launch";
import { installLoopControl, setByUser } from "./server/loop-control";
import { setAgentLoopPaused } from "./shared/loop-pause";
import { createRole, deleteRole, getCompletionJudge as getCompletionJudgeRpc, launchRoleRpc, listRoles, saveCompletionJudge as saveCompletionJudgeRpc, updateRole } from "./shared/roles";
import { getCompletionJudge, saveCompletionJudge } from "./server/completion-judge";

export default function contribute(server: PluginServerContext) {
  const periodic = installPeriodicPrompts();
  server.handle(listRoles, (_input, context) => { periodic.connect(context.paseo); return getRoles(); });
  server.handle(createRole, addRole);
  server.handle(updateRole, editRole);
  server.handle(deleteRole, removeRole);
  // Completion checking for gated roles is done by Juke's strict profile, with this plugin's judge.
  server.handle(getCompletionJudgeRpc, getCompletionJudge);
  server.handle(saveCompletionJudgeRpc, async (input) => {
    const saved = await saveCompletionJudge(input);
    await publishJukeProfiles();
    return saved;
  });
  void publishJukeProfiles().catch((error) => console.error("Could not publish Juke profiles", error));

  server.handle(setAgentLoopPaused, ({ agentId, paused }, context) => setByUser(context.paseo, agentId, paused));

  // Every launch path routes through one runtime so a role run is identical however it started.
  const tools = installRoleTools();
  server.handle(launchRoleRpc, async (input, context) => {
    periodic.connect(context.paseo);
    // This is the panel path: nobody is in a tool call to write a summary, and the child starts on
    // its own task. A role set to Summary context gets an explicit placeholder instead of failing.
    const result = await (await tools).launch(context.paseo, {
      ...input,
      ...(input.parent ? { contextSummary: ManualLaunchSummary } : {}),
    });
    return { agentId: result.agentId, roleId: result.role.id, roleName: result.role.name };
  });

  // The agent-facing MCP tools need a daemon connection, and a reload leaves them without one
  // until some hook or RPC hands us it. Any lifecycle event is enough to reconnect.
  // Newer daemons hand the plugin its own connection at load (`server.paseo`; absent from the 0.14
  // typings), so the periodic prompts and role tools work straight after a reload or daemon start.
  // Without it, the first lifecycle event or RPC below connects them instead.
  const loadTimeApi = (server as { paseo?: Parameters<typeof periodic.connect>[0] }).paseo;
  if (loadTimeApi) {
    periodic.connect(loadTimeApi);
    void tools.then((runtime) => runtime.connect(loadTimeApi));
  }
  const removeConnectors = (["agent.created", "agent.turn_started", "agent.turn_ended", "agent.archived"] as const).map((name) =>
    server.on(name, async (_event, { paseo }) => { periodic.connect(paseo); (await tools).connect(paseo); }),
  );

  const removeChildPolicy = installChildPolicy(server, tools);
  const removeLoopControl = installLoopControl(server, tools);

  const removeCompactionReread = installCompactionReread(server);
  return () => {
    periodic.close();
    removeChildPolicy();
    removeLoopControl();
    removeCompactionReread();
    removeConnectors.forEach((remove) => remove());
    void tools.then((runtime) => runtime.close()).catch(() => undefined);
  };
}
