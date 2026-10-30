import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowStep,
  type WorkflowEvent,
} from "cloudflare:workers";

export class WorkflowStatusDO extends DurableObject {
  async updateStep(_stepName?: string, _status?: string): Promise<void> {
    // no-op
  }

  async setStatus(_status?: string): Promise<void> {
    // no-op
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response("OK");
  }
}

type WorkflowPayload = {
  payload: Record<string, unknown>;
};

export interface Env {
  WHATSAPP_WORKFLOW?: Workflow;
  APPS_SCRIPT_URL?: string;
  VERIFY_TOKEN?: string;
}

export class WhatsAppWebhookWorkflow extends WorkflowEntrypoint<Env, WorkflowPayload> {
  async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<void> {
    const { payload } = event.payload;

    await step.do("forward-to-apps-script", async () => {
      const scriptUrl =
        this.env.APPS_SCRIPT_URL || "YOUR_GOOGLE_APPS_SCRIPT_EXEC_URL";

      const response = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Apps Script responded with status: ${response.status}`);
      }

      return await response.text();
    });
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

// Meta Webhook Verification Handshake (GET)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      const verifyToken = env.VERIFY_TOKEN || "platina_webhook_secure_2026";

      if (mode === "subscribe" && token === verifyToken && challenge) {
        return new Response(challenge, {
          status: 200,
          headers: { 
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache"
          },
        });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json()) as Record<string, unknown>;

        if (env.WHATSAPP_WORKFLOW) {
          await env.WHATSAPP_WORKFLOW.create({
            params: { payload: body },
          });
        } else {
          const scriptUrl =
            env.APPS_SCRIPT_URL || "YOUR_GOOGLE_APPS_SCRIPT_EXEC_URL";

          ctx.waitUntil(
            fetch(scriptUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
          );
        }

        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
