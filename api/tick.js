import { createClient } from "@supabase/supabase-js";
import { TwitterApi } from "twitter-api-v2";

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "X_APP_KEY",
  "X_APP_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_SECRET",
  "BOT_USERNAME",
  "ANSEM_TOKEN",
  "CRON_SECRET",
];

const BOT_USERNAME = process.env.BOT_USERNAME;
const ANSEM_TOKEN = process.env.ANSEM_TOKEN;
const PUBLIC_PULSE_INTERVAL_MS = 60 * 60 * 1000;
const SIGNIFICANT_UP_MOVE_PERCENT = 20;
const MAX_MENTIONS_PER_TICK = 10;
const MAX_ALERTS_PER_TICK = 25;

let supabase;
let rwClient;

function assertEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

function initClients() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  if (!rwClient) {
    const twitter = new TwitterApi({
      appKey: process.env.X_APP_KEY,
      appSecret: process.env.X_APP_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });

    rwClient = twitter.readWrite;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactUsd(num) {
  const value = Number(num || 0);
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function parseNumericTarget(value, suffix = "") {
  const number = Number(String(value).replace(/,/g, ""));
  const unit = suffix.toLowerCase();

  if (!Number.isFinite(number) || number <= 0) return null;
  if (unit === "b" || unit === "bn" || unit === "billion") return number * 1_000_000_000;
  if (unit === "bil" || unit === "billions") return number * 1_000_000_000;
  if (unit === "m" || unit === "mm" || unit === "million") return number * 1_000_000;
  if (unit === "mil" || unit === "millions") return number * 1_000_000;
  if (unit === "k" || unit === "thousand") return number * 1_000;
  if (unit === "thousands") return number * 1_000;
  return number;
}

function formatPrice(price) {
  const value = Number(price);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function metricLabel(metric) {
  if (metric === "market_cap") return "market cap";
  if (metric === "fdv") return "FDV";
  return "price";
}

function formatMetricValue(metric, value) {
  if (metric === "price") return `$${formatPrice(value)}`;
  return compactUsd(value);
}

function getMarketMetricValue(market, metric) {
  if (metric === "market_cap") return market.marketCap;
  if (metric === "fdv") return market.fdv;
  return market.price;
}

function inferAlertDirection(currentValue, targetValue) {
  return targetValue >= currentValue ? "above" : "below";
}

async function getAnsemPrice() {
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${ANSEM_TOKEN}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`DEX Screener error: ${res.status}`);
  }

  const pairs = await res.json();
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error("No ANSEM pairs found");
  }

  const best = pairs
    .filter((pair) => pair?.priceUsd)
    .sort((a, b) => {
      const aLiquidity = Number(a?.liquidity?.usd || 0);
      const bLiquidity = Number(b?.liquidity?.usd || 0);
      return bLiquidity - aLiquidity;
    })[0];

  if (!best) {
    throw new Error("No ANSEM pair with USD price found");
  }

  return {
    price: Number(best.priceUsd),
    pairUrl: best.url,
    liquidity: Number(best?.liquidity?.usd || 0),
    marketCap: Number(best?.marketCap || best?.fdv || 0),
    fdv: Number(best?.fdv || best?.marketCap || 0),
    change24h: Number(best?.priceChange?.h24 || 0),
  };
}

