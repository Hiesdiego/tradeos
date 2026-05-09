import { Bot } from "grammy";
import { prisma } from "@/lib/db/prisma";
import { formatUsdc, shortAddress } from "@/lib/utils";
import { TRADE_STATUS_LABELS } from "@/lib/constants";
import { Connection, PublicKey } from "@solana/web3.js";
import { RPC_URL, USDC_MINT, USDC_DECIMALS } from "@/lib/constants";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
bot.catch((err) => {
  void err;
});

const TRADE_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function subscribeTradeByRef(chatId: string, tradeRefRaw: string) {
  const tradeRef = tradeRefRaw.trim();
  if (!tradeRef) {
    return { ok: false as const, message: "Trade reference is required." };
  }

  const trade = TRADE_ID_REGEX.test(tradeRef)
    ? await prisma.trade.findUnique({
        where: { id: tradeRef },
        select: { id: true, trade_number: true, status: true },
      })
    : await prisma.trade.findUnique({
        where: { trade_number: tradeRef.toUpperCase() },
        select: { id: true, trade_number: true, status: true },
      });

  if (!trade) {
    return {
      ok: false as const,
      message:
        "Trade not found. Send a valid trade UUID or trade number (e.g. TRD-2604-9BEA64).",
    };
  }

  await prisma.telegramTradeSubscription.upsert({
    where: {
      trade_id_chat_id: {
        trade_id: trade.id,
        chat_id: chatId,
      },
    },
    create: {
      trade_id: trade.id,
      chat_id: chatId,
    },
    update: {},
  });

  const statusLabel = TRADE_STATUS_LABELS[trade.status] ?? trade.status;
  return {
    ok: true as const,
    message:
      `? Subscribed to *${trade.trade_number}*` +
      `\nTrade ID: \`${trade.id}\`\nCurrent status: *${statusLabel}*`,
  };
}

async function resolveTradeIdOrNumber(tradeRefRaw: string): Promise<string | null> {
  const tradeRef = tradeRefRaw.trim();
  if (!tradeRef) return null;
  if (TRADE_ID_REGEX.test(tradeRef)) return tradeRef;
  const trade = await prisma.trade.findUnique({
    where: { trade_number: tradeRef.toUpperCase() },
    select: { id: true },
  });
  return trade?.id ?? null;
}

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const args = ctx.message?.text?.split(" ") ?? [];
  const linkToken = args[1];

  if (linkToken) {
    if (!/^[a-f0-9]{24}$/.test(linkToken)) {
      await ctx.reply("Invalid or expired connect token. Please reconnect from the app.");
      return;
    }
    const user = await prisma.user.findFirst({
      where: { telegram_username: `pending:${linkToken}` },
    });

    if (user) {
      await prisma.$transaction([
        prisma.user.updateMany({
          where: { telegram_chat_id: chatId, id: { not: user.id } },
          data: { telegram_chat_id: null },
        }),
        prisma.user.update({
          where: { id: user.id },
          data: {
            telegram_chat_id: chatId,
            telegram_username: ctx.from?.username ?? null,
          },
        }),
      ]);

      await ctx.reply(
        `? *Tradeos connected*\n\nYou'll now receive trade notifications here.\n\nWallet: \`${shortAddress(user.wallet_address, 6)}\``,
        { parse_mode: "Markdown" }
      );
      return;
    }
  }

  await ctx.reply(
    `?? *Welcome to Tradeos*\n\nYou can subscribe to a trade by ID and receive update notifications here.\n\n*Commands:*\n/watch <trade_id_or_number> - Subscribe\n/unwatch <trade_id_or_number> - Unsubscribe\n/watching - List tracked trades\n/trades - View account-linked active trades\n/balance - Check USDC balance\n/help - Show this message`,
    { parse_mode: "Markdown" }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `*Tradeos Commands*\n\n/watch <trade_id_or_number> - Subscribe\n/unwatch <trade_id_or_number> - Unsubscribe\n/watching - List subscribed trades\n/trades - Account-linked active trades\n/balance - USDC balance\n/help - This message`,
    { parse_mode: "Markdown" }
  );
});

bot.command("watch", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const args = ctx.message?.text?.split(" ").slice(1) ?? [];
  const tradeRef = args.join(" ").trim();

  if (!tradeRef) {
    await ctx.reply("Usage: /watch <trade_id_or_number>");
    return;
  }

  const result = await subscribeTradeByRef(chatId, tradeRef);
  await ctx.reply(result.message, { parse_mode: "Markdown" });
});

