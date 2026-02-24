export function parseAmbiguousHour(text, normalizeText) {
  const normalized = normalizeText(text || "").trim();
  if (!normalized) return null;
  if (normalized.includes(":")) return null;
  if (/\b(am|pm|manana|mañana|noche|tarde|mediodia|medio\s*dia)\b/.test(normalized)) return null;
  const match = normalized.match(/^(?:a\s*las\s*)?(\d{1,2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour < 1 || hour > 12) return null;
  return hour;
}

export function inferAmbiguousTime(text, session, { normalizeText, getMexicoDateParts }) {
  const hour = parseAmbiguousHour(text, normalizeText);
  if (hour === null) return null;

  const { dateStr, hour: nowHour } = getMexicoDateParts();
  const bookingDate = session?.bookingDraft?.date || null;
  const historyText = normalizeText(session?.messages?.map(m => m.content).join(" ") || "");
  const currentText = normalizeText(text || "");
  const isTodayContext = bookingDate === dateStr || /\bhoy\b/i.test(`${historyText} ${currentText}`);
  if (!isTodayContext) return null;

  let assumedHour = hour;
  if (hour < nowHour && hour + 12 <= 23) {
    assumedHour = hour + 12;
  }

  return `${String(assumedHour).padStart(2, "0")}:00`;
}

export function isCourtesyOnlyMessage(text, normalizeText, courtesyPhrases = []) {
  const normalized = normalizeText(text || "")
    .toLowerCase()
    .replace(/[!?.,;:¡¿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;
  return courtesyPhrases.includes(normalized);
}

export function buildCourtesyReply(session) {
  const name = session?.user?.name || session?.bookingDraft?.name || "";
  const suffix = name ? `, ${name}` : "";
  return `¡Con gusto${suffix}! Aquí estoy si necesitas algo más.`;
}

export function dateKeyInMexicoFromEpoch(epochMs, mexicoTz) {
  if (!epochMs) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: mexicoTz || "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(epochMs));
}

export function getSelectedReta(session) {
  const eventId = session?.retaDraft?.eventId;
  const retas = Array.isArray(session?.retas) ? session.retas : [];
  if (!eventId) return null;
  return retas.find(r => r.eventId === eventId) || null;
}

export function hasRetaSignupIntent(text, normalizeText, retaSignupRegex) {
  const t = normalizeText(text || "");
  return retaSignupRegex.test(t);
}

export function resolveRetaSelectionFromText(
  text,
  session,
  { normalizeText, getMexicoDateParts, mexicoTz }
) {
  const retas = Array.isArray(session?.retas) ? session.retas : [];
  if (!retas.length) return null;

  const normalized = normalizeText(text || "");
  if (!normalized) return null;

  const byId = retas.find(r => normalized.includes(normalizeText(r.eventId || "")));
  if (byId) return byId;

  const ordered = [...retas].sort((a, b) => (a.dateMs || 0) - (b.dateMs || 0));
  const ordinalMap = [
    { n: 1, rx: /\b(1|uno|primera|primer)\b/ },
    { n: 2, rx: /\b(2|dos|segunda|segundo)\b/ },
    { n: 3, rx: /\b(3|tres|tercera|tercero)\b/ }
  ];
  for (const ord of ordinalMap) {
    if (ord.rx.test(normalized) && ordered[ord.n - 1]) return ordered[ord.n - 1];
  }

  const today = getMexicoDateParts().dateStr;
  if (/\bhoy\b/.test(normalized)) {
    const todayMatches = ordered.filter(r => dateKeyInMexicoFromEpoch(r.dateMs, mexicoTz) === today);
    if (todayMatches.length === 1) return todayMatches[0];
  }

  if (/\bmanana|mañana\b/.test(normalized)) {
    const now = new Date(`${today}T00:00:00Z`).getTime();
    const tomorrow = dateKeyInMexicoFromEpoch(now + 24 * 60 * 60 * 1000, mexicoTz);
    const tomorrowMatches = ordered.filter(r => dateKeyInMexicoFromEpoch(r.dateMs, mexicoTz) === tomorrow);
    if (tomorrowMatches.length === 1) return tomorrowMatches[0];
  }

  const nameMatches = ordered.filter(r => normalizeText(r.name).includes(normalized));
  if (nameMatches.length === 1) return nameMatches[0];

  return null;
}

export function buildSyntheticToolCall(name, args) {
  return {
    id: `auto_${name}_${Date.now()}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}
