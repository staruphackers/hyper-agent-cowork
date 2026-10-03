import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

// zhtw.10 D1-A: reusing an OpenClaw invite after its join request was approved
// may refresh the gateway token, but must not redirect the live agent.

const agentServiceMock = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalGrants: vi.fn(),
  }),
  agentService: () => agentServiceMock,
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn((name: string) => name),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

const liveConfig = {
  url: "ws://127.0.0.1:18789/",
  headers: { "x-openclaw-token": "old-gateway-token-1234567890" },
  devicePrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nLIVE\n-----END PRIVATE KEY-----\n",
};

function createDb() {
  const selectResults: unknown[][] = [
    [
      {
        id: "invite-1",
        companyId: "company-1",
        inviteType: "company_join",
        allowedJoinTypes: "agent",
        tokenHash: "hash",
        defaultsPayload: null,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        revokedAt: null,
        acceptedAt: new Date("2026-09-26T00:00:00.000Z"),
      },
    ],
    [
      {
        id: "request-1",
        inviteId: "invite-1",
        companyId: "company-1",
        requestType: "agent",
        status: "approved",
        adapterType: "openclaw_gateway",
        agentName: "Dahye",
        createdAgentId: "agent-1",
        agentDefaultsPayload: { url: liveConfig.url, headers: liveConfig.headers },
      },
    ],
  ];
  const approvedRow = {
    id: "request-1",
    inviteId: "invite-1",
    companyId: "company-1",
    requestType: "agent",
    status: "approved",
    adapterType: "openclaw_gateway",
    agentName: "Dahye",
    createdAgentId: "agent-1",
  };
  const chain = () => {
    const q: any = {
      set: vi.fn(() => q),
      where: vi.fn(() => q),
      returning: vi.fn(() => q),
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([approvedRow]).then(resolve),
    };
    return q;
  };
  const writes = { insert: vi.fn(chain), update: vi.fn(chain) };
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selectResults.shift() ?? []),
      }),
    }),
    insert: writes.insert,
    update: writes.update,
    transaction: vi.fn(),
  };
  return { db, writes };
}

function createApp(db: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "none", source: "none" };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /invites/:token/accept replay on an approved OpenClaw join request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentServiceMock.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Dahye",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: liveConfig,
    });
  });

  it.each([
    ["a new gateway URL", { url: "ws://127.0.0.1:28789/" }, ["url"]],
    [
      "a new key path and device auth turned off",
      { claimedApiKeyPath: "~/.openclaw/other-key.json", disableDeviceAuth: true },
      ["claimedApiKeyPath", "disableDeviceAuth"],
    ],
  ])("refuses %s and writes nothing", async (_label, change, fields) => {
    const { db, writes } = createDb();
    const res = await request(createApp(db))
      .post("/api/invites/invite-token/accept")
      .send({ requestType: "agent", adapterType: "openclaw_gateway", agentDefaultsPayload: change });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "openclaw_gateway_replay_locked_fields", fields });
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.insert).not.toHaveBeenCalled();
    expect(agentServiceMock.update).not.toHaveBeenCalled();
  });

  it("still lets OpenClaw refresh its gateway token, and keeps the approved device key", async () => {
    const { db } = createDb();
    agentServiceMock.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      id: "agent-1",
      companyId: "company-1",
      name: "Dahye",
      status: "idle",
      adapterType: "openclaw_gateway",
      ...patch,
    }));
    const res = await request(createApp(db))
      .post("/api/invites/invite-token/accept")
      .send({
        requestType: "agent",
        adapterType: "openclaw_gateway",
        agentDefaultsPayload: { headers: { "x-openclaw-token": "new-gateway-token-1234567890" } },
      });

    expect(agentServiceMock.update, JSON.stringify(res.body)).toHaveBeenCalledTimes(1);
    const patch = agentServiceMock.update.mock.calls[0]?.[1] as { adapterConfig: Record<string, any> };
    expect(patch.adapterConfig.headers["x-openclaw-token"]).toBe("new-gateway-token-1234567890");
    expect(patch.adapterConfig.devicePrivateKeyPem).toBe(liveConfig.devicePrivateKeyPem);
    expect(patch.adapterConfig.url).toBe(liveConfig.url);
  });
});
