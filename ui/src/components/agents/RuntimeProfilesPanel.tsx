import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  AgentRuntimeProfile,
  AgentRuntimeProfilePreflight,
  AgentRuntimeProfileTier,
} from "@paperclipai/shared";
import { AGENT_RUNTIME_PROFILE_MAX_PER_AGENT, AGENT_RUNTIME_PROFILE_TIERS } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToastActions } from "@/context/ToastContext";
import { cn } from "@/lib/utils";

const TIER_LABELS: Record<AgentRuntimeProfileTier, string> = {
  primary: "Primary",
  economy: "Economy",
  fallback: "Fallback",
  specialist: "Specialist",
};

function tierLabel(tier: string): string {
  return TIER_LABELS[tier as AgentRuntimeProfileTier] ?? tier;
}

function profileModel(profile: AgentRuntimeProfile): string {
  const model = profile.adapterConfig?.model;
  return typeof model === "string" && model.length > 0 ? model : "default model";
}

function isActiveRunsConflict(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const body = err.body as { code?: unknown; details?: { code?: unknown } } | null;
  return body?.code === "agent_runs_active" || body?.details?.code === "agent_runs_active";
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

type ProfileDialogState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "rename"; profile: AgentRuntimeProfile };

type ActivateDialogState =
  | { open: false }
  | { open: true; profile: AgentRuntimeProfile; preflight: AgentRuntimeProfilePreflight | null; cancelRuns: boolean };

export interface RuntimeProfilesPanelProps {
  agent: Agent;
  companyId?: string;
  /** Called after a profile was activated, so the surrounding form can reload. */
  onActivated?: (agent: Agent) => void;
  className?: string;
}

/**
 * Lists an agent's runtime profiles and lets the operator capture the current
 * runtime as a profile, activate another one (with a preflight summary), rename
 * or delete profiles. The agent settings form below stays the editor: edits
 * made there are mirrored into the active profile by the server.
 */
