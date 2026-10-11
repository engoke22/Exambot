
const SUBJECTS = [
  "English",
  "Kiswahili",
  "Mathematics",
  "Biology",
  "Chemistry",
  "Physics",
  "History and Government",
  "Geography",
  "Christian Religious Education",
  "Islamic Religious Education",
  "Hindu Religious Education",
  "Business Studies",
  "Agriculture",
  "Computer Studies",
  "Home Science",
  "French",
  "German",
  "Arabic",
  "Music",
  "Art and Design",
  "Building Construction",
  "Woodwork",
  "Metalwork",
  "Electricity",
  "Power Mechanics",
  "Aviation Technology",
  "Drawing and Design",
  "Kenyan Sign Language"
];

const PRICE_KSH = 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "KCSE Papers Bot is running.",
        { headers: { "content-type": "text/plain" } }
      );
    }

    if (url.pathname !== "/telegram" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (
      !env.WEBHOOK_SECRET ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    try {
      if (update.pre_checkout_query) {
        await handlePreCheckout(update.pre_checkout_query, env);
      } else if (update.message?.successful_payment) {
        await handleSuccessfulPayment(update.message, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      } else if (update.message) {
        await handleMessage(update.message, env);
      }
    } catch (error) {
      console.error("Update processing failed:", error.message);
    }

    return new Response("OK");
  }
};

async function telegram(env, method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  }

  return result.result;
}

async function sendText(env, chatId, text, keyboard) {
  const data = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };

  if (keyboard) {
    data.reply_markup = { inline_keyboard: keyboard };
  }

  return telegram(env, "sendMessage", data);
}

async function answerCallback(env, id, text = "") {
  return telegram(env, "answerCallbackQuery", {
    callback_query_id: id,
    text
  });
}

function isAdmin(user, env) {
  return String(user?.id) === String(env.ADMIN_ID);
}

function money(amount) {
  return `KSh ${Number(amount).toLocaleString("en-KE")}`;
}

function keyPart(value) {
  return encodeURIComponent(value);
}

async function getCart(env, userId) {
  return (await env.BOT_KV.get(`cart:${userId}`, "json")) || [];
}

async function saveCart(env, userId, cart) {
  await env.BOT_KV.put(`cart:${userId}`, JSON.stringify(cart));
}

async function getPaper(env, id) {
  return env.BOT_KV.get(`paper:${id}`, "json");
}

async function getAllPapers(env) {
  const index = (await env.BOT_KV.get("papers:index", "json")) || [];
  const results = [];

  for (const id of index) {
    const paper = await getPaper(env, id);
    if (paper) results.push(paper);
  }

  return results;
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const user = message.from;
  const text = (message.text || "").trim();

  if (message.chat.type !== "private") {
    return sendText(env, chatId, "Please use this bot in a private chat.");
  }

  // Admin uploads a PDF with this caption:
  // /addpaper|Mathematics|2023|1|Mathematics Paper 1
  if (message.document && text.startsWith("/addpaper|")) {
    if (!isAdmin(user, env)) {
      return sendText(env, chatId, "You are not authorised to manage papers.");
    }

    const parts = text.split("|").map(x => x.trim());

    if (parts.length !== 5 || !parts[1] || !parts[2] || !parts[3] || !parts[4]) {
      return sendText(
        env,
        chatId,
        "Use the PDF caption format:\n/addpaper|Subject|Year|PaperNumber|Title"
      );
    }

    const [, subject, year, paperNumber, title] = parts;

    if (!SUBJECTS.includes(subject)) {
      return sendText(env, chatId, "Subject not recognised. Check the subject list in the code.");
    }

    if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(paperNumber)) {
      return sendText(env, chatId, "Enter a four-digit year and a valid paper number.");
    }

    if (message.document.mime_type !== "application/pdf") {
      return sendText(env, chatId, "Please upload a PDF document.");
    }

    const id = crypto.randomUUID();
    const paper = {
      id,
      subject,
      year,
      paperNumber,
      title,
      fileId: message.document.file_id,
      fileName: message.document.file_name || `${title}.pdf`
    };

    await env.BOT_KV.put(`paper:${id}`, JSON.stringify(paper));

    const index = (await env.BOT_KV.get("papers:index", "json")) || [];
    index.push(id);
    await env.BOT_KV.put("papers:index", JSON.stringify(index));

    return sendText(
      env,
      chatId,
      `Paper added successfully.\n\n${subject} — ${title}\nYear: ${year}\nPaper: ${paperNumber}\nSelling price: ${money(PRICE_KSH)}\n\nPaper ID: ${id}`
    );
  }

  if (text === "/start" || text === "/menu") {
    return sendText(
      env,
      chatId,
      "Welcome to KCSE Past Papers!\n\n" +
      "I help students browse and purchase KCSE past papers. " +
      "Each paper costs KSh 1,000. Select the papers you need, " +
      "review your total and pay securely with Telegram Stars. " +
      "Your PDFs are sent here after successful payment.\n\n" +
      "Choose an option below.",
      [
        [{ text: "Browse subjects", callback_data: "subjects" }],
        [{ text: "My cart", callback_data: "cart" }]
      ]
    );
  }

  if (text === "/subjects") {
    return showSubjects(env, chatId);
  }

  if (text === "/cart") {
    return showCart(env, chatId, user.id);
  }

  if (text === "/help") {
    return sendText(
      env,
      chatId,
      "Commands:\n/start — Main menu\n/subjects — Browse available subjects\n/cart — View your cart\n/help — Show help\n\n" +
      "For payment or delivery issues, contact the bot owner."
    );
  }

  if (text.startsWith("/addpaper")) {
    return sendText(
      env,
      chatId,
      "To add a paper, upload a PDF with this caption:\n" +
      "/addpaper|Mathematics|2023|1|Mathematics Paper 1"
    );
  }

  return sendText(
    env,
    chatId,
    "Choose an option from the menu or send /start to begin."
  );
}

