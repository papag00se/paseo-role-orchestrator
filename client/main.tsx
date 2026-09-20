import {
  type PluginAgentPanelProps,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  useAgent,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { buildRoleRunTree, fetchRoleAgents, PARENT_AGENT_LABEL, type RoleRunAgent } from "../shared/role-runs";
import {
  createRole,
  deleteRole,
  getCompletionGateSettings,
  launchRoleRpc,
  listRoles,
  ROLE_LABEL,
  providerModel,
  saveCompletionGateSettings,
  type CompletionGateSettings,
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
  delegation: { enabled: false, allowedRoleIds: [], childContexts: {}, completionGateEnabled: false }
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

function useCompletionGateSettings(hostId: string) {
  const get = useRpc(getCompletionGateSettings);
  return useQuery({ queryKey: ["role-orchestrator", hostId, "completion-gate"], queryFn: () => get({}) });
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
  completionGateReady,
  theme,
  styles,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  role: Role | null;
  roles: Role[];
  completionGateReady: boolean;
  theme: PluginSurfaceProps["theme"];
  styles: ReturnType<typeof stylesFor>;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: RoleDraft) => void;
}) {
  const [draft, setDraft] = useState<RoleDraft>(blankRole);
  const providerCatalog = useProviderCatalog();
  useEffect(() => setDraft(role ? roleDraft(role) : blankRole()), [role, open]);
  const update = (patch: Partial<RoleDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const providerEntries = (providerCatalog.data ?? []).filter(
    (entry) => entry.enabled && (entry.status === "ready" || entry.provider === draft.provider),
  );
  const selectedProvider = providerEntries.find((entry) => entry.provider === draft.provider);
  const models = (selectedProvider?.models ?? []).filter((model) => model.isSelectable !== false);
  const selectedModel = models.find((model) => model.id === draft.model);
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
      <Modal.Content>
        <ScrollView contentContainerStyle={{ gap: 13, paddingBottom: 8 }}>
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
            onSelect={(provider) => update({ provider: provider ?? "", model: "", thinkingOptionId: null, modeId: null })}
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
              update({ model: model ?? "", thinkingOptionId: next?.defaultThinkingOptionId ?? null });
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
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Completion</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: draft.delegation.completionGateEnabled, disabled: !completionGateReady }}
              disabled={!completionGateReady}
              onPress={() => update({ delegation: { ...draft.delegation, completionGateEnabled: !draft.delegation.completionGateEnabled } })}
              style={[styles.choice, draft.delegation.completionGateEnabled && styles.choiceSelected, !completionGateReady && { opacity: 0.55 }]}
            >
              <Icon name={draft.delegation.completionGateEnabled ? "CheckSquare" : "Square"} size={18} color={draft.delegation.completionGateEnabled ? theme.colors.accent : theme.colors.foregroundMuted} />
              <View style={styles.grow}><Text style={styles.secondaryText}>Enable completion gate</Text><Text style={styles.hint}>{completionGateReady ? "Run the configured independent completion check after every completed turn." : "To use this feature, open settings and set your completion gate model."}</Text></View>
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
        </ScrollView>
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

function CompletionGateSettingsCard({ hostId, theme, styles }: { hostId: string; theme: PluginSurfaceProps["theme"]; styles: ReturnType<typeof stylesFor> }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const settingsQuery = useCompletionGateSettings(hostId);
  const save = useRpc(saveCompletionGateSettings);
  const catalog = useProviderCatalog();
  const [draft, setDraft] = useState<CompletionGateSettings | null>(null);
  useEffect(() => { if (settingsQuery.data) setDraft(settingsQuery.data); }, [settingsQuery.data]);
  if (!draft) return null;
  const providers = (catalog.data ?? []).filter((entry) => entry.enabled && (entry.status === "ready" || entry.provider === draft.provider));
  const provider = providers.find((entry) => entry.provider === draft.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  const providerOptions = providers.map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider, description: entry.description ?? entry.provider }));
  const modelOptions = models.map((model) => ({ id: model.id, label: model.label, description: model.description ?? model.id }));
  const thinkingOptions = (models.find((model) => model.id === draft.model)?.thinkingOptions ?? []).map((option) => ({ id: option.id, label: option.label, description: option.description ?? option.id }));
  const saveDraft = async () => {
    try {
      await save(draft);
      await queryClient.invalidateQueries({ queryKey: ["role-orchestrator", hostId, "completion-gate"] });
      toast.show("Completion gate settings saved", { variant: "success" });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save completion gate settings"); }
  };
  return <View style={styles.card}>
    <Text style={styles.name}>Completion gate settings</Text>
    <Text style={styles.detail}>The gate checks user requests, clarification exchanges, and assistant responses against workspace evidence. Oversized evidence is summarized separately using the judge model; the Supervisor is never asked to summarize.</Text>
    <Picker label="Provider" value={draft.provider || null} options={providerOptions} placeholder="Choose a provider" emptyMessage="No ready providers are available." theme={theme} styles={styles} onSelect={(providerId) => setDraft({ ...draft, provider: providerId ?? "", model: "", thinkingOptionId: null })} />
    <Picker label="Model" value={draft.model || null} options={modelOptions} placeholder={draft.provider ? "Choose a model" : "Choose a provider first"} emptyMessage="No selectable models are available." theme={theme} styles={styles} onSelect={(modelId) => { const model = models.find((candidate) => candidate.id === modelId); setDraft({ ...draft, model: modelId ?? "", thinkingOptionId: model?.defaultThinkingOptionId ?? null }); }} />
    <Picker label="Reasoning level" value={draft.thinkingOptionId} options={thinkingOptions} placeholder="Use provider default" emptyMessage="This model does not expose reasoning levels." theme={theme} styles={styles} onSelect={(thinkingOptionId) => setDraft({ ...draft, thinkingOptionId })} />
    <View><Text style={styles.label}>Gate prompt</Text><TextInput value={draft.prompt} onChangeText={(prompt) => setDraft({ ...draft, prompt })} multiline textAlignVertical="top" style={[styles.input, { minHeight: 160 }]} /></View>
    <View style={[styles.row, { justifyContent: "flex-end" }]}><Button label="Save completion gate" kind="primary" onPress={() => void saveDraft()} theme={theme} styles={styles} icon="Save" /></View>
  </View>;
}