export function RuntimeProfilesPanel({ agent, companyId, onActivated, className }: RuntimeProfilesPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [dialog, setDialog] = useState<ProfileDialogState>({ mode: "closed" });
  const [name, setName] = useState("");
  const [tier, setTier] = useState<AgentRuntimeProfileTier>("primary");
  const [activateDialog, setActivateDialog] = useState<ActivateDialogState>({ open: false });
  const [pendingDelete, setPendingDelete] = useState<AgentRuntimeProfile | null>(null);

  const listQuery = useQuery({
    queryKey: queryKeys.agents.runtimeProfiles(agent.id),
    queryFn: () => agentsApi.runtimeProfiles(agent.id, companyId),
  });
  const profiles = listQuery.data?.profiles ?? [];
  const activeId = listQuery.data?.activeRuntimeProfileId ?? agent.activeRuntimeProfileId ?? null;
  const activeProfile = profiles.find((profile) => profile.id === activeId) ?? null;

  const invalidateAgent = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeProfiles(agent.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agent.id) }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: (input: { name: string; tier: AgentRuntimeProfileTier }) =>
      agentsApi.createRuntimeProfile(agent.id, input, companyId),
    onSuccess: async () => {
      setDialog({ mode: "closed" });
      await invalidateAgent();
      pushToast({ title: "Runtime profile saved", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Could not save runtime profile", body: errorMessage(err, "Unknown error"), tone: "error" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: (input: { profileId: string; name: string; tier: AgentRuntimeProfileTier }) =>
      agentsApi.updateRuntimeProfile(agent.id, input.profileId, { name: input.name, tier: input.tier }, companyId),
    onSuccess: async () => {
      setDialog({ mode: "closed" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeProfiles(agent.id) });
      pushToast({ title: "Runtime profile updated", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Could not update runtime profile", body: errorMessage(err, "Unknown error"), tone: "error" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (profileId: string) => agentsApi.deleteRuntimeProfile(agent.id, profileId, companyId),
    onSuccess: async () => {
      setPendingDelete(null);
      await invalidateAgent();
      pushToast({ title: "Runtime profile deleted", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Could not delete runtime profile", body: errorMessage(err, "Unknown error"), tone: "error" });
    },
  });

  const activateMutation = useMutation({
    mutationFn: (input: { profileId: string; cancelActiveRuns: boolean }) =>
      agentsApi.activateRuntimeProfile(agent.id, input.profileId, { cancelActiveRuns: input.cancelActiveRuns }, companyId),
    onSuccess: async (updated) => {
      setActivateDialog({ open: false });
      await invalidateAgent();
      pushToast({ title: "Runtime profile activated", tone: "success" });
      onActivated?.(updated);
    },
    onError: (err) => {
      if (isActiveRunsConflict(err)) {
        // Keep the dialog open and ask for the explicit cancellation.
        setActivateDialog((state) => (state.open ? { ...state, cancelRuns: true } : state));
        pushToast({ title: "This agent still has active runs", body: "Confirm again to cancel them and switch.", tone: "error" });
        return;
      }
      pushToast({ title: "Could not activate runtime profile", body: errorMessage(err, "Unknown error"), tone: "error" });
    },
  });

  const openActivate = async (profile: AgentRuntimeProfile) => {
    setActivateDialog({ open: true, profile, preflight: null, cancelRuns: false });
    try {
      const preflight = await agentsApi.preflightRuntimeProfile(agent.id, profile.id, companyId);
      setActivateDialog((state) =>
        state.open && state.profile.id === profile.id
          ? { ...state, preflight, cancelRuns: preflight.activeRunCount > 0 }
          : state,
      );
    } catch {
      // The dialog still works without the summary; activation reports the real state.
    }
  };

  const openCreate = () => {
    setName("");
    setTier(activeProfile ? "economy" : "primary");
    setDialog({ mode: "create" });
  };

  const openRename = (profile: AgentRuntimeProfile) => {
    setName(profile.name);
    setTier(profile.tier);
    setDialog({ mode: "rename", profile });
  };

  const submitDialog = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (dialog.mode === "create") createMutation.mutate({ name: trimmed, tier });
    if (dialog.mode === "rename") renameMutation.mutate({ profileId: dialog.profile.id, name: trimmed, tier });
  };

  const atLimit = profiles.length >= AGENT_RUNTIME_PROFILE_MAX_PER_AGENT;

  return (
    <section
      className={cn("rounded-lg border border-border bg-card p-4 space-y-3", className)}
      aria-label="Runtime profiles"
      data-testid="runtime-profiles-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Runtime profiles</h3>
          <p className="text-xs text-muted-foreground">
            Keep several execution setups for this agent and switch between them. Each profile keeps its own task sessions.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={openCreate} disabled={atLimit || listQuery.isLoading}>
          Save current as profile
        </Button>
      </div>

      {activeProfile ? (
        <p className="text-xs text-muted-foreground">
          Changes saved in the settings below are stored in the active profile:{" "}
          <span className="font-medium text-foreground">{activeProfile.name}</span>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No profile captured yet. Save the current runtime first, then add more profiles for other harnesses or models.
        </p>
      )}

      {listQuery.isError ? (
        <p className="text-sm text-destructive">Could not load runtime profiles.</p>
      ) : null}

      {profiles.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {profiles.map((profile) => {
            const isActive = profile.id === activeId;
            return (
              <li key={profile.id} className="flex flex-wrap items-center justify-between gap-2 p-3" data-testid="runtime-profile-row">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{profile.name}</span>
                    <Badge variant="secondary">{tierLabel(profile.tier)}</Badge>
                    {isActive ? <Badge>Active</Badge> : null}
                    {!profile.enabled ? <Badge variant="outline">Disabled</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {profile.adapterType} · {profileModel(profile)}
                    {profile.runtimeConfig?.aiConnection ? " · AI connection" : ""}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!isActive ? (
                    <Button
                      size="sm"
                      onClick={() => void openActivate(profile)}
                      disabled={!profile.enabled || activateMutation.isPending}
                      aria-label={`Activate profile ${profile.name}`}
                    >
                      Activate
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => openRename(profile)} aria-label={`Rename profile ${profile.name}`}>
                    Rename
                  </Button>
                  {!isActive ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPendingDelete(profile)}
                      aria-label={`Delete profile ${profile.name}`}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Dialog open={dialog.mode !== "closed"} onOpenChange={(open) => !open && setDialog({ mode: "closed" })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog.mode === "rename" ? "Rename runtime profile" : "Save current runtime as a profile"}</DialogTitle>
            <DialogDescription>
              {dialog.mode === "rename"
                ? "Only the name and tier change; the saved runtime stays as it is."
                : "The agent's current harness, model, AI connection and default environment are captured. You can switch back to this setup later."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="runtime-profile-name">Profile name</Label>
              <Input
                id="runtime-profile-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. primary, economy, fallback"
                maxLength={60}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="runtime-profile-tier">Tier</Label>
              <select
                id="runtime-profile-tier"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                value={tier}
                onChange={(event) => setTier(event.target.value as AgentRuntimeProfileTier)}
              >
                {AGENT_RUNTIME_PROFILE_TIERS.map((value) => (
                  <option key={value} value={value}>
                    {tierLabel(value)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                The tier is a label for cost and routing intent. It does not change behavior yet.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog({ mode: "closed" })}>
              Cancel
            </Button>
            <Button onClick={submitDialog} disabled={!name.trim() || createMutation.isPending || renameMutation.isPending}>
              {dialog.mode === "rename" ? "Save changes" : "Save profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={activateDialog.open} onOpenChange={(open) => !open && setActivateDialog({ open: false })}>
        <DialogContent>
          {activateDialog.open ? (
            <>
              <DialogHeader>
                <DialogTitle>Activate runtime profile</DialogTitle>
                <DialogDescription>
                  The agent will run on this profile's harness, model, AI connection and environment. Sessions of the current profile stay parked; sessions saved under the target profile become resumable again.
                </DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm" data-testid="runtime-profile-preflight">
                <dt className="text-muted-foreground">Profile</dt>
                <dd>{activateDialog.profile.name}</dd>
                <dt className="text-muted-foreground">Harness</dt>
                <dd>{activateDialog.profile.adapterType}</dd>
                <dt className="text-muted-foreground">Model</dt>
                <dd>{profileModel(activateDialog.profile)}</dd>
                {activateDialog.preflight ? (
                  <>
                    <dt className="text-muted-foreground">Active runs</dt>
                    <dd>{activateDialog.preflight.activeRunCount}</dd>
                    <dt className="text-muted-foreground">Resumable sessions</dt>
                    <dd>{activateDialog.preflight.targetSessionCount}</dd>
                    <dt className="text-muted-foreground">Sessions parked</dt>
                    <dd>{activateDialog.preflight.currentSessionCount}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted-foreground">Checking</dt>
                    <dd>…</dd>
                  </>
                )}
              </dl>
              {activateDialog.cancelRuns ? (
                <p className="text-sm text-destructive">
                  Active runs will be cancelled before the switch.
                </p>
              ) : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => setActivateDialog({ open: false })}>
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    activateMutation.mutate({
                      profileId: activateDialog.profile.id,
                      cancelActiveRuns: activateDialog.cancelRuns,
                    })
                  }
                  disabled={activateMutation.isPending}
                >
                  {activateDialog.cancelRuns ? "Cancel runs and activate" : "Activate"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete runtime profile</DialogTitle>
            <DialogDescription>
              The saved runtime and every task session parked under this profile are removed. The agent's current runtime is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
              disabled={deleteMutation.isPending}
            >
              Delete profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
