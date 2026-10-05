import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CompletionGateSettingsPage, RoleAgentPanel, RoleCatalogSurface, RoleWorkspacePanel } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "roles", title: "Roles and delegation", icon: "Network", Component: RoleCatalogSurface });
  client.addSettingsScreen({ id: "completion-gate", title: "Completion gate", icon: "CheckCheck", Component: CompletionGateSettingsPage });
  client.addCommandCenterItem({ id: "settings", title: "Role Orchestrator settings", icon: "Network", context: "global", onSelect: ({ openSettings }) => openSettings("roles") });
  client.addWorkspacePanel({
    id: "roles-workspace",
    title: "Roles",
    icon: "Network",
    context: "workspace",
    locations: ["workspace"],
    Component: RoleWorkspacePanel,
  });
  client.addWorkspacePanel({
    id: "roles-agent",
    title: "Child roles",
    icon: "GitFork",
    context: "agent",
    locations: ["workspace"],
    Component: RoleAgentPanel,
  });
  return () => {};
}
