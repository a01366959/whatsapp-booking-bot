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
 * 3. IN-MEMORY SESSIONS (CAMBIAR A REDIS EN PRODUCCIÓN)
 ******************************************************************/
const sessions = new Map();

/*
Session structure:
{
  messages: [ { role, content } ],
  state: "idle" | "awaiting_date" | "awaiting_time" | "confirming",
  user: { found, name },
  date: null,
  availableHours: [],
  time: null
}
*/

/******************************************************************
 * 4. SYSTEM PROMPT (CEREBRO DEL AGENTE)
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres un asistente humano de WhatsApp para Black Padel & Pickleball en México.

OBJETIVO:
Conversar de forma natural como recepcionista real, NO como bot.

REGLAS:
- Nunca inventes horarios.
- Toda disponibilidad y reservas vienen de Bubble.
- Pide información paso a paso.
- Recuerda el contexto.
- Usa botones SOLO para elegir horarios.
- Responde en español mexicano.
- Si algo falla, explica de forma humana.
`
};

/******************************************************************
 * 5. BUBBLE WORKFLOWS
 ******************************************************************/
async function findUser(phone) {
  const res = await axios.get(`${BUBBLE}/find_user`, {
    params: { phone },
    timeout: 8000
  });

  if (!res.data || res.data.status !== "success") {
    return { found: false };
  }

  return res.data.response;
}

async function getAvailableHours(date) {
  const res = await axios.get(`${BUBBLE}/get_available_hours`, {
    params: { date },
    timeout: 8000
  });

  if (
    !res.data ||
    res.data.status !== "success" ||
    !Array.isArray(res.data.response?.timeslots)
  ) {
    throw new Error("Bubble availability error");
  }

  // eliminar duplicados (2 canchas = 1 horario)
  return [...new Set(res.data.response.timeslots)];
}

async function confirmBooking(phone, date, time) {
  await axios.post(
    `${BUBBLE}/confirm_booking`,
    { phone, date, time },
    { timeout: 8000 }
  );
}

/******************************************************************
 * 6. OPENAI HELPERS
 ******************************************************************/
async function askAI(messages) {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: messages,
    temperature: 0.35,
    max_output_tokens: 300
  });

  return response.output_text?.trim();
}

/**
 * Usa IA SOLO para entender fechas
 */
async function parseDateWithAI(text) {
  const messages = [
    {
      role: "system",
      content:
        "Extrae una fecha del texto del usuario. Devuelve SOLO una fecha en formato YYYY-MM-DD o la palabra INVALID."
    },
    { role: "user", content: text }
  ];

  const result = await askAI(messages);
  if (!result || result.includes("INVALID")) return null;

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
 * 8. WEBHOOK VERIFICATION
 ******************************************************************/
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === process.env.WEBHOOK_VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/******************************************************************
 * 9. MAIN WEBHOOK
 ******************************************************************/
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = msg.from;
    const text = msg.text?.body || "";

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

      if (user?.found) {
        await sendText(phone, `Hola ${user.name} 👋 ¿Cómo te ayudo hoy?`);
      } else {
        await sendText(phone, "Hola 👋 ¿Cómo te ayudo hoy?");
      }
    }

    const session = sessions.get(phone);
    session.messages.push({ role: "user", content: text });

    /**************************************************************
     * RESERVATION FLOW
     **************************************************************/
    if (
      session.state === "idle" &&
      text.toLowerCase().includes("reserv")
    ) {
      session.state = "awaiting_date";
      await sendText(
        phone,
        "Perfecto 👍 ¿Para qué fecha te gustaría reservar?"
      );
      return res.sendStatus(200);
    }

    if (session.state === "awaiting_date") {
      const parsedDate = await parseDateWithAI(text);

      if (!parsedDate) {
        await sendText(
          phone,
          "No entendí bien la fecha 😅\nPuedes decir algo como:\n• Hoy\n• Mañana\n• El viernes\n• 27 de noviembre"
        );
        return res.sendStatus(200);
      }

      session.date = parsedDate;

      await sendText(
        phone,
        "Dame un momento, estoy revisando los horarios disponibles…"
      );

      try {
        session.availableHours = await getAvailableHours(parsedDate);
      } catch (e) {
        console.error("Bubble availability error:", e.message);
        await sendText(
          phone,
          "Tuve un problema revisando los horarios 😕 ¿Quieres que lo intente de nuevo?"
        );
        return res.sendStatus(200);
      }

      if (!session.availableHours.length) {
        await sendText(
          phone,
          "Ese día ya estamos llenos 😅\nSi quieres, puedo revisar otra fecha."
        );
        session.state = "awaiting_date";
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
        `Perfecto 👍 ¿Confirmo tu reserva el ${session.date} a las ${session.time}?`
      );
      return res.sendStatus(200);
    }

    if (
      session.state === "confirming" &&
      text.toLowerCase().includes("si")
    ) {
      await confirmBooking(phone, session.date, session.time);
      await sendText(
        phone,
        "Listo 🙌 Tu reserva quedó confirmada. ¡Te esperamos!"
      );
      sessions.delete(phone);
      return res.sendStatus(200);
    }

    /**************************************************************
     * GENERAL CHAT (AI)
     **************************************************************/
    const aiReply = await askAI(session.messages);
    if (aiReply) {
      session.messages.push({ role: "assistant", content: aiReply });
      await sendText(phone, aiReply);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.sendStatus(500);
  }
});

/******************************************************************
 * 10. SERVER START
 ******************************************************************/
app.listen(process.env.PORT || 3000, () => {
  console.log("WhatsApp AI Agent running");
});
