export function createAgentTools({
  bubbleRequest,
  normalizePhone,
  getMexicoDateParts,
  toBubbleDate,
  normalizeText,
  monthIndex,
  config,
  logger
}) {
  function toEpochMs(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num > 1e12 ? num : num * 1000;
  }

  function formatEventDateEs(value) {
    const epochMs = toEpochMs(value);
    if (!epochMs) return "fecha por confirmar";
    return new Intl.DateTimeFormat("es-MX", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: config.mexicoTz || "America/Mexico_City"
    }).format(new Date(epochMs));
  }

  function normalizeRetaRecord(reta) {
    const rawName = reta?.["Public name"] || reta?.Name || "Reta";
    const name = String(rawName).trim();
    const eventId = reta?._id || null;
    const fixedPair = Boolean(reta?.["Pareja Fija"]);
    const mode = fixedPair ? "pareja fija" : "individual";
    return {
      eventId,
      name,
      mode,
      dateLabel: formatEventDateEs(reta?.["Date inicio"]),
      dateMs: toEpochMs(reta?.["Date inicio"]) || 0,
      price: reta?.price_per_event ?? null,
      raw: reta
    };
  }

  function filterRetasByIntent(retas, queryText) {
    const normalized = normalizeText(queryText || "");
    if (!normalized) return retas;

    let filtered = [...retas];
    if (/pareja\s+fija/.test(normalized)) {
      filtered = filtered.filter(r => r.mode === "pareja fija");
    } else if (/individual/.test(normalized)) {
      filtered = filtered.filter(r => r.mode === "individual");
    }

    const monthHit = Object.entries(monthIndex).find(([monthName]) => new RegExp(`\\b${monthName}\\b`).test(normalized));
    if (monthHit) {
      const monthNum = monthHit[1];
      const monthFiltered = filtered.filter(r => {
        if (!r.dateMs) return false;
        return new Date(r.dateMs).getUTCMonth() + 1 === monthNum;
      });
      if (monthFiltered.length > 0) filtered = monthFiltered;
    }

    const nameFiltered = filtered.filter(r => normalizeText(r.name).includes(normalized));
    if (nameFiltered.length > 0) filtered = nameFiltered;

    return filtered;
  }

  async function findUser(phone) {
    const r = await bubbleRequest("get", "/get_user", { params: { phone } });
    return r.data?.response || { found: false };
  }

  async function getAvailableHours(date, desiredSport) {
    const bubbleDate = toBubbleDate(date);
    const { hour, dateStr } = getMexicoDateParts();
    const dateOnly = (date || "").includes("T") ? String(date).slice(0, 10) : String(date || "");
    const currentTimeNumber = dateOnly && dateOnly === dateStr ? hour : 0;
    const r = await bubbleRequest("get", "/get_hours", {
      params: {
        sport: desiredSport || config.defaultSport,
        date: bubbleDate,
        current_time_number: currentTimeNumber
      }
    });
    return r.data?.response?.hours || [];
  }

  async function getRetas() {
    const r = await bubbleRequest("get", "/get_retas");
    const found = Boolean(r.data?.response?.found);
    const retas = Array.isArray(r.data?.response?.retas) ? r.data.response.retas : [];
    if (!found || retas.length === 0) return [];
    return retas;
  }

  async function confirmRetaUser(eventId, userId) {
    const body = { event: eventId, users: [userId] };
    const r = await bubbleRequest("post", "/confirm_reta_user", { data: body });
    return r.data?.response?.response || "ok";
  }

  async function confirmRetaGuest(eventId, guest) {
    const body = {
      event: eventId,
      name: guest.name,
      last_name: guest.lastName,
      phone: normalizePhone(guest.phone)
    };
    const r = await bubbleRequest("post", "/confirm_reta_guest", { data: body });
    return r.data?.response?.response || "ok";
  }

  async function confirmBooking(phone, date, times, court, name, lastName, userId, sport, userType) {
    const bubbleDate = toBubbleDate(date);
    const basePayload = {
      phone,
      date: bubbleDate,
      time: times,
      court,
      sport: sport || config.defaultSport,
      user_type: userType
    };
    if (name) basePayload.name = name;
    if (lastName) basePayload.last_name = lastName;
    const withUser = userId ? { ...basePayload, user: userId } : basePayload;
    try {
      const res = await bubbleRequest("post", `/${config.confirmEndpoint}`, { data: withUser });
      const apiError = res?.data?.response?.error;
      if (apiError) {
        const err = new Error(apiError);
        err.code = "slot_taken";
        throw err;
      }
    } catch (err) {
      logger?.error?.("confirmBooking failed", {
        baseURL: config.bubbleBaseUrl,
        url: err?.config?.url,
        method: err?.config?.method,
        statusCode: err?.response?.status,
        data: err?.response?.data
      });
      if (userId && err?.code !== "slot_taken") {
        await bubbleRequest("post", `/${config.confirmEndpoint}`, { data: basePayload });
        return;
      }
      throw err;
    }
  }

  return {
    findUser,
    getAvailableHours,
    getRetas,
    confirmRetaUser,
    confirmRetaGuest,
    confirmBooking,
    normalizeRetaRecord,
    filterRetasByIntent
  };
}
