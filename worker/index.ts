
import {
  WorkflowEntrypoint,
  type WorkflowStep,
  type WorkflowEvent,
} from "cloudflare:workers";

export interface Env {
  WHATSAPP_WORKFLOW: Workflow<WorkflowPayload>;

  APPS_SCRIPT_URL: string;

  VERIFY_TOKEN: string;
  META_APP_SECRET: string;
  APPS_SCRIPT_HMAC_SECRET: string;
}

type WorkflowPayload = {
  rawBody: string;
  workflowId: string;
};

function jsonResponse(
  body: Record<string, unknown>,
  status = 200
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const hex = signatureHeader.slice(7);

  if (!/^[a-fA-F0-9]{64}$/.test(hex)) return false;

  const signature = new Uint8Array(
    hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(rawBody)
  );
}

async function signForAppsScript(
  timestamp: string,
  workflowId: string,
  rawBody: string,
  secret: string
): Promise<string> {
  const message = `${timestamp}.${workflowId}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class WhatsAppWebhookWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowPayload
> {
  async run(
    event: WorkflowEvent<WorkflowPayload>,
    step: WorkflowStep
  ): Promise<void> {
    const { rawBody, workflowId } = event.payload;

    await step.do(
      "forward-authenticated-event-to-apps-script",
      {
        retries: {
          limit: 5,
          delay: "10 seconds",
          backoff: "exponential",
        },
        timeout: "2 minutes",
      },
      async () => {
        const timestamp = String(Math.floor(Date.now() / 1000));

        const signature = await signForAppsScript(
          timestamp,
          workflowId,
          rawBody,
          this.env.APPS_SCRIPT_HMAC_SECRET
        );

        const envelope = {
          relay: "platina-cloudflare",
          timestamp,
          eventId: workflowId,
          rawBody,
          signature,
        };

        const response = await fetch(this.env.APPS_SCRIPT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(envelope),
          redirect: "follow",
        });

        const responseText = await response.text();

        if (!response.ok) {
          throw new Error(
            `Apps Script HTTP ${response.status}: ${responseText.slice(0, 500)}`
          );
        }

        let result: { ok?: boolean; error?: string };

        try {
          result = JSON.parse(responseText);
        } catch {
          throw new Error(
            `Apps Script returned an unexpected response: ${responseText.slice(0, 300)}`
          );
        }

        if (result.ok !== true) {
          throw new Error(
            `Apps Script processing failed: ${result.error || "Unknown error"}`
          );
        }

        return {
          success: true,
          eventId: workflowId,
        };
      }
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url = new URL(request.url);

    // Meta webhook verification
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (
        mode === "subscribe" &&
        token === env.VERIFY_TOKEN &&
        challenge
      ) {
        return new Response(challenge, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    }

    try {
      // Read original bytes as text BEFORE parsing JSON.
      const rawBody = await request.text();

      if (!rawBody || rawBody.length > 1_000_000) {
        return jsonResponse({ ok: false, error: "Invalid body size" }, 413);
      }

      // Authenticate Meta.
      const validSignature = await verifyMetaSignature(
        rawBody,
        request.headers.get("X-Hub-Signature-256"),
        env.META_APP_SECRET
      );

      if (!validSignature) {
        return jsonResponse(
          { ok: false, error: "Invalid webhook signature" },
          401
        );
      }

      // Validate JSON structure.
      let body: Record<string, unknown>;

      try {
        body = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
      }

      if (
        body.object !== "whatsapp_business_account" ||
        !Array.isArray(body.entry)
      ) {
        return jsonResponse(
          { ok: false, error: "Unexpected webhook payload" },
          400
        );
      }

      // Deterministic ID: exact duplicate body = same Workflow ID.
      const hash = await sha256Hex(rawBody);
      const workflowId = `wa-${hash}`;

      try {
        await env.WHATSAPP_WORKFLOW.create({
          id: workflowId,
          params: {
            rawBody,
            workflowId,
          },
        });
      } catch (createError) {
        // If this Workflow already exists, the delivery was accepted earlier.
        try {
          await env.WHATSAPP_WORKFLOW.get(workflowId);
          return new Response("EVENT_ALREADY_ACCEPTED", {
            status: 200,
          });
        } catch {
          throw createError;
        }
      }

      return new Response("EVENT_RECEIVED", {
        status: 200,
      });
    } catch (error) {
      // Return a failure so Meta can retry if the event wasn't accepted.
      // Do not log the body, signature, or patient information.
      console.error(
        "Webhook acceptance error:",
        error instanceof Error ? error.message : "Unknown error"
      );

      return jsonResponse(
        { ok: false, error: "Webhook processing could not be accepted" },
        503
      );
    }
  },
};
