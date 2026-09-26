// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AgentRuntimeProfile } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeProfilesPanel } from "./RuntimeProfilesPanel";
import { ApiError } from "@/api/client";

const mockPushToast = vi.hoisted(() => vi.fn());
const mockAgentsApi = vi.hoisted(() => ({
  runtimeProfiles: vi.fn(),
  createRuntimeProfile: vi.fn(),
  updateRuntimeProfile: vi.fn(),
  deleteRuntimeProfile: vi.fn(),
  preflightRuntimeProfile: vi.fn(),
  activateRuntimeProfile: vi.fn(),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@/api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Switcher",
    urlKey: "switcher",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: { model: "gpt-6-sol" },
    runtimeConfig: {},
    activeRuntimeProfileId: "profile-primary",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false, canCreateSkills: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-09-26T00:00:00.000Z"),
    updatedAt: new Date("2026-09-26T00:00:00.000Z"),
    ...overrides,
  };
}

function makeProfile(overrides: Partial<AgentRuntimeProfile> = {}): AgentRuntimeProfile {
  return {
    id: "profile-primary",
    companyId: "company-1",
    agentId: "agent-1",
    name: "primary",
    tier: "primary",
    adapterType: "codex_local",
    adapterConfig: { model: "gpt-6-sol" },
    runtimeConfig: {},
    defaultEnvironmentId: null,
    enabled: true,
    sortOrder: 0,
    lastActivatedAt: new Date("2026-09-26T00:00:00.000Z"),
    createdAt: new Date("2026-09-26T00:00:00.000Z"),
    updatedAt: new Date("2026-09-26T00:00:00.000Z"),
    ...overrides,
  };
}

const economy = makeProfile({
  id: "profile-economy",
  name: "economy",
  tier: "economy",
  adapterType: "opencode_local",
  adapterConfig: { model: "opencode-go/qwen3.8-flash" },
  lastActivatedAt: null,
  sortOrder: 1,
});

describe("RuntimeProfilesPanel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.runtimeProfiles.mockResolvedValue({
      activeRuntimeProfileId: "profile-primary",
      profiles: [makeProfile(), economy],
    });
  });

  afterEach(async () => {
    if (root) {
      await act(() => root!.unmount());
      root = null;
    }
    container.remove();
  });

  async function render(agent: Agent = makeAgent()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    root = createRoot(container);
    await act(() => {
      root!.render(
        <QueryClientProvider client={client}>
          <RuntimeProfilesPanel agent={agent} companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function button(label: string): HTMLButtonElement {
    const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!el) throw new Error(`button ${label} not found`);
    return el;
  }

  function buttonByText(text: string, scope: ParentNode = document): HTMLButtonElement {
    const el = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    if (!el) throw new Error(`button "${text}" not found`);
    return el;
  }

  function dialogButton(text: string): HTMLButtonElement {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("dialog not open");
    return buttonByText(text, dialog);
  }

  it("lists profiles, marks the active one and hides activate/delete for it", async () => {
    await render();

    const rows = container.querySelectorAll('[data-testid="runtime-profile-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("primary");
    expect(rows[0].textContent).toContain("Active");
    expect(rows[1].textContent).toContain("opencode_local · opencode-go/qwen3.8-flash");
    expect(document.querySelector('button[aria-label="Activate profile primary"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Delete profile primary"]')).toBeNull();
    expect(button("Activate profile economy")).toBeTruthy();
    expect(container.textContent).toContain("stored in the active profile");
  });

  it("captures the current runtime as a new profile", async () => {
    mockAgentsApi.createRuntimeProfile.mockResolvedValue(makeProfile({ id: "profile-new", name: "fallback", tier: "fallback" }));
    await render();

    await act(() => buttonByText("Save current as profile").click());
    await flushReact();
    const input = document.getElementById("runtime-profile-name") as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "fallback");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const select = document.getElementById("runtime-profile-tier") as HTMLSelectElement;
    await act(() => {
      select.value = "fallback";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(() => dialogButton("Save profile").click());
    await flushReact();

    expect(mockAgentsApi.createRuntimeProfile).toHaveBeenCalledWith(
      "agent-1",
      { name: "fallback", tier: "fallback" },
      "company-1",
    );
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Runtime profile saved" }));
  });

  it("shows the preflight summary and activates the profile", async () => {
    mockAgentsApi.preflightRuntimeProfile.mockResolvedValue({
      profileId: "profile-economy",
      isActive: false,
      activeRunCount: 0,
      targetSessionCount: 2,
      currentSessionCount: 1,
      harnessChanges: true,
      modelChanges: true,
    });
    mockAgentsApi.activateRuntimeProfile.mockResolvedValue(makeAgent({ adapterType: "opencode_local", activeRuntimeProfileId: "profile-economy" }));
    await render();

    await act(() => button("Activate profile economy").click());
    await flushReact();
    const summary = document.querySelector('[data-testid="runtime-profile-preflight"]');
    expect(summary?.textContent).toContain("Resumable sessions");
    expect(summary?.textContent).toContain("2");

    await act(() => dialogButton("Activate").click());
    await flushReact();

    expect(mockAgentsApi.activateRuntimeProfile).toHaveBeenCalledWith(
      "agent-1",
      "profile-economy",
      { cancelActiveRuns: false },
      "company-1",
    );
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Runtime profile activated" }));
  });

  it("offers to cancel active runs when the server refuses the switch", async () => {
    mockAgentsApi.preflightRuntimeProfile.mockResolvedValue({
      profileId: "profile-economy",
      isActive: false,
      activeRunCount: 1,
      targetSessionCount: 0,
      currentSessionCount: 0,
      harnessChanges: true,
      modelChanges: true,
    });
    mockAgentsApi.activateRuntimeProfile
      .mockRejectedValueOnce(new ApiError("active runs", 409, { error: "active runs", code: "agent_runs_active" }))
      .mockResolvedValueOnce(makeAgent({ activeRuntimeProfileId: "profile-economy" }));
    await render();

    await act(() => button("Activate profile economy").click());
    await flushReact();
    // The preflight already reported an active run, so the button offers the cancel-and-switch path.
    await act(() => dialogButton("Cancel runs and activate").click());
    await flushReact();

    expect(mockAgentsApi.activateRuntimeProfile).toHaveBeenLastCalledWith(
      "agent-1",
      "profile-economy",
      { cancelActiveRuns: true },
      "company-1",
    );
  });

  it("deletes an inactive profile after confirmation", async () => {
    mockAgentsApi.deleteRuntimeProfile.mockResolvedValue(undefined);
    await render();

    await act(() => button("Delete profile economy").click());
    await flushReact();
    await act(() => dialogButton("Delete profile").click());
    await flushReact();

    expect(mockAgentsApi.deleteRuntimeProfile).toHaveBeenCalledWith("agent-1", "profile-economy", "company-1");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Runtime profile deleted" }));
  });
});
