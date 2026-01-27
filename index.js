import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/**
 * ============================
 * 1. WEBHOOK VERIFICATION
 * ============================
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * ============================
 * 2. SESSION STORAGE
 * ============================
 */
const sessions = {};

/**
 * ============================
 * 3. INCOMING WHATSAPP
 * ============================
 */
app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const phone = message.from;
    const type = message.type;

    if (!sessions[phone]) {
      sessions[phone] = { phone };
      await findUser(phone); // 🔥 SIEMPRE
    }

    if (type === "text") {
      await sendMainMenu(phone);
    }

    if (type === "interactive") {
      await handleInteraction(phone, message.interactive);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.sendStatus(200);
  }
});

/**
 * ============================
 * 4. INTERACTIONS
 * ============================
 */
async function handleInteraction(phone, interactive) {
  const id =
    interactive.button_reply?.id ||
    interactive.list_reply?.id;

  if (!id) return;

  // MENÚ
  if (id === "menu_book") {
    await sendDateList(phone);
    return;
  }

  if (id === "menu_hours") {
    await sendText(
      phone,
      "🕘 Horario del club:\n\nLunes a Domingo\n7:00 AM – 11:00 PM"
    );
    await sendMainMenu(phone);
    return;
  }

  if (id === "menu_info") {
    await sendText(
      phone,
      "📍 Black Padel & Pickleball\n\nPadel y Pickleball premium.\nReserva fácil por WhatsApp."
    );
    await sendMainMenu(phone);
    return;
  }

  // FECHA
  if (id.startsWith("date_")) {
    const date = id.replace("date_", "");
    sessions[phone].date = date;

    try {
      await getAvailableHours(phone, date);
      await sendTimeButtons(phone);
    } catch {
      await sendText(phone, "❌ No hay horarios disponibles.");
      await sendDateList(phone);
    }
  }

  // HORA
  if (id.startsWith("time_")) {
    sessions[phone].time = id.replace("time_", "");
    await sendConfirmation(phone);
  }

  // CONFIRMAR
  if (id === "confirm") {
    try {
      await confirmBooking(phone);
      await sendText(phone, "🎉 Reserva confirmada");
      delete sessions[phone];
      await sendMainMenu(phone);
    } catch {
      await sendText(phone, "❌ Ese horario ya no está disponible.");
      await sendMainMenu(phone);
    }
  }
}

/**
 * ============================
 * 5. BUBBLE WORKFLOWS
 * ============================
 */
async function findUser(phone) {
  const res = await axios.get(
    `${process.env.BUBBLE_BASE_URL}/api/1.1/wf/find_user`,
    { params: { phone } }
  );

  if (res.data.response?.found) {
    sessions[phone].name = res.data.response.name;
  }
}

async function getAvailableHours(phone, date) {
  const res = await axios.get(
    `${process.env.BUBBLE_BASE_URL}/api/1.1/wf/get_available_hours`,
    { params: { date } }
  );

  const hours = res.data.response?.hours;
  if (!hours || hours.length === 0) throw new Error();

  // eliminar duplicados
  sessions[phone].availableHours = [...new Set(hours)];
}

async function confirmBooking(phone) {
  const s = sessions[phone];

  await axios.post(
    `${process.env.BUBBLE_BASE_URL}/api/1.1/wf/confirm_booking`,
    {
      phone: s.phone,
      date: s.date,
      time: s.time
    }
  );
}

/**
 * ============================
 * 6. WHATSAPP UI
 * ============================
 */
async function sendMainMenu(phone) {
  const name = sessions[phone].name;
  const greeting = name
    ? `Hola ${name} 👋`
    : "Hola 👋";

  await sendInteractive(phone, {
    type: "button",
    body: {
      text: `${greeting}\n\n🎾 *Black Padel & Pickleball*\n¿Qué te gustaría hacer?`
    },
    action: {
      buttons: [
        { type: "reply", reply: { id: "menu_book", title: "📅 Reservar cancha" } },
        { type: "reply", reply: { id: "menu_hours", title: "⏰ Horarios" } },
        { type: "reply", reply: { id: "menu_info", title: "ℹ️ Información" } }
      ]
    }
  });
}

async function sendDateList(phone) {
  await sendInteractive(phone, {
    type: "list",
    body: { text: "📅 Elige una fecha" },
    action: {
      button: "Seleccionar",
      sections: [
        {
          title: "Fechas",
          rows: [
            { id: "date_today", title: "Hoy" },
            { id: "date_tomorrow", title: "Mañana" },
            { id: "date_plus2", title: "En 2 días" },
            { id: "date_manual", title: "Ingresar fecha (DD MM)" }
          ]
        }
      ]
    }
  });
}

async function sendTimeButtons(phone) {
  const buttons = sessions[phone].availableHours.slice(0, 3).map(h => ({
    type: "reply",
    reply: { id: `time_${h}`, title: h }
  }));

  await sendInteractive(phone, {
    type: "button",
    body: { text: "⏰ Elige un horario" },
    action: { buttons }
  });
}

async function sendConfirmation(phone) {
  await sendInteractive(phone, {
    type: "button",
    body: { text: "✅ ¿Confirmar reserva?" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "confirm", title: "Confirmar" } }
      ]
    }
  });
}

/**
 * ============================
 * 7. SENDERS
 * ============================
 */
async function sendText(phone, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function sendInteractive(phone, interactive) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/**
 * ============================
 * 8. START
 * ============================
 */
app.listen(process.env.PORT || 3000, () => {
  console.log("✅ WhatsApp bot running");
});
