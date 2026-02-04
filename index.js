/******************************************************************
 * FULL AI AGENT — WHATSAPP (REDIS FIXED)
 ******************************************************************/
import express from "express";
import axios from "axios";
import OpenAI from "openai";
import { Redis } from "@upstash/redis";

const app = express();
app.use(express.json());

/******************************************************************
 * CLIENTS
 ******************************************************************/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

/******************************************************************
 * CONSTANTS
 ******************************************************************/
const WHATSAPP_API = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
const BUBBLE = `${process.env.BUBBLE_BASE_URL}/api/1.1/wf`;
const DEFAULT_SPORT = "padel";
const MAX_BUTTONS = 3;

/******************************************************************
 * SYSTEM PROMPT (AGENTE)
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres un recepcionista humano de Black Padel & Pickleball (México).

REGLAS DURAS:
- NO repitas saludos
- NO inventes información
- NO respondas programación, código, temas técnicos, ilegales o fuera del club
- Si preguntan algo fuera del club, responde educadamente que solo ayudas con temas del club
- Si ya hay fecha, NO la pidas otra vez
- Si ya hay horarios, NO preguntes horas
- Si necesitas datos, pregunta de forma breve y natural

HERRAMIENTAS:
- find_user: obtener nombre del cliente por teléfono
- get_available_hours: horarios disponibles por fecha

Usa herramientas cuando ayuden. Si no tienes información, dilo.
Responde en español, corto y claro.
`
};

/******************************************************************
 * HELPERS
 ******************************************************************/
const normalizePhone = p => p.replace(/\D/g, "");

const resolveDate = text => {
  const t = text.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (t.includes("hoy")) return today.toISOString().slice(0, 10);
  if (t.includes("mañana") || t.includes("manana")) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return null;
};

const toBubbleDate = dateStr => {
  if (!dateStr) return null;
  if (dateStr.includes("T")) return dateStr;
  return `${dateStr}T00:00:00Z`;
};

const extractTime = text => {
  const m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!m) return null;
  const hh = m[1].padStart(2, "0");
  const mm = m[2];
  return `${hh}:${mm}`;
};

const isGreeting = text =>
  /\b(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|hey|que\s+tal)\b/i.test(text);

const hasBookingIntent = text =>
  /\b(reservar|reserva|agendar|agenda|apart(ar)?|cancha|horario)\b/i.test(text);

const isYes = text => /\b(s[ií]|ok|vale|confirmo|confirmar|de acuerdo|adelante)\b/i.test(text);
const isNo = text => /\b(no|cancelar|mejor no|todav[ií]a no)\b/i.test(text);

