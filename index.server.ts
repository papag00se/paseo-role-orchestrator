import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getCompletionGateSettings, installCompletionGate, saveCompletionGateSettings } from "./server/completion-gate";
import { addRole, editRole, getRoles, removeRole } from "./server/roles";
import { installRoleTools } from "./server/role-tools";
import { createRole, deleteRole, getCompletionGateSettings as getCompletionGateSettingsRpc, launchRoleRpc, listRoles, saveCompletionGateSettings as saveCompletionGateSettingsRpc, updateRole } from "./shared/roles";

export default function contribute(server: PluginServerContext) {
  server.handle(listRoles, getRoles);
  server.handle(createRole, addRole);
  server.handle(updateRole, editRole);
  server.handle(deleteRole, removeRole);
  server.handle(getCompletionGateSettingsRpc, getCompletionGateSettings);
  server.handle(saveCompletionGateSettingsRpc, saveCompletionGateSettings);

  // Every launch path routes through one runtime so a role run is identical however it started.
  const tools = installRoleTools();
  server.handle(launchRoleRpc, async (input, context) => {
    const result = await (await tools).launch(context.paseo, input);
    return { agentId: result.agentId, roleId: result.role.id, roleName: result.role.name };
  });

  // The agent-facing MCP tools need a daemon connection, and a reload leaves them without one
  // until some hook or RPC hands us it. Any lifecycle event is enough to reconnect.
  const removeConnectors = (["agent.created", "agent.turn_started", "agent.turn_ended", "agent.archived"] as const).map((name) =>
    server.on(name, async (_event, { paseo }) => (await tools).connect(paseo)),
  );

  // The completion gate judges every finished turn of a gate-enabled role; a yielded or
  // progress-only turn is sent back to work instead of being accepted as completion.
  const removeCompletionGate = installCompletionGate(server);
  return () => {
    removeCompletionGate();
    removeConnectors.forEach((remove) => remove());
    void tools.then((runtime) => runtime.close()).catch(() => undefined);
  };
}
