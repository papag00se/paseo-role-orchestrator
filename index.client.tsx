import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LoopRowSchema, LOOP_ROW_KIND, setAgentLoopPaused } from "./shared/loop-pause";
import { CompletionGateSettingsPage, RoleAgentPanel, RoleCatalogSurface, RoleWorkspacePanel } from "./client/main";
import { LoopStateRow } from "./client/loop-state-row";

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
  // A user pause is hard: only /roles-resume-agent-loop ends it. An agent pauses itself with its pause_loop tool.
  client.addSlashCommand({
    name: "roles-pause-agent-loop",
    description: "Stop this agent's periodic prompts until you resume them",
    argumentHint: "",
    context: "agent",
    onSubmit: ({ agent, rpc }) => rpc(setAgentLoopPaused, { agentId: agent.id, paused: true }).then(() => undefined),
  });
  client.addSlashCommand({
    name: "roles-resume-agent-loop",
    description: "Resume this agent's periodic prompts",
    argumentHint: "",
    context: "agent",
    onSubmit: ({ agent, rpc }) => rpc(setAgentLoopPaused, { agentId: agent.id, paused: false }).then(() => undefined),
  });
  client.addTimelineRenderer({ kind: LOOP_ROW_KIND, version: 1, schema: LoopRowSchema, Component: LoopStateRow });
  return () => {};
}