function parseCommand(text) {
  const clean = text
    .replace(new RegExp(`@${escapeRegExp(BOT_USERNAME)}`, "gi"), "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!clean) return { type: "unknown" };

  if (/\b(alerts|list|active)\b/.test(clean)) {
    return { type: "list_alerts" };
  }

  if (/\b(cancel|clear|delete|remove|stop)\b/.test(clean)) {
    return { type: "cancel_alerts" };
  }

  const alertText = clean
    .replace(/\$?ansem\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const hasAlertIntent =
    /\b(alert|notify|ping|call|watch|track|remind|signal|horn)\b/.test(alertText) ||
    /\blet me know\b/.test(alertText) ||
    /\btell me\b/.test(alertText);
  const targetValue = extractTarget(alertText);
  const metric = extractMetric(alertText);
  const direction = extractDirection(alertText);

  if (hasAlertIntent && targetValue && direction) {
    return {
      type: "create_alert",
      metric,
      direction,
      targetValue,
    };
  }

  const targetPhrase =
    /\b(gets? to|goes to|moves to|runs to|reaches|hits|touches|breaks|crosses|at|to)\b/.test(
      alertText
    ) || /[=:]/.test(alertText);

  if (hasAlertIntent && targetValue && targetPhrase) {
    return {
      type: "create_alert",
      metric,
      direction: null,
      targetValue,
    };
  }

  if (
    hasAlertIntent &&
    targetValue &&
    /\b(price|market cap|marketcap|mcap|mc|cap|fdv)\b/.test(alertText)
  ) {
    return {
      type: "create_alert",
      metric,
      direction: null,
      targetValue,
    };
  }

  if (!hasAlertIntent && targetValue && direction && metric !== "price") {
    return {
      type: "create_alert",
      metric,
      direction,
      targetValue,
    };
  }

  if (/\b(price|px|chart|current|now|ansem)\b|\$ansem\b/.test(clean)) {
    return { type: "price" };
  }

  return { type: "unknown" };
}

function parseAlertMetric(rawMetric) {
  const clean = rawMetric.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    clean === "market cap" ||
    clean === "marketcap" ||
    clean === "mcap" ||
    clean === "mc" ||
    clean === "cap"
  ) {
    return "market_cap";
  }
  if (clean === "fully diluted valuation" || clean === "fdv") return "fdv";
  return "price";
}

function extractMetric(text) {
  const metric = text.match(
    /\b(fully diluted valuation|market cap|marketcap|mcap|mc|cap|fdv|price)\b/
  );

  return metric ? parseAlertMetric(metric[1]) : "price";
}

function extractTarget(text) {
  const target = text.match(
    /\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)\s*(k|m|mm|mil|million|millions|b|bn|bil|billion|billions|thousand|thousands)?\b/
  );

  if (!target) return null;
  return parseNumericTarget(target[1], target[2]);
}

function extractDirection(text) {
  const direction = text.match(
    /\b(breaks above|breaks below|crosses above|crosses below|greater than|more than|higher than|less than|lower than|above|over|below|under|exceeds)\b|([<>]=?)/
  );

  if (!direction) return null;

  const rawDirection = direction[1] || direction[2];
  if (
    rawDirection.includes("below") ||
    rawDirection.includes("less") ||
    rawDirection.includes("lower") ||
    rawDirection === "under" ||
    rawDirection.startsWith("<")
  ) {
    return "below";
  }

  return "above";
}

async function reply(text, tweetId) {
  await rwClient.v2.tweet({
    text,
    reply: {
      in_reply_to_tweet_id: tweetId,
    },
  });
}

async function getState(key, fallback = "0") {
  const { data, error } = await supabase
    .from("bot_state")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) throw error;
  return data?.value || fallback;
}

async function setState(key, value) {
  const { error } = await supabase.from("bot_state").upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
  });

  if (error) throw error;
}

async function claimTweet(tweetId) {
  const { error } = await supabase
    .from("processed_tweets")
    .insert({ tweet_id: tweetId });

  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}

async function releaseTweet(tweetId) {
  await supabase.from("processed_tweets").delete().eq("tweet_id", tweetId);
}