export function RoleCatalogSurface({ theme, host, layout }: PluginSurfaceProps) {
  const styles = useMemo(() => stylesFor(theme, layout.compact), [layout.compact, theme]);
  const rolesQuery = useRoles(host.id);
  const completionGate = useCompletionGateSettings(host.id);
  const mutations = useRoleMutations(host.id);
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const [completionGateSettingsOpen, setCompletionGateSettingsOpen] = useState(false);
  const roles = rolesQuery.data ?? [];
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.grow}>
            <Text style={styles.title}>Roles</Text>
            <Text style={styles.subtitle}>Reusable agent configurations and delegation policies.</Text>
          </View>
          <View style={styles.row}>
            <Button label="Settings" onPress={() => setCompletionGateSettingsOpen(true)} theme={theme} styles={styles} icon="Settings" />
            <Button label="New role" onPress={() => setEditing("new")} kind="primary" theme={theme} styles={styles} icon="Plus" />
          </View>
        </View>
        {rolesQuery.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
        {rolesQuery.isError ? <Text style={styles.dangerText}>Could not load roles.</Text> : null}
        {roles.map((role) => <RoleCard key={role.id} role={role} theme={theme} styles={styles} onEdit={() => setEditing(role)} onDelete={() => mutations.mutate({ kind: "delete", id: role.id })} />)}
        {!rolesQuery.isLoading && roles.length === 0 ? <View style={styles.card}><Text style={styles.empty}>Create roles here, then open the Roles workspace panel to launch them.</Text></View> : null}
      </ScrollView>
      <Modal title="Completion gate settings" open={completionGateSettingsOpen} onOpenChange={setCompletionGateSettingsOpen}>
        <Modal.Content>
          <CompletionGateSettingsCard hostId={host.id} theme={theme} styles={styles} />
        </Modal.Content>
      </Modal>
      <RoleEditor
        open={editing !== null}
        role={editing === "new" ? null : editing}
        roles={roles}
        completionGateReady={Boolean(completionGate.data?.provider && completionGate.data?.model)}
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
        <Modal.Content>
          <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
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
          </ScrollView>
        </Modal.Content>
      </Modal>
    </>
  );
}

function RoleRunRow({ agent, role, depth, theme, styles, navigation }: { agent: RoleRunAgent; role?: Role; depth: number; theme: PluginSurfaceProps["theme"]; styles: ReturnType<typeof stylesFor>; navigation?: PluginSurfaceProps["navigation"] }) {
  const archived = Boolean(agent.archivedAt);
  return (
    <Pressable
      onPress={() => navigation?.openAgent({ agentId: agent.id })}
      style={[styles.choice, { marginLeft: depth * 20 }, archived && { opacity: 0.55 }]}
    >
      <Icon name={depth > 0 ? "GitFork" : "CircleDot"} size={16} color={archived ? theme.colors.foregroundMuted : theme.colors.accent} />
      <View style={styles.grow}>
        <Text style={styles.secondaryText}>{role?.name ?? agent.title ?? "Unknown role"}</Text>
        <Text style={styles.hint}>
          {agent.title && role?.name && agent.title !== role.name ? `${agent.title} · ` : ""}
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
