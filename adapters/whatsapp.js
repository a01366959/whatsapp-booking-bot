/*
  adapters/whatsapp.js

  Thin WhatsApp adapter skeleton. Converts incoming webhook payloads to the
  agent core event shape and renders actions back to the WhatsApp API using
  provided sender functions.

  To use: import and call `createWhatsAppAdapter({ agentCore, sendText, sendButtons })`
*/

export function createWhatsAppAdapter({ agentCore }) {
  if (!agentCore?.handleIncoming) throw new Error("agentCore.handleIncoming is required");

  const SUPPORTED_MESSAGE_TYPES = new Set(["text", "button", "interactive"]);
  const IGNORED_MESSAGE_TYPES = new Set([
    "reaction",
    "sticker",
    "image",
    "audio",
    "video",
    "document",
    "location",
    "contacts",
    "system"
  ]);

  async function handleWebhook(req, res) {
    try {
      const entry = req.body.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      if (!msg) return res.sendStatus(200);

      const msgType = msg.type || "";
      const isReaction = msgType === "reaction" || Boolean(msg.reaction);
      const isSticker = msgType === "sticker" || Boolean(msg.sticker);
      if (isReaction || isSticker) return res.sendStatus(200);
      if (msgType && IGNORED_MESSAGE_TYPES.has(msgType)) return res.sendStatus(200);

      const phone = (msg.from || "").replace(/\D/g, "").slice(-10);
      const text =
        msg.text?.body ||
        msg.button?.text ||
        msg.interactive?.button_reply?.title ||
        msg.interactive?.button_reply?.id ||
        msg.interactive?.list_reply?.title ||
        msg.interactive?.list_reply?.id ||
        "";

      const hasSupportedType = !msgType || SUPPORTED_MESSAGE_TYPES.has(msgType);
      const cleanText = text.trim();
      if (!hasSupportedType || !cleanText) return res.sendStatus(200);

      console.log(`[WhatsApp Adapter] Processing ${msgType} from ${phone.slice(-4)} | Text: "${cleanText.substring(0, 50)}..."`);

      const event = {
        channel: "whatsapp",
        phone,
        text: cleanText,
        raw: msg,
        msgId: msg.id,
        ts: Number(msg.timestamp || 0),
        meta: { entry, messageType: msgType || "text" }
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
