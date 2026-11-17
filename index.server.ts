import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getCompletionGateSettings, installCompletionGate, saveCompletionGateSettings } from "./server/completion-gate";
import { addRole, editRole, getRoles, removeRole } from "./server/roles";
import { installPeriodicPrompts } from "./server/periodic-prompts";
import { installCompactionReread } from "./server/compaction-reread";
import { installChildPolicy } from "./server/child-policy";
import { installRoleTools } from "./server/role-tools";
import { installLoopControl, setByUser } from "./server/loop-control";
import { setAgentLoopPaused } from "./shared/loop-pause";
import { createRole, deleteRole, getCompletionGateSettings as getCompletionGateSettingsRpc, launchRoleRpc, listRoles, saveCompletionGateSettings as saveCompletionGateSettingsRpc, updateRole } from "./shared/roles";

export default function contribute(server: PluginServerContext) {
  const periodic = installPeriodicPrompts();
  server.handle(listRoles, (_input, context) => { periodic.connect(context.paseo); return getRoles(); });
  server.handle(createRole, addRole);
  server.handle(updateRole, editRole);
  server.handle(deleteRole, removeRole);
  server.handle(getCompletionGateSettingsRpc, getCompletionGateSettings);
  server.handle(saveCompletionGateSettingsRpc, saveCompletionGateSettings);

  server.handle(setAgentLoopPaused, ({ agentId, paused }, context) => setByUser(context.paseo, agentId, paused));

  // Every launch path routes through one runtime so a role run is identical however it started.
  const tools = installRoleTools();
  server.handle(launchRoleRpc, async (input, context) => {
    periodic.connect(context.paseo);
    const result = await (await tools).launch(context.paseo, input);
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

  // The completion gate judges every finished turn of a gate-enabled role; a yielded or
  // progress-only turn is sent back to work instead of being accepted as completion.
  const removeChildPolicy = installChildPolicy(server, tools);
  const removeLoopControl = installLoopControl(server, tools);

  const removeCompletionGate = installCompletionGate(server);
  const removeCompactionReread = installCompactionReread(server);
  return () => {
    periodic.close();
    removeChildPolicy();
    removeLoopControl();
    removeCompactionReread();
    removeCompletionGate();
    removeConnectors.forEach((remove) => remove());
    void tools.then((runtime) => runtime.close()).catch(() => undefined);
  };
}
