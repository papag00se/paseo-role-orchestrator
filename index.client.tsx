import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RoleAgentPanel, RoleCatalogSurface, RoleWorkspacePanel } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addSurface("roles", RoleCatalogSurface);
  client.addSidebarItem({
    id: "roles",
    title: "Roles",
    icon: "Network",
    surface: "roles",
  });
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