async function handleMention(tweet, user, market) {
  const command = parseCommand(tweet.text);

  if (command.type === "price") {
    return reply(
      `BLACK BULL PULSE\n\n` +
        `$ANSEM: $${formatPrice(market.price)}\n` +
        `24H: ${market.change24h.toFixed(2)}%\n` +
        `Liquidity: ${compactUsd(market.liquidity)}\n` +
        `Market Cap: ${compactUsd(market.marketCap)}\n\n` +
        `The trenches are watching.`,
      tweet.id
    );
  }

  if (command.type === "create_alert") {
    const currentValue = getMarketMetricValue(market, command.metric);
    const direction =
      command.direction || inferAlertDirection(currentValue, command.targetValue);

    const { data: existing, error: existingError } = await supabase
      .from("alerts")
      .select("id")
      .eq("x_user_id", user.id)
      .eq("alert_metric", command.metric)
      .eq("direction", direction)
      .eq("target_price", command.targetValue)
      .eq("triggered", false)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      return reply(
        `Alert already active for @${user.username}.\n\n` +
          `$ANSEM ${metricLabel(command.metric)} ${direction} ${formatMetricValue(
            command.metric,
            command.targetValue
          )}\n` +
          `Current: ${formatMetricValue(command.metric, currentValue)}`,
        tweet.id
      );
    }

    const { error } = await supabase.from("alerts").insert({
      x_user_id: user.id,
      x_username: user.username,
      source_tweet_id: tweet.id,
      alert_metric: command.metric,
      direction,
      target_price: command.targetValue,
    });

    if (error?.code === "23505") {
      return reply(
        `Alert already active for @${user.username}.\n\n` +
          `$ANSEM ${metricLabel(command.metric)} ${direction} ${formatMetricValue(
            command.metric,
            command.targetValue
          )}`,
        tweet.id
      );
    }

    if (error) throw error;

    return reply(
      `Alert set for @${user.username}.\n\n` +
        `$ANSEM ${metricLabel(command.metric)} ${direction} ${formatMetricValue(
          command.metric,
          command.targetValue
        )}\n` +
        `Current: ${formatMetricValue(command.metric, currentValue)}\n\n` +
        `The bull will call when the level hits.`,
      tweet.id
    );
  }

  if (command.type === "list_alerts") {
    const { data: alerts, error } = await supabase
      .from("alerts")
      .select("*")
      .eq("x_user_id", user.id)
      .eq("triggered", false)
      .order("created_at", { ascending: false })
      .limit(5);

    if (error) throw error;

    if (!alerts?.length) {
      return reply(`No active $ANSEM alerts for @${user.username}.`, tweet.id);
    }

    const lines = alerts.map(
      (alert, index) =>
        `${index + 1}. ${metricLabel(alert.alert_metric || "price")} ${alert.direction} ${formatMetricValue(
          alert.alert_metric || "price",
          Number(alert.target_price)
        )}`
    );

    return reply(
      `Active $ANSEM alerts for @${user.username}:\n\n${lines.join("\n")}`,
      tweet.id
    );
  }

  if (command.type === "cancel_alerts") {
    const { error } = await supabase
      .from("alerts")
      .update({ triggered: true, triggered_at: new Date().toISOString() })
      .eq("x_user_id", user.id)
      .eq("triggered", false);

    if (error) throw error;

    return reply(`Cleared active $ANSEM alerts for @${user.username}.`, tweet.id);
  }

  return reply(
    `Commands:\n\n` +
      `@${BOT_USERNAME} price\n` +
      `@${BOT_USERNAME} alert above 0.12\n` +
      `@${BOT_USERNAME} alert below 0.08\n` +
      `@${BOT_USERNAME} alert mcap above 10m\n` +
      `@${BOT_USERNAME} alert fdv below 20m\n` +
      `@${BOT_USERNAME} alert me when $ANSEM gets to $141M fdv\n` +
      `@${BOT_USERNAME} alerts\n` +
      `@${BOT_USERNAME} cancel`,
    tweet.id
  );
}

function extractTweets(search) {
  if (Array.isArray(search?.tweets)) return search.tweets;
  if (Array.isArray(search?.data?.data)) return search.data.data;
  if (Array.isArray(search?._realData?.data)) return search._realData.data;
  return [];
}

function extractUsers(search) {
  if (Array.isArray(search?.includes?.users)) return search.includes.users;
  if (Array.isArray(search?.data?.includes?.users)) return search.data.includes.users;
  if (Array.isArray(search?._realData?.includes?.users)) {
    return search._realData.includes.users;
  }
  return [];
}

async function processMentions(market) {
  const lastSeenId = await getState("last_seen_tweet_id");
  const searchOptions = {
    "tweet.fields": ["created_at", "author_id"],
    expansions: ["author_id"],
    "user.fields": ["username"],
    max_results: MAX_MENTIONS_PER_TICK,
  };

  if (lastSeenId !== "0") {
    searchOptions.since_id = lastSeenId;
  }

  const search = await rwClient.v2.search(`@${BOT_USERNAME} -is:retweet`, searchOptions);
  const tweets = extractTweets(search);
  const users = extractUsers(search);

  if (!tweets.length) return { processed: 0 };

  const userMap = new Map(users.map((user) => [user.id, user]));
  const sorted = tweets.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
  let newestId = lastSeenId;
  let processed = 0;

  for (const tweet of sorted) {
    newestId = BigInt(tweet.id) > BigInt(newestId) ? tweet.id : newestId;

    const user = userMap.get(tweet.author_id);
    if (!user) continue;

    const claimed = await claimTweet(tweet.id);
    if (!claimed) continue;

    try {
      await handleMention(tweet, user, market);
      processed += 1;
    } catch (err) {
      await releaseTweet(tweet.id);
      console.error("Mention handling failed", tweet.id, err);
    }
  }

  await setState("last_seen_tweet_id", newestId);
  return { processed };
}

