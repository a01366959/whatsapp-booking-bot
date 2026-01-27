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

/*
Session shape:
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
 * 4. SYSTEM PROMPT (AI BRAIN)
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres un asistente de WhatsApp para un club llamado Black Padel & Pickleball en México.

OBJETIVOS:
- Conversar de forma natural.
- Ayudar a reservar canchas.
- Resolver dudas del club.

REGLAS IMPORTANTES:
- Nunca inventes horarios.
- Toda disponibilidad y reservas vienen de Bubble.
- Pide la información paso a paso.
- Recuerda el contexto de la conversación.
- Usa botones SOLO para seleccionar horarios.
- Responde SIEMPRE en español mexicano.
- Cuando el usuario diga una fecha, devuélvela en formato YYYY-MM-DD.
- Si no puedes entender una fecha, dilo claramente.
`
};

/******************************************************************
 * 5. BUBBLE WORKFLOWS
 ******************************************************************/
async function findUser(phone) {
  const res = await axios.get(`${BUBBLE}/find_user`, {
    params: { phone }
  });
  return res.data.response || { found: false };
}

async function getAvailableHours(date) {
  const res = await axios.get(`${BUBBLE}/get_available_hours`, {
    params: { date }
  });

  const slots = res.data.response?.timeslots || [];
  return [...new Set(slots)];
}

async function confirmBooking(phone, date, time) {
  await axios.post(`${BUBBLE}/confirm_booking`, {
    phone,
    date,
    time
  });
}

/******************************************************************
 * 6. AI HELPERS
 ******************************************************************/
async function askAI(messages) {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: messages,
    temperature: 0.3,
    max_output_tokens: 300
  });

  return response.output_text;
}

/**
 * La IA se encarga de interpretar la fecha
 */
async function parseDateWithAI(text) {
  const prompt = [
    {
      role: "system",
      content:
        "Extrae una fecha del texto del usuario. Devuelve SOLO una fecha en formato YYYY-MM-DD o la palabra INVALID."
    },
    { role: "user", content: text }
  ];

  const result = await askAI(prompt);
  if (!result) return null;
  if (result.includes("INVALID")) return null;

  return result.trim();
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
    const text = msg.text?.body;

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
    if (
      session.state === "idle" &&
      text.toLowerCase().includes("reserv")
    ) {
      session.state = "awaiting_date";
      await sendText(
        phone,
        "Perfecto 👍 ¿Para qué fecha quieres reservar?"
      );
      return res.sendStatus(200);
    }

    if (session.state === "awaiting_date") {
      const parsedDate = await parseDateWithAI(text);

      if (!parsedDate) {
        await sendText(
          phone,
          "No entendí la fecha 😅\nPuedes decir algo como:\n- Hoy\n- Mañana\n- El viernes\n- 27 de noviembre"
        );
        return res.sendStatus(200);
      }

      session.date = parsedDate;
      session.availableHours = await getAvailableHours(parsedDate);

      if (!session.availableHours.length) {
        await sendText(
          phone,
          "Ese día no hay horarios disponibles."
        );
        session.state = "idle";
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

    if (
      session.state === "confirming" &&
      text.toLowerCase().includes("si")
    ) {
      await confirmBooking(phone, session.date, session.time);
      await sendText(
        phone,
        "Reserva confirmada. ¡Te esperamos en Black Padel & Pickleball!"
      );
      sessions.delete(phone);
      return res.sendStatus(200);
    }

    /**************************************************************
     * GENERAL CHAT (AI)
     **************************************************************/
    const aiReply = await askAI(session.messages);
    session.messages.push({ role: "assistant", content: aiReply });
    await sendText(phone, aiReply);

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
