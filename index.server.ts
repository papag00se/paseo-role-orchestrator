import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getCompletionGateSettings, installCompletionGate, saveCompletionGateSettings } from "./server/completion-gate";
import { addRole, editRole, getRoles, removeRole } from "./server/roles";
import { createRole, deleteRole, getCompletionGateSettings as getCompletionGateSettingsRpc, listRoles, saveCompletionGateSettings as saveCompletionGateSettingsRpc, updateRole } from "./shared/roles";

export default function contribute(server: PluginServerContext) {
  server.handle(listRoles, getRoles);
  server.handle(createRole, addRole);
  server.handle(updateRole, editRole);
  server.handle(deleteRole, removeRole);
  server.handle(getCompletionGateSettingsRpc, getCompletionGateSettings);
  server.handle(saveCompletionGateSettingsRpc, saveCompletionGateSettings);
  const removeCompletionGate = installCompletionGate(server);
  return () => removeCompletionGate();
}