async function processTriggeredAlerts(market) {
  const { data: alerts, error } = await supabase
    .from("alerts")
    .select("*")
    .eq("triggered", false)
    .is("trigger_claimed_at", null)
    .limit(MAX_ALERTS_PER_TICK);

  if (error) throw error;
  if (!alerts?.length) return { triggered: 0 };

  let triggered = 0;

  for (const alert of alerts) {
    const metric = alert.alert_metric || "price";
    const target = Number(alert.target_price);
    const currentValue = getMarketMetricValue(market, metric);
    const hit =
      alert.direction === "above"
        ? currentValue >= target
        : currentValue <= target;

    if (!hit) continue;

    try {
      const { data: claimedAlerts, error: claimError } = await supabase
        .from("alerts")
        .update({ trigger_claimed_at: new Date().toISOString() })
        .eq("id", alert.id)
        .eq("triggered", false)
        .is("trigger_claimed_at", null)
        .select("id");

      if (claimError) throw claimError;
      if (!claimedAlerts?.length) continue;

      await rwClient.v2.tweet({
        text:
          `HORN SIGNAL\n\n` +
          `@${alert.x_username} your $ANSEM alert hit.\n\n` +
          `Target: ${metricLabel(metric)} ${alert.direction} ${formatMetricValue(metric, target)}\n` +
          `Current: ${formatMetricValue(metric, currentValue)}\n\n` +
          `The Black Bull moved.`,
        reply: {
          in_reply_to_tweet_id: alert.source_tweet_id,
        },
      });

      const { error: updateError } = await supabase
        .from("alerts")
        .update({
          triggered: true,
          triggered_at: new Date().toISOString(),
        })
        .eq("id", alert.id)
        .eq("triggered", false);

      if (updateError) throw updateError;
      triggered += 1;
    } catch (err) {
      await supabase
        .from("alerts")
        .update({ trigger_claimed_at: null })
        .eq("id", alert.id)
        .eq("triggered", false);
      console.error("Trigger failed", alert.id, err);
    }
  }

  return { triggered };
}

async function shouldPostPublicPulse() {
  const last = Number(await getState("last_public_price_post_at"));
  return Date.now() - last >= PUBLIC_PULSE_INTERVAL_MS;
}

async function markPublicPulsePosted() {
  await setState("last_public_price_post_at", String(Date.now()));
}

async function shouldPostSignificantMovePulse(market) {
  const lastPulsePrice = Number(await getState("last_significant_pulse_price"));

  if (!lastPulsePrice || lastPulsePrice <= 0) {
    await setState("last_significant_pulse_price", String(market.price));
    return { shouldPost: false };
  }

  const changePercent = ((market.price - lastPulsePrice) / lastPulsePrice) * 100;

  if (changePercent >= SIGNIFICANT_UP_MOVE_PERCENT) {
    return {
      shouldPost: true,
      changePercent,
      fromPrice: lastPulsePrice,
    };
  }

  if (market.price < lastPulsePrice) {
    await setState("last_significant_pulse_price", String(market.price));
  }

  return { shouldPost: false };
}

async function postSignificantMovePulse(market, move) {
  await rwClient.v2.tweet(
    `BLACK BULL MOVE\n\n` +
      `$ANSEM is up ${move.changePercent.toFixed(2)}% since the last signal.\n\n` +
      `From: $${formatPrice(move.fromPrice)}\n` +
      `Now: $${formatPrice(market.price)}\n` +
      `24H: ${market.change24h.toFixed(2)}%\n` +
      `Liquidity: ${compactUsd(market.liquidity)}\n` +
      `Market Cap: ${compactUsd(market.marketCap)}\n\n` +
      `The Black Bull moved.`
  );

  await setState("last_significant_pulse_price", String(market.price));
  await markPublicPulsePosted();
}

async function postPublicPricePulse(market) {
  await rwClient.v2.tweet(
    `BLACK BULL PULSE\n\n` +
      `$ANSEM: $${formatPrice(market.price)}\n` +
      `24H: ${market.change24h.toFixed(2)}%\n` +
      `Liquidity: ${compactUsd(market.liquidity)}\n` +
      `Market Cap: ${compactUsd(market.marketCap)}\n\n` +
      `The trenches are watching.`
  );

  await markPublicPulsePosted();
}

export default async function handler(req, res) {
  try {
    assertEnv();
    initClients();

    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const market = await getAnsemPrice();
    const mentions = await processMentions(market);
    const alerts = await processTriggeredAlerts(market);
    let publicPulsePosted = false;
    let significantMovePosted = false;

    const significantMove = await shouldPostSignificantMovePulse(market);
    if (significantMove.shouldPost) {
      await postSignificantMovePulse(market, significantMove);
      significantMovePosted = true;
    }

    if (!significantMovePosted && (await shouldPostPublicPulse())) {
      await postPublicPricePulse(market);
      publicPulsePosted = true;
    }

    return res.json({
      ok: true,
      price: market.price,
      mentionsProcessed: mentions.processed,
      alertsTriggered: alerts.triggered,
      publicPulsePosted,
      significantMovePosted,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
