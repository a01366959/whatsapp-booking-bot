export function buildRuntimeConfig(raw = {}, env = {}) {
  return {
    bubbleBaseUrl: raw.bubbleBaseUrl || "",
    bubbleToken: raw.bubbleToken || "",
    confirmEndpoint: raw.confirmEndpoint || "confirm_reserva",
    defaultSport: raw.defaultSport || "Padel",
    maxButtons: Number(raw.maxButtons || 3),
    mexicoTz: raw.mexicoTz || "America/Mexico_City",
    useAgent: raw.useAgent !== undefined ? Boolean(raw.useAgent) : true,
    messageBurstHoldMs: Number(raw.messageBurstHoldMs || env.MESSAGE_BURST_HOLD_MS || 1200),
    staffPhone: raw.staffPhone,
    bubbleArchiveUrl: raw.bubbleArchiveUrl,
    escalationWebhook: raw.escalationWebhook,
    decideModel: raw.decideModel || "gpt-4o",
    agentModel: raw.agentModel || "gpt-4o-mini",
    interpretModel: raw.interpretModel || "gpt-4o-mini",
    decideTemperature: Number(raw.decideTemperature ?? 0.8),
    decidePresencePenalty: Number(raw.decidePresencePenalty ?? 0.35),
    decideFrequencyPenalty: Number(raw.decideFrequencyPenalty ?? 0.3),
    historyWindow: Number(raw.historyWindow || 12)
  };
}
