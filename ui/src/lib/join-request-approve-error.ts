/**
 * Plain-language copy for a failed join-request approval (zhtw.10 T6).
 *
 * The server refuses to approve a second OpenClaw join request for a gateway
 * that already has a live agent (409 `openclaw_gateway_duplicate_agent`). That
 * refusal is final until the operator archives the other agent or rejects the
 * request, so the message names the existing agent and says what to do.
 *
 * Presentation only: the server decides; this just explains its answer.
 */

import { t } from "@/i18n";
import { ApiError } from "../api/client";

function errorDetails(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (!body || typeof body !== "object") return null;
  const details = (body as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}

/** The duplicate-gateway explanation, or null when the error is something else. */
export function duplicateOpenClawAgentMessage(error: unknown): string | null {
  const details = errorDetails(error);
  if (details?.code !== "openclaw_gateway_duplicate_agent") return null;
  const name = typeof details.existingAgentName === "string" ? details.existingAgentName.trim() : "";
  const lead = name
    ? `${t("This OpenClaw is already connected to agent:")} ${name}`
    : t("This OpenClaw is already connected to another agent.");
  return `${lead} ${t("Archive or remove that agent first, or reject this join request.")}`;
}

export function joinRequestApproveErrorMessage(error: unknown): string {
  return duplicateOpenClawAgentMessage(error)
    ?? (error instanceof Error && error.message ? error.message : t("Failed to approve join request"));
}
