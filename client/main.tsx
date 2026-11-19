import {
  type PluginAgentPanelProps,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  useAgent,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { buildRoleRunTree, COMPLETION_AGENT_LABEL, fetchRoleAgents, PARENT_AGENT_LABEL, type RoleRunAgent } from "../shared/role-runs";
import {
  createRole,
  deleteRole,
  getCompletionJudge,
  getContextWindow,
  saveCompletionJudge,
  type CompletionJudge,
  launchRoleRpc,
  listRoles,
  ROLE_LABEL,
  providerModel,
  updateRole,
  type Role,
  type RoleDraft,
} from "../shared/roles";

type ParentAgentSession = {
  provider: string;
  model: string | null;
  thinkingOptionId?: string | null;
  currentModeId: string | null;
};

type RoleAgent = {
  id: string;
  workspaceId: string;
  parentAgentId: string | null;
  provider: string;
  model: string | null;
  thinkingOptionId: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  title: string | null;
  labels: Record<string, string>;
  createdAt?: string;
  archivedAt?: string | null;
};

const blankRole = (): RoleDraft => ({
  name: "",
  description: "",
  provider: "",
  model: "",
  thinkingOptionId: null,
  modeId: null,
  systemPrompt: "",
  promptCacheRetention: null,
  compaction: { triggerTokens: null, contextWindowTokens: null },
  rereadAfterCompaction: false,
  periodicPrompt: { enabled: false, minutes: 30, prompt: "" },
  delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false, restrictChildCommunication: false }
});

type ProviderEntry = PaseoProviderSnapshotResult["entries"][number];
type ProviderModel = NonNullable<ProviderEntry["models"]>[number];
type ProviderMode = NonNullable<ProviderEntry["modes"]>[number];
type PickerOption = { id: string; label: string; description?: string };

function useProviderCatalog() {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["role-orchestrator", "provider-catalog"],
    queryFn: async () => (await paseo.providers.snapshot()).entries,
    staleTime: 30_000,
  });
}

function useRoles(hostId: string) {
  const callList = useRpc(listRoles);
  return useQuery({
    queryKey: ["role-orchestrator", hostId, "roles"],
    queryFn: async () => (await callList({})).roles,
  });
}

function useRoleMutations(hostId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const create = useRpc(createRole);
  const update = useRpc(updateRole);
  const remove = useRpc(deleteRole);
  const key = ["role-orchestrator", hostId, "roles"] as const;
  return useMutation({
    mutationFn: async (
      action:
        | { kind: "create"; draft: RoleDraft }
        | { kind: "update"; id: string; draft: RoleDraft }
        | { kind: "delete"; id: string },
    ) => {
      if (action.kind === "create") return create(action.draft);
      if (action.kind === "update") return update({ id: action.id, ...action.draft });
      return remove({ id: action.id });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to save role"),
  });
}

function roleDraft(role: Role): RoleDraft {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = role;
  return draft;
}

function stylesFor(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 14 : 22, gap: 14, maxWidth: 900, width: "100%", alignSelf: "center" },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 22 : 26, fontWeight: "700" },
    subtitle: { color: theme.colors.foregroundMuted, marginTop: 3 },
    card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1, padding: 14, gap: 10 },
    row: { flexDirection: "row", alignItems: "center", gap: 9 },
    grow: { flex: 1, minWidth: 0 },
    name: { color: theme.colors.foreground, fontSize: 16, fontWeight: "700" },
    detail: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 },
    primary: { backgroundColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 7 },
    primaryText: { color: theme.colors.accentForeground, fontWeight: "700" },
    secondary: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 7 },
    secondaryText: { color: theme.colors.foreground, fontWeight: "600" },
    dangerText: { color: theme.colors.statusDanger, fontWeight: "600" },
    input: { color: theme.colors.foreground, backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 9, minHeight: 40 },
    label: { color: theme.colors.foreground, fontWeight: "600", marginBottom: 5 },
    section: { gap: 8 },
    sectionTitle: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" },
    nestedGroup: { marginLeft: 16, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme.colors.border, gap: 8 },
    childContext: { marginLeft: 16 },
    hint: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 },
    choice: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface2, padding: 10, flexDirection: "row", alignItems: "center", gap: 9 },
    choiceSelected: { borderColor: theme.colors.accent },
    pickerValue: { color: theme.colors.foreground, flex: 1 },
    pickerPlaceholder: { color: theme.colors.foregroundMuted, flex: 1 },
    pickerSearch: { marginTop: 8 },
    empty: { color: theme.colors.foregroundMuted, fontStyle: "italic", paddingVertical: 8 },
    status: { color: theme.colors.foregroundMuted, fontSize: 12, textTransform: "capitalize" },
  });
}

