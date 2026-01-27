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
 * 3. IN-MEMORY SESSIONS
 ******************************************************************/
const sessions = new Map();

/******************************************************************
 * 4. SYSTEM PROMPT
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres un recepcionista humano de WhatsApp para Black Padel & Pickleball en México.

Habla natural, cercano y empático.
No repitas saludos.
Nunca hables como bot.
Ayuda a reservar canchas y resolver dudas.
`
};

/******************************************************************
 * 5. HELPERS
 ******************************************************************/
function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

/******************************************************************
 * 6. BUBBLE WORKFLOWS
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

async function getAvailableHours(sport, date) {
  const res = await axios.get(`${BUBBLE}/get_available_hours`, {
    params: { sport, date },
    timeout: 8000
  });

  if (
    !res.data ||
    res.data.status !== "success" ||
    res.data.response?.success !== true ||
    !Array.isArray(res.data.response?.hours)
  ) {
    throw new Error("Bubble availability error");
  }

  const unique = [...new Set(res.data.response.hours)];

  unique.sort((a, b) => {
    const [ha, ma] = a.split(":").map(Number);
    const [hb, mb] = b.split(":").map(Number);
    return ha * 60 + ma - (hb * 60 + mb);
  });

  return unique;
}

async function confirmBooking(phone, date, time) {
  await axios.post(`${BUBBLE}/confirm_booking`, {
    phone,
    date,
    time
  });
}

/******************************************************************
 * 7. OPENAI HELPERS
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

async function parseDateWithAI(text) {
  const messages = [
    {
      role: "system",
      content:
        "Extrae una fecha del texto. Devuelve SOLO YYYY-MM-DD o INVALID."
    },
    { role: "user", content: text }
  ];

  const result = await askAI(messages);
  if (!result || result.includes("INVALID")) return null;
  return result.trim();
}

/******************************************************************
 * 8. WHATSAPP SENDERS
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

    const rawPhone = msg.from;
    const phone = normalizePhone(rawPhone);
    const text = msg.text?.body || "";
    const normalized = text.toLowerCase().trim();

    /**************** SESSION INIT ****************/
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

      if (user?.found && user.name) {
        await sendText(phone, `Hola ${user.name} 👋 ¿Cómo te ayudo hoy?`);
      } else {
        await sendText(phone, "Hola 👋 ¿Cómo te ayudo hoy?");
      }

      return res.sendStatus(200);
    }

    const session = sessions.get(phone);
    session.messages.push({ role: "user", content: text });

    /**************** GLOBAL ****************/
    if (normalized.includes("reiniciar")) {
      sessions.delete(phone);
      await sendText(phone, "Listo, empezamos de nuevo 🙂 ¿Qué te gustaría hacer?");
      return res.sendStatus(200);
    }

    /**************** RESERVA ****************/
    if (session.state === "idle" && normalized.includes("reserv")) {
      session.state = "awaiting_date";
      await sendText(phone, "Perfecto, ¿para qué fecha te gustaría reservar?");
      return res.sendStatus(200);
    }

    if (session.state === "awaiting_date") {
      const date = await parseDateWithAI(text);

      if (!date) {
        await sendText(
          phone,
          "No entendí la fecha 😅 Puedes decir: hoy, mañana, viernes o 27 de noviembre."
        );
        return res.sendStatus(200);
      }

      session.date = date;
      await sendText(phone, "Déjame revisar los horarios disponibles…");

      try {
        session.availableHours = await getAvailableHours(DEFAULT_SPORT, date);
      } catch {
        await sendText(
          phone,
          "Tuve un problema consultando los horarios 😕 ¿Intentamos otra fecha?"
        );
        return res.sendStatus(200);
      }

      if (!session.availableHours.length) {
        await sendText(
          phone,
          "Ese día ya está lleno 😅 Si quieres, revisamos otra fecha."
        );
        return res.sendStatus(200);
      }

      session.state = "awaiting_time";

      await sendButtons(
        phone,
        "Estos horarios están disponibles:",
        session.availableHours.slice(0, 5).map(h => ({
          type: "reply",
          reply: { id: h, title: h }
        }))
      );

      return res.sendStatus(200);
    }

    if (session.state === "awaiting_time") {
      if (!session.availableHours.includes(text)) {
        await sendText(phone, "Elige uno de los horarios disponibles 😊");
        return res.sendStatus(200);
      }

      session.time = text;
      session.state = "confirming";

      await sendText(
        phone,
        `¿Confirmo tu reserva el ${session.date} a las ${session.time}?`
      );
      return res.sendStatus(200);
    }

    if (session.state === "confirming" && normalized.includes("si")) {
      await confirmBooking(phone, session.date, session.time);
      await sendText(phone, "¡Listo! Tu reserva quedó confirmada 🙌");
      sessions.delete(phone);
      return res.sendStatus(200);
    }

    /**************** CHAT GENERAL ****************/
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
