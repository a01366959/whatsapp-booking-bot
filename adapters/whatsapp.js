/*
  adapters/whatsapp.js

  Thin WhatsApp adapter skeleton. Converts incoming webhook payloads to the
  agent core event shape and renders actions back to the WhatsApp API using
  provided sender functions.

  To use: import and call `createWhatsAppAdapter({ agentCore, sendText, sendButtons })`
*/

export function createWhatsAppAdapter({ agentCore }) {
  if (!agentCore?.handleIncoming) throw new Error("agentCore.handleIncoming is required");

  async function handleWebhook(req, res) {
    try {
      const entry = req.body.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      if (!msg) return res.sendStatus(200);

      const phone = (msg.from || "").replace(/\D/g, "").slice(-10);
      const text =
        msg.text?.body ||
        msg.button?.text ||
        msg.interactive?.button_reply?.title ||
        msg.interactive?.button_reply?.id ||
        "";

      const event = {
        channel: "whatsapp",
        phone,
        text,
        raw: msg,
        msgId: msg.id,
        ts: Number(msg.timestamp || 0),
        meta: { entry }
      };

      await agentCore.handleIncoming(event);
      return res.sendStatus(200);
    } catch (err) {
      console.error("WhatsApp adapter error", err?.message || err);
      return res.sendStatus(500);
    }
  }

  return { handleWebhook };
}

export default { createWhatsAppAdapter };