function Button({
  label,
  onPress,
  kind = "secondary",
  theme,
  styles,
  icon,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  theme: PluginSurfaceProps["theme"];
  styles: ReturnType<typeof stylesFor>;
  icon?: string;
}) {
  if (kind === "danger") {
    return (
      <Pressable accessibilityRole="button" onPress={onPress} style={styles.secondary}>
        {icon ? <Icon name={icon} size={15} color={theme.colors.statusDanger} /> : null}
        <Text style={styles.dangerText}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={kind === "primary" ? styles.primary : styles.secondary}>
      {icon ? <Icon name={icon} size={15} color={kind === "primary" ? theme.colors.accentForeground : theme.colors.foreground} /> : null}
      <Text style={kind === "primary" ? styles.primaryText : styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

function Picker({
  label,
  value,
  options,
  placeholder,
  emptyMessage,
  theme,
  styles,
  onSelect,
}: {
  label: string;
  value: string | null;
  options: PickerOption[];
  placeholder: string;
  emptyMessage: string;
  theme: PluginSurfaceProps["theme"];
  styles: ReturnType<typeof stylesFor>;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const selected = options.find((option) => option.id === value);
  const visible = options.filter((option) => {
    const query = filter.trim().toLowerCase();
    return !query || `${option.label} ${option.id} ${option.description ?? ""}`.toLowerCase().includes(query);
  });
  const choose = (id: string | null) => {
    onSelect(id);
    setOpen(false);
    setFilter("");
  };
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={[styles.choice, open && styles.choiceSelected]}
      >
        <Text numberOfLines={1} style={selected ? styles.pickerValue : styles.pickerPlaceholder}>
          {selected?.label ?? placeholder}
        </Text>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={18} color={theme.colors.foregroundMuted} />
      </Pressable>
      {open ? (
        <View style={{ gap: 7, marginTop: 7 }}>
          {options.length > 7 ? (
            <TextInput
              autoFocus
              value={filter}
              onChangeText={setFilter}
              placeholder={`Filter ${label.toLowerCase()}…`}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.input, styles.pickerSearch]}
            />
          ) : null}
          {value !== null ? (
            <Pressable accessibilityRole="button" onPress={() => choose(null)} style={styles.choice}>
              <Icon name="CircleOff" size={16} color={theme.colors.foregroundMuted} />
              <Text style={styles.secondaryText}>Use provider default</Text>
            </Pressable>
          ) : null}
          {visible.map((option) => {
            const chosen = option.id === value;
            return (
              <Pressable key={option.id} accessibilityRole="button" onPress={() => choose(option.id)} style={[styles.choice, chosen && styles.choiceSelected]}>
                <Icon name={chosen ? "CheckCircle2" : "Circle"} size={17} color={chosen ? theme.colors.accent : theme.colors.foregroundMuted} />
                <View style={styles.grow}>
                  <Text style={styles.secondaryText}>{option.label}</Text>
                  {option.description ? <Text style={styles.hint}>{option.description}</Text> : null}
                </View>
              </Pressable>
            );
          })}
          {visible.length === 0 ? <Text style={styles.empty}>{emptyMessage}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function RoleEditor({
  open,
  role,
  roles,
  theme,
  styles,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  role: Role | null;
  roles: Role[];
  theme: PluginSurfaceProps["theme"];
  styles: ReturnType<typeof stylesFor>;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: RoleDraft) => void;
}) {
  const [draft, setDraft] = useState<RoleDraft>(blankRole);
  const providerCatalog = useProviderCatalog();
  const [triggerText, setTriggerText] = useState<string | null>(null);
  useEffect(() => { setDraft(role ? roleDraft(role) : blankRole()); setTriggerText(null); }, [role, open]);
  const update = (patch: Partial<RoleDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const providerEntries = (providerCatalog.data ?? []).filter(
    (entry) => entry.enabled && (entry.status === "ready" || entry.provider === draft.provider),
  );
  const selectedProvider = providerEntries.find((entry) => entry.provider === draft.provider);
  const models = (selectedProvider?.models ?? []).filter((model) => model.isSelectable !== false);
  const selectedModel = models.find((model) => model.id === draft.model);
  // The model's window: the provider's own figure when it reports one, else Pi's catalog through the plugin.
  const isPi = draft.provider === "pi" || draft.provider === "pi-worker";
  const callWindow = useRpc(getContextWindow);
  const catalogWindow = useQuery({
    queryKey: ["role-orchestrator", "context-window", draft.model],
    queryFn: () => callWindow({ provider: draft.provider, model: draft.model }),
    enabled: open && isPi && Boolean(draft.model) && !selectedModel?.contextWindowMaxTokens,
  });
  const contextWindow = selectedModel?.contextWindowMaxTokens ?? catalogWindow.data?.tokens ?? null;
  useEffect(() => {
    if (contextWindow && contextWindow !== draft.compaction.contextWindowTokens) {
      setDraft((current) => ({ ...current, compaction: { ...current.compaction, contextWindowTokens: contextWindow } }));
    } else if (!contextWindow && draft.model && !catalogWindow.isLoading && draft.compaction.contextWindowTokens !== null) {
      setDraft((current) => ({ ...current, compaction: { triggerTokens: null, contextWindowTokens: null } }));
    }
  }, [contextWindow, draft.model, catalogWindow.isLoading]);
  const cacheDefault = draft.delegation.enabled ? "long" : "short";
  const providerOptions: PickerOption[] = providerEntries.map((entry) => ({
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? entry.provider,
  }));
  const modelOptions: PickerOption[] = models.map((model) => ({
    id: model.id,
    label: model.label,
    description: model.description ?? model.id,
  }));
  const thinkingOptions: PickerOption[] = (selectedModel?.thinkingOptions ?? []).map((option) => ({
    id: option.id,
    label: option.label,
    description: option.description ?? option.id,
  }));
  const modeOptions: PickerOption[] = (selectedProvider?.modes ?? []).map((mode) => ({
    id: mode.id,
    label: mode.label,
    description: mode.description ?? mode.id,
  }));
  const toggleAllowed = (id: string) => {
    const current = draft.delegation.allowedRoleIds;
    update({
      delegation: current.includes(id)
        ? {
            ...draft.delegation,
            allowedRoleIds: current.filter((value) => value !== id),
            childContexts: Object.fromEntries(
              Object.entries(draft.delegation.childContexts).filter(([key]) => key !== id),
            ),
          }
        : {
            ...draft.delegation,
            allowedRoleIds: [...current, id],
            childContexts: { ...draft.delegation.childContexts, [id]: "none" },
          },
    });
  };
  return (
    <Modal title={role ? "Edit role" : "New role"} open={open} onOpenChange={onOpenChange}>
      <Modal.Content contentContainerStyle={{ gap: 13, paddingBottom: 8 }}>
          <View>
            <Text style={styles.label}>Name</Text>
            <TextInput value={draft.name} onChangeText={(name) => update({ name })} placeholder="Architect" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
          </View>
          <View>
            <Text style={styles.label}>Delegation description</Text>
            <TextInput value={draft.description} onChangeText={(description) => update({ description })} multiline textAlignVertical="top" placeholder="What this role is best suited to do. Shown only to parent roles choosing a child." placeholderTextColor={theme.colors.foregroundMuted} style={[styles.input, { minHeight: 84 }]} />
            <Text style={styles.hint}>This is not included in this role’s system prompt.</Text>
          </View>
          <Picker
            label="Provider"
            value={draft.provider || null}
            options={providerOptions}
            placeholder={providerCatalog.isLoading ? "Loading available providers…" : "Choose a provider"}
            emptyMessage="No ready providers are available. Check Paseo provider setup."
            theme={theme}
            styles={styles}
            onSelect={(provider) => { setTriggerText(null); update({ provider: provider ?? "", model: "", thinkingOptionId: null, modeId: null, compaction: { triggerTokens: null, contextWindowTokens: null } }); }}
          />
          <Picker
            label="Model"
            value={draft.model || null}
            options={modelOptions}
            placeholder={draft.provider ? "Choose a model" : "Choose a provider first"}
            emptyMessage={draft.provider ? "This provider has no selectable models." : "Choose a provider first."}
            theme={theme}
            styles={styles}
            onSelect={(model) => {
              const next = models.find((candidate) => candidate.id === model);
              setTriggerText(null);
              update({ model: model ?? "", thinkingOptionId: next?.defaultThinkingOptionId ?? null, compaction: { triggerTokens: null, contextWindowTokens: null } });
            }}
          />
          <Picker
            label="Reasoning level"
            value={draft.thinkingOptionId}
            options={thinkingOptions}
            placeholder={draft.model ? "Use provider default" : "Choose a model first"}
            emptyMessage={draft.model ? "This model does not expose reasoning levels." : "Choose a model first."}
            theme={theme}
            styles={styles}
            onSelect={(thinkingOptionId) => update({ thinkingOptionId })}
          />
          <Picker
            label="Provider mode"
            value={draft.modeId}
            options={modeOptions}
            placeholder={draft.provider ? "Use provider default" : "Choose a provider first"}
            emptyMessage={draft.provider ? "This provider does not expose modes." : "Choose a provider first."}
            theme={theme}
            styles={styles}
            onSelect={(modeId) => update({ modeId })}
          />
          <View>
            <Text style={styles.label}>System / role prompt</Text>
            <TextInput value={draft.systemPrompt} onChangeText={(systemPrompt) => update({ systemPrompt })} multiline textAlignVertical="top" placeholder="Persistent instructions for every agent launched with this role." placeholderTextColor={theme.colors.foregroundMuted} style={[styles.input, { minHeight: 150 }]} />
          </View>
          <Picker
            label="Prompt cache retention"
            value={draft.promptCacheRetention ?? cacheDefault}
            options={[
              { id: "short", label: "Short", description: "The provider's normal cache lifetime (minutes)." },
              { id: "long", label: "Long", description: "Extended lifetime where the provider supports it: about an hour on Anthropic, up to 24 hours on OpenAI, through Pi. Best for agents that work for a long time or wait on children." },
            ]}
            placeholder="Short"
            emptyMessage="No options."
            theme={theme}
            styles={styles}
            onSelect={(value) => update({ promptCacheRetention: value === "long" ? "long" : "short" })}
          />
          <Text style={styles.hint}>Default: long for roles that can invoke other roles, short for the rest. Only Pi providers (pi, pi-worker) have a setting for this; it does nothing on others, for example Codex.</Text>
          <View>
            <Text style={styles.label}>Compaction trigger (tokens)</Text>
            <TextInput
              value={triggerText ?? (contextWindow ? String(draft.compaction.triggerTokens ?? contextWindow) : "")}
              editable={Boolean(contextWindow)}
              keyboardType="number-pad"
              onChangeText={(text) => {
                setTriggerText(text);
                const tokens = Number.parseInt(text.replace(/\D/g, ""), 10);
                update({ compaction: { ...draft.compaction, triggerTokens: Number.isFinite(tokens) && contextWindow && tokens >= 1000 && tokens < contextWindow ? tokens : null } });
              }}
              placeholder={isPi ? "Choose a model first" : "Not available for this provider"}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Text style={styles.hint}>{contextWindow ? `Compact the context at this many tokens. Defaults to the model's window (${contextWindow.toLocaleString()}), which is normal compaction; lower it to compact earlier. A value at or above the window is ignored.` : "Needs a known context window. Only Pi providers support it; other providers compact on their own schedule."}</Text>
          </View>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: draft.rereadAfterCompaction }}
            onPress={() => update({ rereadAfterCompaction: !draft.rereadAfterCompaction })}
            style={[styles.choice, draft.rereadAfterCompaction && styles.choiceSelected]}
          >
            <Icon name={draft.rereadAfterCompaction ? "CheckSquare" : "Square"} size={18} color={draft.rereadAfterCompaction ? theme.colors.accent : theme.colors.foregroundMuted} />
            <View style={styles.grow}>
              <Text style={styles.secondaryText}>Re-read this prompt after compaction</Text>
              <Text style={styles.hint}>When an agent’s context is compacted, it is sent this role’s prompt again and told to re-read the files it names. Checked when the agent’s turn ends; applies to running agents too.</Text>
            </View>
          </Pressable>
          <View style={[styles.choice, draft.periodicPrompt.enabled && styles.choiceSelected, { flexDirection: "column", alignItems: "stretch" }]}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: draft.periodicPrompt.enabled }}
              onPress={() => update({ periodicPrompt: { ...draft.periodicPrompt, enabled: !draft.periodicPrompt.enabled } })}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Icon name={draft.periodicPrompt.enabled ? "CheckSquare" : "Square"} size={18} color={draft.periodicPrompt.enabled ? theme.colors.accent : theme.colors.foregroundMuted} />
              <Text style={styles.secondaryText}>Send this prompt to the agent every</Text>
              <TextInput
                accessibilityLabel="Minutes between prompts"
                value={String(draft.periodicPrompt.minutes)}
                onChangeText={(text) => {
                  const minutes = Math.min(10080, Math.max(1, Math.floor(Number(text.replace(/\D/g, "")) || 1)));
                  update({ periodicPrompt: { ...draft.periodicPrompt, minutes } });
                }}
                keyboardType="number-pad"
                style={[styles.input, { width: 72, textAlign: "center" }]}
              />
              <Text style={styles.secondaryText}>minutes</Text>
            </Pressable>
            <TextInput value={draft.periodicPrompt.prompt} onChangeText={(prompt) => update({ periodicPrompt: { ...draft.periodicPrompt, prompt } })} multiline textAlignVertical="top" placeholder="What to tell the agent each time, for example a list of things to check. End with: If there is nothing to do, call pause_loop." placeholderTextColor={theme.colors.foregroundMuted} style={[styles.input, { minHeight: 90 }]} />
            <Text style={styles.hint}>Sent to each running agent with this role. If the agent is busy it waits for the turn to finish, and at most one is ever pending. Archived or closed agents are skipped.</Text>
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Completion</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: draft.delegation.completionGateEnabled }}
              onPress={() => update({ delegation: { ...draft.delegation, completionGateEnabled: !draft.delegation.completionGateEnabled } })}
              style={[styles.choice, draft.delegation.completionGateEnabled && styles.choiceSelected]}
            >
              <Icon name={draft.delegation.completionGateEnabled ? "CheckSquare" : "Square"} size={18} color={draft.delegation.completionGateEnabled ? theme.colors.accent : theme.colors.foregroundMuted} />
              <View style={styles.grow}><Text style={styles.secondaryText}>Check completion of the whole ask</Text><Text style={styles.hint}>Juke judges every completed turn of this role on the whole user ask and sends it back to work if anything runnable remains. Requires the Juke plugin. The judge model is set under "Completion judge".</Text></View>
            </Pressable>
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Delegation</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: draft.delegation.enabled }}
              onPress={() => update({ delegation: { ...draft.delegation, enabled: !draft.delegation.enabled } })}
              style={[styles.choice, draft.delegation.enabled && styles.choiceSelected]}
            >
              <Icon name={draft.delegation.enabled ? "CheckSquare" : "Square"} size={18} color={draft.delegation.enabled ? theme.colors.accent : theme.colors.foregroundMuted} />
              <View style={styles.grow}>
                <Text style={styles.secondaryText}>Can invoke other roles</Text>
                <Text style={styles.hint}>Only checked roles below may be launched as this role’s children.</Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: draft.delegation.restrictChildCommunication }}
              onPress={() => update({ delegation: { ...draft.delegation, restrictChildCommunication: !draft.delegation.restrictChildCommunication } })}
              style={[styles.choice, draft.delegation.restrictChildCommunication && styles.choiceSelected]}
            >
              <Icon name={draft.delegation.restrictChildCommunication ? "CheckSquare" : "Square"} size={18} color={draft.delegation.restrictChildCommunication ? theme.colors.accent : theme.colors.foregroundMuted} />
              <View style={styles.grow}>
                <Text style={styles.secondaryText}>Subagents can only message this agent</Text>
                <Text style={styles.hint}>Every subagent must use the pi-worker provider (no Paseo tools) and gets one tool that messages this agent. Other providers are refused at creation. Applied when the agent launches.</Text>
              </View>
            </Pressable>
            {draft.delegation.enabled ? (
              <View style={styles.nestedGroup}>
                <Text style={styles.label}>Allowed child roles</Text>
                {roles.filter((candidate) => candidate.id !== role?.id).map((candidate) => {
                  const checked = draft.delegation.allowedRoleIds.includes(candidate.id);
                  return (
                    <View key={candidate.id} style={{ gap: 7 }}>
                      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => toggleAllowed(candidate.id)} style={[styles.choice, checked && styles.choiceSelected]}>
                        <Icon name={checked ? "CheckSquare" : "Square"} size={18} color={checked ? theme.colors.accent : theme.colors.foregroundMuted} />
                        <View style={styles.grow}>
                          <Text style={styles.secondaryText}>{candidate.name}</Text>
                          <Text style={styles.hint}>{providerModel(candidate)}</Text>
                        </View>
                      </Pressable>
                      {checked ? <View style={styles.childContext}><Picker label="Child context" value={draft.delegation.childContexts[candidate.id] ?? "none"} options={[{ id: "none", label: "No parent context", description: "Task prompt and shared workspace only." }, { id: "full", label: "Complete session context", description: "Attach the complete, unedited parent timeline." }, { id: "summary", label: "Session context summary", description: "Create a temporary same-model summary first." }]} placeholder="No parent context" emptyMessage="No context options available." theme={theme} styles={styles} onSelect={(context) => { const nextContext = context === "full" || context === "summary" ? context : "none"; update({ delegation: { ...draft.delegation, childContexts: { ...draft.delegation.childContexts, [candidate.id]: nextContext } } }); }} /></View> : null}
                    </View>
                  );
                })}
                {roles.filter((candidate) => candidate.id !== role?.id).length === 0 ? <Text style={styles.empty}>Create another role before allowing delegation.</Text> : null}
              </View>
            ) : null}
          </View>
          <View style={[styles.row, { justifyContent: "flex-end", marginTop: 4 }]}>
            <Button label="Cancel" onPress={() => onOpenChange(false)} theme={theme} styles={styles} />
            <Button label={role ? "Save role" : "Create role"} kind="primary" onPress={() => onSave(draft)} theme={theme} styles={styles} icon="Save" />
          </View>
      </Modal.Content>
    </Modal>
  );
}

