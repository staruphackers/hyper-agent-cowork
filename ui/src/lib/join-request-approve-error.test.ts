import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { ApiError } from "../api/client";
import { duplicateOpenClawAgentMessage, joinRequestApproveErrorMessage } from "./join-request-approve-error";

const duplicate = () =>
  new ApiError("Agent \"Dahye\" is already connected to this OpenClaw gateway.", 409, {
    error: "Agent \"Dahye\" is already connected to this OpenClaw gateway.",
    details: { code: "openclaw_gateway_duplicate_agent", existingAgentId: "agent-1", existingAgentName: "Dahye" },
  });

describe("join request approval errors", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("names the existing agent and what to do when the gateway already has one", () => {
    const message = joinRequestApproveErrorMessage(duplicate());
    expect(message).toContain("Dahye");
    expect(message).toContain("Archive or remove that agent first, or reject this join request.");
  });

  it("shows the explanation in Traditional Chinese for zh-TW users", async () => {
    await i18n.changeLanguage("zh-TW");
    const message = joinRequestApproveErrorMessage(duplicate());
    expect(message).toBe("這個 OpenClaw 已經連接到代理人： Dahye 請先封存或移除那個代理人，或拒絕這個加入申請。");
  });

  it("falls back to the server message for other errors", () => {
    const other = new ApiError("Join request is not pending", 409, { error: "Join request is not pending" });
    expect(duplicateOpenClawAgentMessage(other)).toBeNull();
    expect(joinRequestApproveErrorMessage(other)).toBe("Join request is not pending");
  });
});