async function showSubjects(env, chatId) {
  const papers = await getAllPapers(env);
  const available = SUBJECTS.filter(subject =>
    papers.some(p => p.subject === subject)
  );

  if (!available.length) {
    return sendText(
      env,
      chatId,
      "No papers have been added yet. Please check again later."
    );
  }

  const keyboard = available.map(subject => [{
    text: subject,
    callback_data: `subject:${keyPart(subject)}`
  }]);

  keyboard.push([{ text: "View cart", callback_data: "cart" }]);

  return sendText(env, chatId, "Select a subject:", keyboard);
}

async function showPapers(env, chatId, subject) {
  const papers = (await getAllPapers(env))
    .filter(p => p.subject === subject);

  if (!papers.length) {
    return sendText(env, chatId, "No papers are currently available for this subject.");
  }

  const keyboard = papers.map(p => [{
    text: `${p.year} · Paper ${p.paperNumber} · ${p.title} — KSh 1,000`,
    callback_data: `add:${p.id}`
  }]);

  keyboard.push([{ text: "View cart", callback_data: "cart" }]);
  keyboard.push([{ text: "All subjects", callback_data: "subjects" }]);

  return sendText(
    env,
    chatId,
    `${subject}\n\nEach paper costs ${money(PRICE_KSH)}.\nChoose a paper to add it to your cart:`,
    keyboard
  );
}

async function showCart(env, chatId, userId) {
  const cart = await getCart(env, userId);
  const papers = [];

  for (const id of cart) {
    const paper = await getPaper(env, id);
    if (paper) papers.push(paper);
  }

  if (!papers.length) {
    return sendText(
      env,
      chatId,
      "Your cart is empty. Browse subjects to select your papers.",
      [[{ text: "Browse subjects", callback_data: "subjects" }]]
    );
  }

  const total = papers.length * PRICE_KSH;
  const lines = papers.map((p, i) =>
    `${i + 1}. ${p.subject} — ${p.title} (${p.year})`
  );

  const keyboard = [
    [{ text: "Remove all items", callback_data: "clearcart" }],
    [{ text: "Continue to payment", callback_data: "checkout" }],
    [{ text: "Browse more papers", callback_data: "subjects" }]
  ];

  return sendText(
    env,
    chatId,
    `YOUR ORDER\n\n${lines.join("\n")}\n\n` +
    `Papers: ${papers.length}\n` +
    `Price per paper: ${money(PRICE_KSH)}\n` +
    `TOTAL: ${money(total)}\n\n` +
    "The Telegram Stars checkout amount is shown on the next invoice.",
    keyboard
  );
}

async function handleCallback(query, env) {
  const data = query.data || "";
  const chatId = query.message?.chat?.id;
  const userId = query.from.id;

  if (!chatId || query.message?.chat?.type !== "private") {
    return answerCallback(env, query.id, "Open the bot in a private chat.");
  }

  await answerCallback(env, query.id);

  if (data === "subjects") {
    return showSubjects(env, chatId);
  }

  if (data === "cart") {
    return showCart(env, chatId, userId);
  }

  if (data.startsWith("subject:")) {
    return showPapers(env, chatId, decodeURIComponent(data.slice(8)));
  }

  if (data.startsWith("add:")) {
    const id = data.slice(4);
    const paper = await getPaper(env, id);

    if (!paper) {
      return sendText(env, chatId, "This paper is no longer available.");
    }

    const cart = await getCart(env, userId);
    cart.push(id);
    await saveCart(env, userId, cart);

    return sendText(
      env,
      chatId,
      `${paper.title} added to your cart.\nCurrent subtotal: ${money(cart.length * PRICE_KSH)}`,
      [[{ text: "View cart", callback_data: "cart" }],
       [{ text: "Continue browsing", callback_data: "subjects" }]]
    );
  }

  if (data === "clearcart") {
    await saveCart(env, userId, []);
    return sendText(env, chatId, "Your cart has been cleared.");
  }

  if (data === "checkout") {
    return createInvoice(env, chatId, userId);
  }
}