function RoleCard({ role, theme, styles, onEdit, onDelete }: { role: Role; theme: PluginSurfaceProps["theme"]; styles: ReturnType<typeof stylesFor>; onEdit: () => void; onDelete: () => void }) {
  const allowed = role.delegation.enabled ? role.delegation.allowedRoleIds.length : 0;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={styles.name}>{role.name}</Text>
          <Text style={styles.detail}>{providerModel(role)}{role.thinkingOptionId ? ` · ${role.thinkingOptionId}` : ""}</Text>
        </View>
        <Button label="Edit" onPress={onEdit} theme={theme} styles={styles} icon="Pencil" />
        <Button label="Delete" onPress={onDelete} kind="danger" theme={theme} styles={styles} icon="Trash2" />
      </View>
      <Text numberOfLines={3} style={styles.detail}>{role.description || "No delegation description configured."}</Text>
      <Text style={styles.detail}>{role.delegation.enabled ? `May invoke ${allowed} role${allowed === 1 ? "" : "s"}` : "Cannot invoke child roles"}</Text>
    </View>
  );
}

const SAME_AS_AGENT = "__same-as-agent__";

function CompletionJudgeCard({ hostId, theme, styles }: { hostId: string; theme: PluginSurfaceProps["theme"]; styles: ReturnType<typeof stylesFor> }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const get = useRpc(getCompletionJudge);
  const save = useRpc(saveCompletionJudge);
  const settingsQuery = useQuery({ queryKey: ["role-orchestrator", hostId, "completion-judge"], queryFn: () => get({}) });
  const catalog = useProviderCatalog();
  const [draft, setDraft] = useState<CompletionJudge | null>(null);
  useEffect(() => { if (settingsQuery.data) setDraft(settingsQuery.data); }, [settingsQuery.data]);
  if (!draft) return settingsQuery.isError
    ? <Text accessibilityRole="alert" style={styles.dangerText}>Could not load the completion judge: {settingsQuery.error.message}</Text>
    : <ActivityIndicator color={theme.colors.accent} />;
  const providers = (catalog.data ?? []).filter((entry) => entry.enabled && (entry.status === "ready" || entry.provider === draft.provider));
  const provider = providers.find((entry) => entry.provider === draft.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  const providerOptions = [
    { id: SAME_AS_AGENT, label: "Same as the agent being judged", description: "Use each role agent's own provider and model" },
    ...providers.map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider, description: entry.description ?? entry.provider })),
  ];
  const modelOptions = models.map((model) => ({ id: model.id, label: model.label, description: model.description ?? model.id }));
  const thinkingOptions = (models.find((model) => model.id === draft.model)?.thinkingOptions ?? []).map((option) => ({ id: option.id, label: option.label, description: option.description ?? option.id }));
  const same = !draft.provider;
  const saveDraft = async () => {
    try {
      await save(draft);
      await queryClient.invalidateQueries({ queryKey: ["role-orchestrator", hostId, "completion-judge"] });
      toast.show("Completion judge saved", { variant: "success" });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save the completion judge"); }
  };
  return <View style={styles.card}>
    <View style={styles.header}><Text style={[styles.name, styles.grow]}>Completion judge</Text><Button label="Save" kind="primary" onPress={() => void saveDraft()} theme={theme} styles={styles} icon="Save" /></View>
    <Text style={styles.detail}>Roles with completion checking on are judged by the Juke plugin on the whole user ask. This is the model Juke uses for them. By default each agent is judged by its own model.</Text>
    <Picker label="Provider" value={same ? SAME_AS_AGENT : draft.provider} options={providerOptions} placeholder="Choose a provider" emptyMessage="No ready providers are available." theme={theme} styles={styles} onSelect={(providerId) => setDraft({ provider: !providerId || providerId === SAME_AS_AGENT ? "" : providerId, model: "", thinkingOptionId: null })} />
    {same ? null : <Picker label="Model" value={draft.model || null} options={modelOptions} placeholder="Choose a model" emptyMessage="No selectable models are available." theme={theme} styles={styles} onSelect={(modelId) => { const model = models.find((candidate) => candidate.id === modelId); setDraft({ ...draft, model: modelId ?? "", thinkingOptionId: model?.defaultThinkingOptionId ?? null }); }} />}
    {same ? null : <Picker label="Reasoning level" value={draft.thinkingOptionId} options={thinkingOptions} placeholder="Use provider default" emptyMessage="This model does not expose reasoning levels." theme={theme} styles={styles} onSelect={(thinkingOptionId) => setDraft({ ...draft, thinkingOptionId })} />}
    {!same && !draft.model ? <Text style={styles.hint}>Choose a model. Until then, each agent is judged by its own model.</Text> : null}
  </View>;
}

