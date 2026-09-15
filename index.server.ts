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

  const removeCompletionGate = installCompletionGate(server);
  return () => {
    removeCompletionGate();
    void tools.then((runtime) => runtime.close()).catch(() => undefined);
  };
}
