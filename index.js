/******************************************************************
 * 1. IMPORTS & APP SETUP
 ******************************************************************/
import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/******************************************************************
 * 2. CONSTANTS
 ******************************************************************/
const WHATSAPP_API = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
const BUBBLE = `${process.env.BUBBLE_BASE_URL}/api/1.1/wf`;
const DEFAULT_SPORT = "padel";

/******************************************************************
 * 3. SESSIONS (MEMORIA)
 ******************************************************************/
const sessions = new Map();

/******************************************************************
 * 4. SYSTEM PROMPT — EL CEREBRO
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres un recepcionista humano por WhatsApp de Black Padel & Pickleball en México.

Hablas natural, cercano y empático.
NO repites saludos.
NO hablas como bot.
NO inventas horarios.
NO confirmas reservas sin datos reales.

TU TRABAJO:
- Detectar intención del usuario
- Pedir lo que falte (fecha, horario)
- Decidir cuándo consultar disponibilidad
- Conversar normalmente si no es reserva

Cuando quieras hacer una acción, responde SOLO en JSON con esta forma:

{
  "intent": "reserve | ask_date | ask_time | confirm | general",
  "reply": "mensaje para el usuario",
  "date": "YYYY-MM-DD | null",
  "time": "HH:MM | null"
}

Si no hay acción, usa intent "general".
`
};

/******************************************************************
 * 5. HELPERS
 ******************************************************************/
function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

function resolveDate(text) {
  const t = text.toLowerCase().trim();
  const today = new Date();
  today.setHours(0,0,0,0);

  if (t === "hoy") return today.toISOString().slice(0,10);
  if (t === "mañana" || t === "manana") {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0,10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

/******************************************************************
 * 6. BUBBLE
 ******************************************************************/
async function findUser(phone) {
  const res = await axios.get(`${BUBBLE}/find_user`, {
    params: { phone },
    timeout: 8000
  });
  return res.data?.response || { found: false };
}

async function getAvailableHours(sport, date) {
  const res = await axios.get(`${BUBBLE}/get_available_hours`, {
    params: { sport, date },
    timeout: 8000
  });

  if (
    res.data?.status !== "success" ||
    !Array.isArray(res.data.response?.hours)
  ) {
    throw new Error("Bubble availability error");
  }

  return [...new Set(res.data.response.hours)].sort();
}

async function confirmBooking(phone, date, time) {
  await axios.post(`${BUBBLE}/confirm_booking`, { phone, date, time });
}

/******************************************************************
 * 7. OPENAI
 ******************************************************************/
async function askAgent(messages) {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: messages,
    temperature: 0.3,
    max_output_tokens: 300
  });

  const text = response.output_text?.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { intent: "general", reply: text };
  }
}

/******************************************************************
 * 8. WHATSAPP
 ******************************************************************/
function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json"
  };
}

async function sendText(phone, text) {
  await axios.post(
    WHATSAPP_API,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text }
    },
    { headers: authHeaders() }
  );
}

async function sendButtons(phone, text, options) {
  await axios.post(
    WHATSAPP_API,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: { buttons: options }
      }
    },
    { headers: authHeaders() }
  );
}

/******************************************************************
 * 9. WEBHOOK
 ******************************************************************/
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = normalizePhone(msg.from);
    const text = msg.text?.body || "";

    if (!sessions.has(phone)) {
      const user = await findUser(phone);

      sessions.set(phone, {
        messages: [SYSTEM_MESSAGE],
        user,
        date: null,
        hours: []
      });

      const name = user?.found ? user.name : "";
      await sendText(phone, name ? `Hola ${name} 👋 ¿Cómo te ayudo hoy?` : "Hola 👋 ¿Cómo te ayudo hoy?");
      return res.sendStatus(200);
    }

    const session = sessions.get(phone);
    session.messages.push({ role: "user", content: text });

    const agent = await askAgent(session.messages);
    if (!agent) return res.sendStatus(200);

    // Fecha determinística
    if (agent.date === null) {
      const d = resolveDate(text);
      if (d) session.date = d;
    } else {
      session.date = agent.date;
    }

    // INTENTS
    if (agent.intent === "ask_date") {
      await sendText(phone, agent.reply);
      return res.sendStatus(200);
    }

    if (agent.intent === "reserve" && session.date) {
      await sendText(phone, "Déjame revisar los horarios disponibles…");
      session.hours = await getAvailableHours(DEFAULT_SPORT, session.date);

      await sendButtons(
        phone,
        "Estos horarios están disponibles:",
        session.hours.slice(0, 5).map(h => ({
          type: "reply",
          reply: { id: h, title: h }
        }))
      );
      return res.sendStatus(200);
    }

    if (agent.intent === "ask_time") {
      await sendText(phone, agent.reply);
      return res.sendStatus(200);
    }

    if (agent.intent === "confirm" && agent.time && session.date) {
      await confirmBooking(phone, session.date, agent.time);
      await sendText(phone, "¡Listo! Tu reserva quedó confirmada 🙌");
      sessions.delete(phone);
      return res.sendStatus(200);
    }

    // Conversación normal
    await sendText(phone, agent.reply);
    session.messages.push({ role: "assistant", content: agent.reply });

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

/******************************************************************
 * 10. SERVER
 ******************************************************************/
app.listen(process.env.PORT || 3000, () => {
  console.log("WhatsApp AI Agent running (FULL AGENT)");
});
