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

/******************************************************************
 * 3. IN-MEMORY SESSIONS (CAMBIAR A REDIS EN PROD)
 ******************************************************************/
const sessions = new Map();

/******************************************************************
 * 4. SYSTEM PROMPT (GENERAL AI)
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres un asistente de WhatsApp para un club llamado Black Padel & Pickleball en México.
Conversas de forma natural y recuerdas el contexto.
`
};

/******************************************************************
 * 5. BUBBLE WORKFLOWS
 ******************************************************************/
async function findUser(phone) {
  const res = await axios.get(`${BUBBLE}/find_user`, { params: { phone } });
  return res.data.response || { found: false };
}

async function getAvailableHours(date) {
  const res = await axios.get(`${BUBBLE}/get_available_hours`, {
    params: { date }
  });
  return [...new Set(res.data.response?.timeslots || [])];
}

async function confirmBooking(phone, date, time) {
  await axios.post(`${BUBBLE}/confirm_booking`, { phone, date, time });
}

/******************************************************************
 * 6. AI HELPERS
 ******************************************************************/
async function askAI(messages) {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: messages,
    temperature: 0,
    max_output_tokens: 100
  });

  return response.output_text?.trim();
}

/**
 * 6.1 Date parsing with AI (FIXED)
 */
async function parseDateWithAI(text) {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);

  const prompt = [
    {
      role: "system",
      content: `
Eres un parser de fechas.

HOY es: ${todayISO}
Estás en México.

Tarea:
- Convierte lo que diga el usuario a una fecha exacta en formato YYYY-MM-DD.
- Soporta: hoy, mañana, pasado mañana, días de la semana, fechas largas.
- Si NO puedes inferir una fecha clara, responde SOLO: INVALID.
- No expliques nada.
`
    },
    { role: "user", content: text }
  ];

  const result = await askAI(prompt);

  if (!result) return null;
  if (result === "INVALID") return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) return null;

  return result;
}

/******************************************************************
 * 7. WHATSAPP SENDERS
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
 * 8. WEBHOOK
 ******************************************************************/
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || !msg.text?.body) return res.sendStatus(200);

    const phone = msg.from;
    const text = msg.text.body.trim();

    if (!sessions.has(phone)) {
      const user = await findUser(phone);
      sessions.set(phone, {
        messages: [SYSTEM_MESSAGE],
        state: "idle",
        user,
        date: null,
        availableHours: [],
        time: null
      });
    }

    const session = sessions.get(phone);
    session.messages.push({ role: "user", content: text });

    /**************************************************************
     * RESERVATION FLOW
     **************************************************************/
    if (session.state === "idle" && text.toLowerCase().includes("reserv")) {
      session.state = "awaiting_date";
      await sendText(phone, "Perfecto, ¿para qué fecha quieres reservar?");
      return res.sendStatus(200);
    }

    if (session.state === "awaiting_date") {
      const parsedDate = await parseDateWithAI(text);

      if (!parsedDate) {
        await sendText(
          phone,
          "No entendí la fecha.\nPuedes decir por ejemplo:\n- Hoy\n- Mañana\n- Pasado mañana\n- 27 de noviembre"
        );
        return res.sendStatus(200);
      }

      session.date = parsedDate;
      session.availableHours = await getAvailableHours(parsedDate);

      if (!session.availableHours.length) {
        session.state = "idle";
        await sendText(phone, "Ese día no hay horarios disponibles.");
        return res.sendStatus(200);
      }

      session.state = "awaiting_time";

      await sendButtons(
        phone,
        "Estos son los horarios disponibles:",
        session.availableHours.slice(0, 3).map(h => ({
          type: "reply",
          reply: { id: h, title: h }
        }))
      );

      return res.sendStatus(200);
    }

    if (session.state === "awaiting_time") {
      session.time = text;
      session.state = "confirming";
      await sendText(
        phone,
        `¿Confirmo tu reserva el ${session.date} a las ${session.time}?`
      );
      return res.sendStatus(200);
    }

    if (session.state === "confirming" && text.toLowerCase().includes("si")) {
      await confirmBooking(phone, session.date, session.time);
      await sendText(phone, "Reserva confirmada. ¡Te esperamos!");
      sessions.delete(phone);
      return res.sendStatus(200);
    }

    /**************************************************************
     * GENERAL AI CHAT
     **************************************************************/
    const aiReply = await askAI(session.messages);
    session.messages.push({ role: "assistant", content: aiReply });
    await sendText(phone, aiReply);

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

/******************************************************************
 * 9. SERVER START
 ******************************************************************/
app.listen(process.env.PORT || 3000, () => {
  console.log("WhatsApp AI Agent running");
});
