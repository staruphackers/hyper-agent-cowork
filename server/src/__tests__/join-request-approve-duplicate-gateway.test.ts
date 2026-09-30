import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

// zhtw.10 T6: approving a second OpenClaw join request for a gateway that
// already has a live agent is refused (409) before anything is written.

const accessServiceMock = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));
const agentServiceMock = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => accessServiceMock,
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

function joinRequest(url: string) {
  return {
    id: "request-2",
    companyId: "company-1",
    inviteId: "invite-1",
    requestType: "agent",
    status: "pending_approval",
    adapterType: "openclaw_gateway",
    agentName: "Second Dahye",
    createdAgentId: null,
    agentDefaultsPayload: { url, headers: { "x-openclaw-token": "gateway-token-1234567890" } },
  };
}

function createDb(url: string) {
  const selectResults: unknown[][] = [
    [joinRequest(url)],
    [{ id: "invite-1", companyId: "company-1", defaultsPayload: null }],
  ];
  const writes = { insert: vi.fn(), update: vi.fn() };
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
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    };
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

describe("POST /companies/:companyId/join-requests/:requestId/approve (duplicate OpenClaw gateway)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentServiceMock.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "Dahye",
        status: "idle",
        role: "ceo",
        reportsTo: null,
        adapterType: "openclaw_gateway",
        adapterConfig: { url: "wss://openclaw.example.test/" },
      },
    ]);
  });

  it.each([
    ["the same URL", "wss://openclaw.example.test"],
    ["ws instead of wss", "ws://OpenClaw.example.test/"],
  ])("refuses a second agent for %s and writes nothing", async (_label, url) => {
    const { db, writes } = createDb(url);
    const res = await request(createApp(db)).post("/api/companies/company-1/join-requests/request-2/approve").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({
      code: "openclaw_gateway_duplicate_agent",
      existingAgentId: "agent-1",
      existingAgentName: "Dahye",
    });
    expect(agentServiceMock.create).not.toHaveBeenCalled();
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
  });
});
