import { WorkflowEntrypoint } from "cloudflare:workers";

// 1. Workflow Definition: Handles asynchronous forwarding to Google Apps Script
export class WhatsAppWebhookWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { payload } = event.payload;

    await step.do("forward-to-apps-script", async () => {
      const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxH-Gm7-psKpEYJRl15rFPxAXEWmTiSL158GTG2tsIieqvEgW4ltTxpP3YMSe5926uy/exec"; // Paste your /exec URL

      const response = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Apps Script responded with status: ${response.status}`);
      }

      return await response.text();
    });
  }
}

// 2. HTTP Fetch Handler: Handles immediate Meta GET handshake and POST reception
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Meta Webhook Verification Handshake (GET)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      const VERIFY_TOKEN = "platina_dental_call_blueee"; // Must match Meta input

      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // Incoming WhatsApp Messages & Receipts (POST)
    if (request.method === "POST") {
      try {
        const body = await request.json();

        // Dispatch background processing to Workflow if configured
        if (env.WHATSAPP_WORKFLOW) {
          await env.WHATSAPP_WORKFLOW.create({
            params: { payload: body }
          });
        } else {
          // Fallback: direct background fetch without durable execution
          ctx.waitUntil(
            fetch("YOUR_GOOGLE_APPS_SCRIPT_EXEC_URL", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            })
          );
        }

        // Instantly signal Meta that the event was received
        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        return new Response("Invalid JSON", { status: 400 });
      }
    }

    return new Response("Method not allowed", { status: 405 });
  }
};