export function CompletionJudgeSettingsPage({ theme, host, layout }: PluginSurfaceProps) {
  const styles = useMemo(() => stylesFor(theme, layout.compact), [layout.compact, theme]);
  return <View style={styles.content}><CompletionJudgeCard hostId={host.id} theme={theme} styles={styles} /></View>;
}

export function RoleCatalogSurface({ theme, host, layout }: PluginSurfaceProps) {
  const styles = useMemo(() => stylesFor(theme, layout.compact), [layout.compact, theme]);
  const rolesQuery = useRoles(host.id);
  const mutations = useRoleMutations(host.id);
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const roles = rolesQuery.data ?? [];
  return (
    <View>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.grow}>
            <Text style={styles.title}>Roles</Text>
            <Text style={styles.subtitle}>Reusable agent configurations and delegation policies.</Text>
          </View>
          <View style={styles.row}>
            <Button label="New role" onPress={() => setEditing("new")} kind="primary" theme={theme} styles={styles} icon="Plus" />
          </View>
        </View>
        {rolesQuery.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
        {rolesQuery.isError ? <Text style={styles.dangerText}>Could not load roles.</Text> : null}
        {roles.map((role) => <RoleCard key={role.id} role={role} theme={theme} styles={styles} onEdit={() => setEditing(role)} onDelete={() => mutations.mutate({ kind: "delete", id: role.id })} />)}
        {!rolesQuery.isLoading && roles.length === 0 ? <View style={styles.card}><Text style={styles.empty}>Create roles here, then open the Roles workspace panel to launch them.</Text></View> : null}
      </View>
      <RoleEditor
        open={editing !== null}
        role={editing === "new" ? null : editing}
        roles={roles}
        theme={theme}
        styles={styles}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={(draft) => {
          if (!draft.name.trim() || !draft.provider.trim() || !draft.model.trim()) return;
          mutations.mutate(editing === "new" ? { kind: "create", draft } : { kind: "update", id: editing!.id, draft });
          setEditing(null);
        }}
      />
    </View>
  );
}