bot.command("unwatch", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const args = ctx.message?.text?.split(" ").slice(1) ?? [];
  const tradeRef = args.join(" ").trim();

  if (!tradeRef) {
    await ctx.reply("Usage: /unwatch <trade_id_or_number>");
    return;
  }

  const resolvedTradeId = await resolveTradeIdOrNumber(tradeRef);
  if (!resolvedTradeId) {
    await ctx.reply("Trade not found.");
    return;
  }

  await prisma.telegramTradeSubscription.deleteMany({
    where: { trade_id: resolvedTradeId, chat_id: chatId },
  });
  await ctx.reply("?? Unsubscribed from that trade.");
});

bot.command("watching", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const rows = await prisma.telegramTradeSubscription.findMany({
    where: { chat_id: chatId },
    include: {
      trade: {
        select: { id: true, trade_number: true, status: true, total_amount_usdc: true },
      },
    },
    orderBy: { created_at: "desc" },
    take: 15,
  });

  if (rows.length === 0) {
    await ctx.reply("No active subscriptions yet. Use /watch <trade_id_or_number>.");
    return;
  }

  const lines = rows.map((row) => {
    const label = TRADE_STATUS_LABELS[row.trade.status] ?? row.trade.status;
    return `• *${row.trade.trade_number}* - $${formatUsdc(Number(row.trade.total_amount_usdc))} USDC\n  ${label}\n  \`${row.trade.id}\``;
  });

  await ctx.reply(`*Subscribed Trades*\n\n${lines.join("\n\n")}`, {
    parse_mode: "Markdown",
  });
});

bot.command("trades", async (ctx) => {
  const chatId = String(ctx.chat.id);

  const user = await prisma.user.findFirst({
    where: { telegram_chat_id: chatId },
  });

  if (!user) {
    await ctx.reply(
      "?? Your Telegram is not connected to a Tradeos account.\n\nVisit the web app to connect."
    );
    return;
  }

  const trades = await prisma.trade.findMany({
    where: {
      OR: [{ buyer_id: user.id }, { supplier_id: user.id }],
      NOT: {
        status: { in: ["completed", "cancelled", "refunded"] },
      },
    },
    orderBy: { created_at: "desc" },
    take: 5,
  });

  if (trades.length === 0) {
    await ctx.reply("You have no active trades.\n\nVisit the web app to start one.");
    return;
  }

  const lines = trades.map((t) => {
    const statusLabel = TRADE_STATUS_LABELS[t.status] ?? t.status;
    return `• *${t.trade_number}* - $${formatUsdc(Number(t.total_amount_usdc))} USDC\n  ${statusLabel}`;
  });

  await ctx.reply(
    `*Your Active Trades*\n\n${lines.join("\n\n")}\n\nView details on the Tradeos web app.`,
    { parse_mode: "Markdown" }
  );
});

bot.command("balance", async (ctx) => {
  const chatId = String(ctx.chat.id);

  const user = await prisma.user.findFirst({
    where: { telegram_chat_id: chatId },
  });

  if (!user) {
    await ctx.reply(
      "?? Your Telegram is not connected to a Tradeos account.\n\nVisit the web app to connect."
    );
    return;
  }

  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const walletPubkey = new PublicKey(user.wallet_address);
    const mintPubkey = new PublicKey(USDC_MINT);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: mintPubkey },
      "confirmed"
    );
    const raw = tokenAccounts.value.reduce((sum, account) => {
      const amount = account.account.data.parsed.info.tokenAmount.amount ?? "0";
      return sum + BigInt(amount);
    }, BigInt(0));
    const balance = Number(raw) / Math.pow(10, USDC_DECIMALS);

    await ctx.reply(
      `?? *USDC Balance*\n\n\`${formatUsdc(balance)} USDC\`\n\nWallet: \`${shortAddress(user.wallet_address, 6)}\``,
      { parse_mode: "Markdown" }
    );
  } catch {
    await ctx.reply(
      `?? *USDC Balance*\n\n\`0.00 USDC\`\n\nWallet: \`${shortAddress(user.wallet_address, 6)}\``,
      { parse_mode: "Markdown" }
    );
  }
});

bot.on("message", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message?.text?.trim() ?? "";

  if (TRADE_ID_REGEX.test(text) || /^TRD-/i.test(text)) {
    const result = await subscribeTradeByRef(chatId, text);
    await ctx.reply(result.message, { parse_mode: "Markdown" });
    return;
  }

  await ctx.reply(
    "Send a trade ID/number directly, or use /watch <trade_id_or_number>. Use /help for commands."
  );
});