const formatDateEs = dateStr => {
  if (!dateStr) return "";
  const d = new Date(dateStr.includes("T") ? dateStr : `${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(d);
};
/******************************************************************
 * REDIS SESSION
 ******************************************************************/
const getSession = phone => redis.get(`session:${phone}`);
const saveSession = (phone, session) =>
  redis.set(`session:${phone}`, session, { ex: 1800 });
const clearSession = phone => redis.del(`session:${phone}`);

const markMessageProcessed = async id =>
  redis.set(`msg:${id}`, 1, { nx: true, ex: 3600 });

/******************************************************************
 * BUBBLE
 ******************************************************************/
async function findUser(phone) {
  const r = await axios.get(`${BUBBLE}/find_user`, { params: { phone } });
  return r.data?.response || { found: false };
}

async function getAvailableHours(date) {
  const bubbleDate = toBubbleDate(date);
  const r = await axios.get(`${BUBBLE}/get_available_hours`, {
    params: { sport: DEFAULT_SPORT, date: bubbleDate }
  });

  return [...new Set(r.data.response.hours)].sort();
}

async function confirmBooking(phone, date, time, name) {
  const bubbleDate = toBubbleDate(date);
  const payload = { phone, date: bubbleDate, hour: time };
  if (name) payload.name = name;
  await axios.post(`${BUBBLE}/confirm_booking`, payload);
}

/******************************************************************
 * OPENAI (AGENT LOOP)
 ******************************************************************/
const TOOLS = [
  {
    type: "function",
    function: {
      name: "find_user",
      description: "Buscar usuario por teléfono para obtener nombre.",
      parameters: {
        type: "object",
        properties: { phone: { type: "string" } },
        required: ["phone"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_available_hours",
      description: "Obtener horarios disponibles para una fecha.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          sport: { type: "string" }
        },
        required: ["date"],
        additionalProperties: false
      }
    }
  },
];

async function runAgent(session, userText) {
  const context = [
    SYSTEM_MESSAGE,
    {
      role: "system",
      content: `Contexto actual:
- phone: ${session.phone}
- user_found: ${session.user?.found ? "si" : "no"}
- user_name: ${session.user?.name || "desconocido"}
- date: ${session.date || "null"}
- hours: ${session.hours?.length ? session.hours.join(", ") : "null"}`
    },
    ...session.messages
  ];

  const messages = [...context, { role: "user", content: userText }];
  let finalText = null;
  let guard = 0;

  while (!finalText && guard < 4) {
    guard += 1;
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.2
    });

    const msg = response.choices[0]?.message;
    if (!msg) break;

    if (msg.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls
      });

      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }

        let result = { ok: false };
        if (name === "find_user") {
          result = await findUser(args.phone);
          session.user = result;
        } else if (name === "get_available_hours") {
          const date = args.date || session.date;
          if (!date) {
            result = { ok: false, error: "missing_date" };
          } else {
            session.date = date;
            const hours = await getAvailableHours(date);
            session.hours = hours;
            session.hoursSent = false;
            session.justFetchedHours = true;
            result = { ok: true, date, hours };
          }
        } else {
          result = { ok: false, error: "unknown_tool" };
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result)
        });
      }
    } else {
      finalText = msg.content?.trim() || "¿Te ayudo con algo del club?";
      messages.push({ role: "assistant", content: finalText });
    }
  }

  return { finalText: finalText || "¿Te ayudo con algo del club?", messages };
}

/******************************************************************
 * WHATSAPP
 ******************************************************************/
const sendText = (to, text) =>
  axios.post(
    WHATSAPP_API,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );

const sendButtons = (to, text, buttons) =>
  axios.post(
    WHATSAPP_API,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: { buttons }
      }
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );

async function safeSendText(to, text) {
  if (!to) return { ok: false, error: "missing_to" };
  try {
    await sendText(to, text);
    return { ok: true };
  } catch (err) {
    console.error("sendText failed", err?.response?.data || err?.message || err);
    return { ok: false, error: "sendText_failed" };
  }
}

async function safeSendButtons(to, text, buttons) {
  if (!to) return { ok: false, error: "missing_to" };
  try {
    await sendButtons(to, text, buttons);
    return { ok: true };
  } catch (err) {
    console.error("sendButtons failed", err?.response?.data || err?.message || err);
    return { ok: false, error: "sendButtons_failed" };
  }
}

/******************************************************************
 * WEBHOOK
 ******************************************************************/
app.post("/webhook", async (req, res) => {
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const msgId = msg.id;
  if (msgId) {
    const firstTime = await markMessageProcessed(msgId);
    if (!firstTime) return res.sendStatus(200);
  }

  const phone = normalizePhone(msg.from);
  const text =
    msg.text?.body ||
    msg.button?.text ||
    msg.interactive?.button_reply?.title ||
    msg.interactive?.button_reply?.id ||
    "";
  const normalizedText = text.trim().toLowerCase();

  let session = await getSession(phone);
  const isNewSession = !session;

  if (!session) {
    session = {
      phone,
      messages: [],
      user: null,
      date: null,
      hours: null,
      hoursSent: false,
      pendingTime: null,
      pendingConfirm: null,
      justFetchedHours: false
    };
  }
  session.phone = phone;
  session.justFetchedHours = false;

  // Reset manual para pruebas
  if (normalizedText === "reset") {
    await clearSession(phone);
    await safeSendText(phone, "Listo, reinicié la conversación.");
    return res.sendStatus(200);
  }

  // Fecha directa (sin IA)
  if (!session.date) {
    const d = resolveDate(text);
    if (d) session.date = d;
  }

  // Si estamos esperando confirmación final
  if (session.pendingConfirm) {
    if (isYes(normalizedText)) {
      const { date, time, name } = session.pendingConfirm;
      await safeSendText(phone, "Perfecto, estoy confirmando tu reserva…");
      try {
        await confirmBooking(phone, date, time, name);
        await safeSendText(phone, "¡Listo! Te llegará la confirmación por WhatsApp.");
        await clearSession(phone);
      } catch (err) {
        console.error("confirmBooking failed", err?.response?.data || err?.message || err);
        await safeSendText(phone, "No pude confirmar la reserva. ¿Quieres intentar otra hora?");
        session.pendingConfirm = null;
        await saveSession(phone, session);
      }
      return res.sendStatus(200);
    }
    if (isNo(normalizedText)) {
      session.pendingConfirm = null;
      await safeSendText(phone, "Entendido. ¿Qué horario prefieres?");
      await saveSession(phone, session);
      return res.sendStatus(200);
    }
  }

  // Si ya tenemos horarios y el usuario manda una hora, pedir confirmación
  const timeCandidate = extractTime(text);
  if (timeCandidate && session.hours?.includes(timeCandidate)) {
    if (!session.user?.name) {
      session.pendingTime = timeCandidate;
      await safeSendText(phone, "¿A nombre de quién hago la reserva?");
      await saveSession(phone, session);
      return res.sendStatus(200);
    }
    session.pendingConfirm = {
      date: session.date,
      time: timeCandidate,
      name: session.user?.name || "Cliente"
    };
    await safeSendText(
      phone,
      `Confirmo a nombre de ${session.pendingConfirm.name} el ${formatDateEs(session.date)} a las ${timeCandidate}?`
    );
    await saveSession(phone, session);
    return res.sendStatus(200);
  }

  // Si es un saludo inicial, no repetir saludo ni romper el flujo
  if (isNewSession && isGreeting(text) && !hasBookingIntent(text)) {
    if (!session.user) {
      session.user = await findUser(phone);
    }
    await safeSendText(
      phone,
      session.user?.found ? `Hola ${session.user.name} 👋 ¿Cómo te ayudo?` : "Hola 👋 ¿Cómo te ayudo?"
    );
    session.messages.push({ role: "assistant", content: "saludo" });
    await saveSession(phone, session);
    return res.sendStatus(200);
  }

  // Si estamos esperando nombre, usar el siguiente mensaje como nombre
  if (session.pendingTime) {
    session.user = session.user || { found: false };
    session.user.name = text.trim();
    session.pendingConfirm = {
      date: session.date,
      time: session.pendingTime,
      name: session.user?.name || "Cliente"
    };
    session.pendingTime = null;
    await safeSendText(
      phone,
      `Confirmo a nombre de ${session.pendingConfirm.name} el ${formatDateEs(session.date)} a las ${session.pendingConfirm.time}?`
    );
    await saveSession(phone, session);
    return res.sendStatus(200);
  }

  const { finalText, messages } = await runAgent(session, text);

  // Si acabamos de obtener horarios, enviar solo botones (sin duplicar texto)
  if (session.justFetchedHours && session.hours?.length) {
    const buttons = session.hours.slice(0, MAX_BUTTONS).map(h => ({
      type: "reply",
      reply: { id: h, title: h }
    }));
    await safeSendButtons(
      phone,
      "Horarios disponibles (elige uno). Si prefieres otra hora, escríbela.",
      buttons
    );
    session.hoursSent = true;
    session.messages = messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .slice(-12);
    await saveSession(phone, session);
    return res.sendStatus(200);
  }

  await safeSendText(phone, finalText);

  session.messages = messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .slice(-12);

  await saveSession(phone, session);
  res.sendStatus(200);
});

/******************************************************************
 * SERVER
 ******************************************************************/
app.listen(process.env.PORT || 3000, () => {
  console.log("FULL AI AGENT RUNNING (REDIS)");
});