function RoleLauncher({
  roles,
  workspaceId,
  cwd,
  parentAgentId,
  parentRoleId,
  allowedRoleIds,
  theme,
  styles,
  navigation,
}: {
  roles: Role[];
  workspaceId: string;
  cwd: string;
  parentAgentId?: string;
  parentRoleId?: string;
  allowedRoleIds?: readonly string[];
  theme: PluginSurfaceProps["theme"];
  styles: ReturnType<typeof stylesFor>;
  navigation?: PluginSurfaceProps["navigation"];
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const allowed = allowedRoleIds ? roles.filter((role) => allowedRoleIds.includes(role.id)) : roles;
  const selected = allowed.find((role) => role.id === roleId) ?? null;
  useEffect(() => {
    if (!selected) setRoleId(allowed[0]?.id ?? null);
  }, [allowed, selected]);
  const callLaunch = useRpc(launchRoleRpc);
  const launch = async () => {
    if (!selected || !prompt.trim()) return;
    try {
      // Server-side launch: the UI and the `launch_role` tool must produce identical role runs.
      const result = await callLaunch({
        ...(parentAgentId ? { parent: { agentId: parentAgentId, roleId: parentRoleId! } } : { workspaceId }),
        role: selected.id,
        title: selected.name,
        prompt: prompt.trim(),
      });
      setOpen(false);
      setPrompt("");
      toast.show(`${result.roleName} launched`, { variant: "success" });
      navigation?.openAgent({ agentId: result.agentId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to launch role");
    }
  };

  if (allowed.length === 0) return <Text style={styles.empty}>{parentAgentId ? "This role is not permitted to invoke any child roles." : "Create a role before launching an agent."}</Text>;
  return (
    <>
      <Button label={parentAgentId ? "Launch child role" : "Launch role"} onPress={() => setOpen(true)} kind="primary" theme={theme} styles={styles} icon="Play" />
      <Modal title={parentAgentId ? "Launch child role" : "Launch role"} open={open} onOpenChange={setOpen}>
        <Modal.Content contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
            <Text style={styles.label}>Role</Text>
            {allowed.map((role) => {
              const chosen = selected?.id === role.id;
              return <Pressable key={role.id} onPress={() => setRoleId(role.id)} style={[styles.choice, chosen && styles.choiceSelected]}><Icon name={chosen ? "CheckCircle2" : "Circle"} size={18} color={chosen ? theme.colors.accent : theme.colors.foregroundMuted} /><View style={styles.grow}><Text style={styles.secondaryText}>{role.name}</Text><Text style={styles.hint}>{providerModel(role)}{role.thinkingOptionId ? ` · ${role.thinkingOptionId}` : ""}</Text></View></Pressable>;
            })}
            <View>
              <Text style={styles.label}>Task prompt</Text>
              <TextInput value={prompt} onChangeText={setPrompt} multiline textAlignVertical="top" placeholder="What should this role do?" placeholderTextColor={theme.colors.foregroundMuted} style={[styles.input, { minHeight: 130 }]} />
              <Text style={styles.hint}>The selected role’s system prompt is applied separately.</Text>
            </View>
            <View style={[styles.row, { justifyContent: "flex-end" }]}><Button label="Cancel" onPress={() => setOpen(false)} theme={theme} styles={styles} /><Button label="Launch" onPress={() => void launch()} kind="primary" theme={theme} styles={styles} icon="Play" /></View>
        </Modal.Content>
      </Modal>
    </>
  );
}

function RoleRunRow({ agent, role, depth, theme, styles, navigation }: { agent: RoleRunAgent; role?: Role; depth: number; theme: PluginSurfaceProps["theme"]; styles: ReturnType<typeof stylesFor>; navigation?: PluginSurfaceProps["navigation"] }) {
  const archived = Boolean(agent.archivedAt);
  const completionKind = agent.labels[COMPLETION_AGENT_LABEL];
  const completionName = completionKind === "judge" ? "Completion gate" : completionKind === "summary" ? "Completion evidence summary" : null;
  return (
    <Pressable
      onPress={() => navigation?.openAgent({ agentId: agent.id })}
      style={[styles.choice, { marginLeft: depth * 20 }, archived && { opacity: 0.55 }]}
    >
      <Icon name={depth > 0 ? "GitFork" : "CircleDot"} size={16} color={archived ? theme.colors.foregroundMuted : theme.colors.accent} />
      <View style={styles.grow}>
        <Text style={styles.secondaryText}>{completionName ?? role?.name ?? agent.title ?? "Unknown role"}</Text>
        <Text style={styles.hint}>
          {agent.title && (completionName ?? role?.name) && agent.title !== (completionName ?? role?.name) ? `${agent.title} · ` : ""}
          {agent.status}
          {archived ? " · archived" : ""}
        </Text>
      </View>
    </Pressable>
  );
}

function RoleRuns({ workspaceId, roles, theme, styles, navigation }: { workspaceId: string; roles: Role[]; theme: PluginSurfaceProps["theme"]; styles: ReturnType<typeof stylesFor>; navigation?: PluginSurfaceProps["navigation"] }) {
  const paseo = usePaseo();
  const [includeArchived, setIncludeArchived] = useState(false);
  const roleKey = roles.map((role) => role.id).join(",");
  const runs = useQuery({
    queryKey: ["role-orchestrator", workspaceId, "runs", includeArchived, roleKey],
    queryFn: () =>
      fetchRoleAgents(
        {
          // Agent-list entries are { agent, project }; the fields the panel needs live
          // under entry.agent, and the parent link is a label, not a top-level field.
          list: async (options) => {
            const result = await paseo.agents.list(options);
            return {
              entries: result.entries.map(({ agent }): RoleRunAgent => ({
                id: agent.id,
                workspaceId: agent.workspaceId ?? "",
                parentAgentId: agent.labels?.[PARENT_AGENT_LABEL] ?? null,
                status: agent.status,
                title: agent.title,
                labels: agent.labels ?? {},
                createdAt: agent.createdAt,
                archivedAt: agent.archivedAt ?? null,
              })),
              pageInfo: result.pageInfo,
            };
          },
        },
        roles,
        includeArchived,
      ),
    refetchInterval: 5_000,
    enabled: roles.length > 0,
  });

  const roleById = new Map(roles.map((role) => [role.id, role]));
  const { rows, elsewhere } = buildRoleRunTree(runs.data ?? [], workspaceId);

  const archivedToggle = (
    <Pressable onPress={() => setIncludeArchived((value) => !value)} style={[styles.row, { alignSelf: "flex-start" }]}>
      <Icon name={includeArchived ? "CheckSquare" : "Square"} size={15} color={theme.colors.foregroundMuted} />
      <Text style={styles.hint}>Show finished and archived runs</Text>
    </Pressable>
  );

  if (roles.length === 0) {
    return <Text style={styles.empty}>No roles are configured yet. Create one in the Roles catalog first.</Text>;
  }
  if (runs.isLoading) return <ActivityIndicator color={theme.colors.accent} />;
  if (rows.length === 0) {
    return (
      <View style={{ gap: 8 }}>
        {archivedToggle}
        <Text style={styles.empty}>
          {includeArchived ? "No role agents have run in this workspace." : "No active role agents in this workspace."}
          {elsewhere > 0
            ? ` ${elsewhere} role ${elsewhere === 1 ? "agent is" : "agents are"} in other workspaces.`
            : " Launch one above to start."}
        </Text>
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {archivedToggle}
      {rows.map(({ agent, depth }) => (
        <RoleRunRow key={agent.id} agent={agent} role={roleById.get(agent.labels[ROLE_LABEL])} depth={depth} theme={theme} styles={styles} navigation={navigation} />
      ))}
    </View>
  );
}

export function RoleWorkspacePanel({ theme, host, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const styles = useMemo(() => stylesFor(theme, layout.compact), [layout.compact, theme]);
  const workspace = useWorkspace(workspaceId, ({ directory, name }) => ({ directory, name }));
  const roles = useRoles(host.id).data ?? [];
  if (!workspace) return null;
  return <View style={styles.screen}><ScrollView contentContainerStyle={styles.content}><View style={styles.header}><View style={styles.grow}><Text style={styles.title}>Roles</Text><Text style={styles.subtitle}>{workspace.name}</Text></View><RoleLauncher roles={roles} workspaceId={workspaceId} cwd={workspace.directory} theme={theme} styles={styles} navigation={navigation} /></View><View style={styles.card}><Text style={styles.name}>Role hierarchy</Text><RoleRuns workspaceId={workspaceId} roles={roles} theme={theme} styles={styles} navigation={navigation} /></View></ScrollView></View>;
}

export function RoleAgentPanel({ theme, host, layout, workspaceId, agentId, navigation }: PluginAgentPanelProps) {
  const styles = useMemo(() => stylesFor(theme, layout.compact), [layout.compact, theme]);
  const workspace = useWorkspace(workspaceId, ({ directory }) => ({ directory }));
  const agent = useAgent(agentId, ({ labels, title, provider, model, thinkingOptionId, currentModeId }) => ({ labels, title, provider, model, thinkingOptionId, currentModeId }));
  const roles = useRoles(host.id).data ?? [];
  const parentRole = roles.find((role) => role.id === agent?.labels[ROLE_LABEL]);
  if (!workspace || !agent) return null;
  return <View style={styles.screen}><ScrollView contentContainerStyle={styles.content}><Text style={styles.title}>Child roles</Text><Text style={styles.subtitle}>{parentRole ? parentRole.name : agent.title ?? "Agent"}</Text><View style={styles.card}>{parentRole?.delegation.enabled ? <RoleLauncher roles={roles} workspaceId={workspaceId} cwd={workspace.directory} parentAgentId={agentId} parentRoleId={parentRole.id} allowedRoleIds={parentRole.delegation.allowedRoleIds} theme={theme} styles={styles} navigation={navigation} /> : <Text style={styles.empty}>This agent’s role cannot invoke child roles.</Text>}</View><View style={styles.card}><Text style={styles.name}>Role hierarchy</Text><RoleRuns workspaceId={workspaceId} roles={roles} theme={theme} styles={styles} navigation={navigation} /></View></ScrollView></View>;
}
