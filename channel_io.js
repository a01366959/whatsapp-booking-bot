export function createChannelIO({ senders, logger, getFlowToken, logEvent, logMessage }) {
  async function safeSendText(to, text, flowToken) {
    if (!to) return { ok: false, error: "missing_to" };
    if (flowToken) {
      const current = await getFlowToken(to);
      if (current && current !== flowToken) return { ok: false, error: "stale_flow" };
    }
    try {
      if (!senders?.text) throw new Error("text sender not configured");
      await senders.text(to, text);
      await logEvent("send_text", { to, text });
      await logMessage(to, {
        sender: "ai",
        text,
        metadata: { type: "text" }
      });
      return { ok: true };
    } catch (err) {
      logger?.error?.("sendText failed", err?.response?.data || err?.message || err);
      await logEvent("send_text_error", { to, message: err?.message || "unknown" });
      return { ok: false, error: "sendText_failed" };
    }
  }

  async function safeSendButtons(to, text, buttons, flowToken) {
    if (!to) return { ok: false, error: "missing_to" };
    if (flowToken) {
      const current = await getFlowToken(to);
      if (current && current !== flowToken) return { ok: false, error: "stale_flow" };
    }
    try {
      if (!senders?.buttons) throw new Error("buttons sender not configured");
      await senders.buttons(to, text, buttons);
      await logEvent("send_buttons", { to, text, buttons });
      return { ok: true };
    } catch (err) {
      logger?.error?.("sendButtons failed", err?.response?.data || err?.message || err);
      await logEvent("send_buttons_error", { to, message: err?.message || "unknown" });
      return { ok: false, error: "sendButtons_failed" };
    }
  }

  async function safeSendLocation(to, latitude, longitude, name, address, flowToken) {
    if (!to) return { ok: false, error: "missing_to" };
    if (flowToken) {
      const current = await getFlowToken(to);
      if (current && current !== flowToken) return { ok: false, error: "stale_flow" };
    }
    try {
      if (!senders?.location) {
        logger?.warn?.("location sender not configured, sending as text");
        await safeSendText(to, `📍 ${name}\n${address}`, flowToken);
        return { ok: true };
      }
      await senders.location(to, { latitude, longitude, name, address });
      await logEvent("send_location", { to, name, address });
      await logMessage(to, {
        sender: "ai",
        text: `📍 ${name}\n${address}`,
        metadata: { type: "location", latitude, longitude }
      });
      return { ok: true };
    } catch (err) {
      logger?.error?.("sendLocation failed", err?.response?.data || err?.message || err);
      logger?.warn?.("falling back to text message for location");
      await safeSendText(to, `📍 ${name}\n${address}`, flowToken);
      return { ok: true };
    }
  }

  async function safeSendList(to, bodyText, buttonText, sections, flowToken) {
    if (!to) return { ok: false, error: "missing_to" };
    if (flowToken) {
      const current = await getFlowToken(to);
      if (current && current !== flowToken) return { ok: false, error: "stale_flow" };
    }
    try {
      if (!senders?.list) {
        logger?.warn?.(`[LIST] sender not configured, falling back to text. Sections: ${sections.length}`);
        const allOptions = sections.flatMap(section => section.rows.map(row => row.title)).join(", ");
        await safeSendText(to, `${bodyText}\n\n${allOptions}`, flowToken);
        return { ok: true };
      }
      logger?.info?.(`[LIST] Sending list with ${sections[0]?.rows?.length || 0} options to ${to}`);
      await senders.list(to, bodyText, buttonText, sections);
      await logEvent("send_list", { to, bodyText, sectionsCount: sections.length });
      const options = sections.flatMap(section => section.rows.map(row => row.title)).join(", ");
      await logMessage(to, {
        sender: "ai",
        text: `${bodyText}\n\nOpciones: ${options}`,
        metadata: { type: "list", sectionsCount: sections.length }
      });
      return { ok: true };
    } catch (err) {
      logger?.error?.(`[LIST] sendList failed: ${err?.message}`, err?.response?.data || err);
      logger?.warn?.("[LIST] falling back to text message");
      const allOptions = sections.flatMap(section => section.rows.map(row => row.title)).join(", ");
      await safeSendText(to, `${bodyText}\n\n${allOptions}`, flowToken);
      return { ok: true };
    }
  }

  return {
    safeSendText,
    safeSendButtons,
    safeSendLocation,
    safeSendList
  };
}
