import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const sessions = {};

// WhatsApp webhook
app.post("/webhook", async (req, res) => {
  const message =
    req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const phone = message.from;
  const type = message.type;

  if (!sessions[phone]) {
    sessions[phone] = { step: "start" };
  }

  if (type === "text") {
    if (message.text.body.toLowerCase().includes("book")) {
      sessions[phone].step = "choose_date";
      await sendDateList(phone);
    } else {
      await sendText(phone, "Hi! Type *book* to start 📅");
    }
  }

  if (type === "interactive") {
    await handleInteraction(phone, message.interactive);
  }

  res.sendStatus(200);
});

// Handle button/list taps
async function handleInteraction(phone, interactive) {
  const id =
    interactive.list_reply?.id ||
    interactive.button_reply?.id;

  if (id.startsWith("date_")) {
    sessions[phone].date = id.replace("date_", "");
    await sendTimeButtons(phone);
  }

  if (id.startsWith("time_")) {
    sessions[phone].time = id.replace("time_", "");
    await sendConfirmation(phone);
  }

  if (id === "confirm") {
    await sendText(phone, "🎉 Booking confirmed!");
    delete sessions[phone];
  }
}

// Send date list
async function sendDateList(phone) {
  await sendInteractive(phone, {
    type: "list",
    body: { text: "📅 Choose a date" },
    action: {
      button: "Select date",
      sections: [
        {
          rows: [
            { id: "date_2026-01-27", title: "Tomorrow" },
            { id: "date_2026-01-28", title: "Wed Jan 28" }
          ]
        }
      ]
    }
  });
}

// Send time buttons
async function sendTimeButtons(phone) {
  await sendInteractive(phone, {
    type: "button",
    body: { text: "⏰ Choose a time" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "time_17_00", title: "5:00 PM" } },
        { type: "reply", reply: { id: "time_17_30", title: "5:30 PM" } }
      ]
    }
  });
}

// Send confirmation
async function sendConfirmation(phone) {
  await sendInteractive(phone, {
    type: "button",
    body: { text: "✅ Confirm booking?" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "confirm", title: "Confirm" } }
      ]
    }
  });
}

// Send WhatsApp text
async function sendText(phone, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    }
  );
}

// Send buttons/lists
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
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    }
  );
}

// Start server
app.listen(process.env.PORT || 3000, () => {
  console.log("Bot is running");
});