async function createInvoice(env, chatId, userId) {
  const starsPerPaper = Number(env.STARS_PER_PAPER);
  const cart = await getCart(env, userId);

  if (!Number.isSafeInteger(starsPerPaper) || starsPerPaper < 1) {
    return sendText(env, chatId, "Payment is not configured correctly. Please contact the owner.");
  }

  if (!cart.length) {
    return sendText(env, chatId, "Your cart is empty.");
  }

  // Validate that every selected paper still exists before invoicing.
  for (const id of cart) {
    if (!(await getPaper(env, id))) {
      return sendText(env, chatId, "A paper in your cart is unavailable. Please review your cart.");
    }
  }

  const orderId = crypto.randomUUID();
  const amountStars = cart.length * starsPerPaper;

  const order = {
    id: orderId,
    userId,
    chatId,
    paperIds: cart,
    count: cart.length,
    amountStars,
    amountKsh: cart.length * PRICE_KSH,
    status: "pending",
    createdAt: Date.now()
  };

  await env.BOT_KV.put(`order:${orderId}`, JSON.stringify(order), {
    expirationTtl: 60 * 60 * 24 * 7
  });

  return telegram(env, "sendInvoice", {
    chat_id: chatId,
    title: "KCSE Past Papers",
    description: `${cart.length} past paper(s). Reference price: ${money(order.amountKsh)}.`,
    payload: orderId,
    provider_token: "",
    currency: "XTR",
    prices: [{
      label: `${cart.length} KCSE past paper(s)`,
      amount: amountStars
    }]
  });
}

async function handlePreCheckout(query, env) {
  const orderId = query.invoice_payload;
  const order = await env.BOT_KV.get(`order:${orderId}`, "json");

  const valid =
    order &&
    order.status === "pending" &&
    String(order.userId) === String(query.from.id) &&
    query.currency === "XTR" &&
    query.total_amount === order.amountStars &&
    order.amountStars === order.count * Number(env.STARS_PER_PAPER);

  await telegram(env, "answerPreCheckoutQuery", {
    pre_checkout_query_id: query.id,
    ok: Boolean(valid),
    ...(!valid ? {
      error_message: "This order is invalid or expired. Please create a new order."
    } : {})
  });
}

async function handleSuccessfulPayment(message, env) {
  const payment = message.successful_payment;
  const chatId = message.chat.id;
  const userId = message.from.id;
  const orderId = payment.invoice_payload;

  const order = await env.BOT_KV.get(`order:${orderId}`, "json");

  if (
    !order ||
    String(order.userId) !== String(userId) ||
    String(order.chatId) !== String(chatId) ||
    payment.currency !== "XTR" ||
    payment.total_amount !== order.amountStars
  ) {
    console.error("Payment/order mismatch", orderId);
    return sendText(
      env,
      chatId,
      "We received a payment notice but could not match it to your order. Please contact support with your Telegram receipt."
    );
  }

  // Prevent a repeated payment update from delivering the same order twice.
  const chargeKey = `charge:${payment.telegram_payment_charge_id}`;
  if (await env.BOT_KV.get(chargeKey)) return;

  await env.BOT_KV.put(chargeKey, orderId, {
    expirationTtl: 60 * 60 * 24 * 365
  });

  if (order.status !== "pending") {
    return sendText(env, chatId, "This order has already been processed.");
  }

  order.status = "paid";
  order.paidAt = Date.now();
  order.telegramChargeId = payment.telegram_payment_charge_id;

  // Persist paid status before attempting file delivery.
  await env.BOT_KV.put(`order:${orderId}`, JSON.stringify(order), {
    expirationTtl: 60 * 60 * 24 * 365
  });

  await sendText(
    env,
    chatId,
    `Payment confirmed!\nOrder: ${orderId}\nPapers purchased: ${order.count}\nReference total: ${money(order.amountKsh)}\n\nYour papers are being delivered below.`
  );

  const delivered = [];

  for (const id of order.paperIds) {
    const paper = await getPaper(env, id);

    if (!paper) {
      await sendText(
        env,
        chatId,
        `A purchased file could not be found: ${id}. Contact the bot owner for assistance.`
      );
      continue;
    }

    try {
      await telegram(env, "sendDocument", {
        chat_id: chatId,
        document: paper.fileId,
        caption: `${paper.subject} — ${paper.title}\nKCSE ${paper.year}, Paper ${paper.paperNumber}`
      });
      delivered.push(id);
    } catch (error) {
      console.error("File delivery failed:", id, error.message);
      await sendText(
        env,
        chatId,
        `Delivery failed for "${paper.title}". Your payment remains recorded. Contact the bot owner and quote order ${orderId}.`
      );
    }
  }

  order.deliveredPaperIds = delivered;
  order.deliveryComplete = delivered.length === order.paperIds.length;

  await env.BOT_KV.put(`order:${orderId}`, JSON.stringify(order), {
    expirationTtl: 60 * 60 * 24 * 365
  });

  if (order.deliveryComplete) {
    await saveCart(env, userId, []);
    await sendText(env, chatId, "All purchased papers have been delivered. Thank you!");
  } else {
    await sendText(
      env,
      chatId,
      "Some files still need attention. Your order is recorded as paid; please contact the owner for any missing papers."
    );
  }
      }
      
