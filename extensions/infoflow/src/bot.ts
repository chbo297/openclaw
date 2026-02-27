import { resolveInfoflowAccount } from "./accounts.js";
import { getInfoflowBotLog, formatInfoflowError, logVerbose } from "./logging.js";
import { createInfoflowReplyDispatcher } from "./reply-dispatcher.js";
import { getInfoflowRuntime } from "./runtime.js";
import type {
  InfoflowChatType,
  InfoflowMessageEvent,
  HandleInfoflowMessageParams,
  HandlePrivateChatParams,
  HandleGroupChatParams,
} from "./types.js";

// Re-export types for external consumers
export type { InfoflowChatType, InfoflowMessageEvent } from "./types.js";

// ---------------------------------------------------------------------------
// @mention detection types and helpers
// ---------------------------------------------------------------------------

/**
 * Body item in Infoflow group message, supporting TEXT, AT, LINK types.
 */
type InfoflowBodyItem = {
  type?: string;
  content?: string;
  label?: string;
  /** Robot ID when type is AT */
  robotid?: number;
  /** Robot/user name when type is AT */
  name?: string;
};

/**
 * Check if the bot was @mentioned in the message body.
 * Matches configured robotName against AT elements (case-insensitive).
 */
function checkBotMentioned(bodyItems: InfoflowBodyItem[], robotName?: string): boolean {
  if (!robotName) {
    return false; // Cannot detect mentions without configured robotName
  }
  const normalizedRobotName = robotName.toLowerCase();
  for (const item of bodyItems) {
    if (item.type === "AT" && item.name) {
      if (item.name.toLowerCase() === normalizedRobotName) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if any name in the watchlist was @mentioned in the message body.
 * Returns the matched name, or undefined if none matched.
 */
function checkWatchMentioned(
  bodyItems: InfoflowBodyItem[],
  watchMentions: string[],
): string | undefined {
  if (!watchMentions.length) return undefined;
  const normalized = watchMentions.map((n) => n.toLowerCase());
  for (const item of bodyItems) {
    if (item.type === "AT" && item.name) {
      if (normalized.includes(item.name.toLowerCase())) {
        return item.name;
      }
    }
  }
  return undefined;
}

/**
 * Build a GroupSystemPrompt for watch-mention triggered messages.
 * Instructs the agent to reply only when confident, otherwise use NO_REPLY.
 */
function buildWatchMentionPrompt(mentionedName: string): string {
  return [
    `Someone in this group mentioned @${mentionedName}. You were not directly addressed, but you may be able to help.`,
    `Evaluate the message carefully:`,
    `- If you clearly understand the question and have high confidence you can provide a useful, accurate answer, reply helpfully.`,
    `- If the message is ambiguous, you lack sufficient context, or you are not confident, reply with exactly "NO_REPLY" (nothing else).`,
    `Err on the side of staying silent — only reply when you can genuinely add value.`,
  ].join(" ");
}

/**
 * Handles an incoming private chat message from Infoflow.
 * Receives the raw decrypted message data and dispatches to the agent.
 */
export async function handlePrivateChatMessage(params: HandlePrivateChatParams): Promise<void> {
  const { cfg, msgData, accountId, statusSink } = params;

  // Extract sender and content from msgData (flexible field names)
  const fromuser = String(msgData.FromUserId ?? msgData.fromuserid ?? msgData.from ?? "");
  const mes = String(msgData.Content ?? msgData.content ?? msgData.text ?? msgData.mes ?? "");

  // Extract sender name (FromUserName is more human-readable than FromUserId)
  const senderName = String(msgData.FromUserName ?? msgData.username ?? fromuser);

  // Extract message ID for dedup tracking
  const messageId = msgData.MsgId ?? msgData.msgid ?? msgData.messageid;
  const messageIdStr = messageId != null ? String(messageId) : undefined;

  // Extract timestamp (CreateTime is in seconds, convert to milliseconds)
  const createTime = msgData.CreateTime ?? msgData.createtime;
  const timestamp = createTime != null ? Number(createTime) * 1000 : Date.now();

  logVerbose(
    `[infoflow] private chat: fromuser=${fromuser}, senderName=${senderName}, raw msgData: ${JSON.stringify(msgData)}`,
  );

  if (!fromuser || !mes.trim()) {
    logVerbose(`[infoflow] private chat dropped: empty fromuser or mes, fromuser="${fromuser}"`);
    return;
  }

  // Delegate to the common message handler (private chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes,
      chatType: "direct",
      senderName,
      messageId: messageIdStr,
      timestamp,
    },
    accountId,
    statusSink,
  });
}

/**
 * Handles an incoming group chat message from Infoflow.
 * Receives the raw decrypted message data and dispatches to the agent.
 */
export async function handleGroupChatMessage(params: HandleGroupChatParams): Promise<void> {
  const { cfg, msgData, accountId, statusSink } = params;

  // Extract sender from nested structure or flat fields
  const header = (msgData.message as Record<string, unknown>)?.header as
    | Record<string, unknown>
    | undefined;
  const fromuser = String(header?.fromuserid ?? msgData.fromuserid ?? msgData.from ?? "");

  // Extract message ID (priority: header.messageid > header.msgid > MsgId)
  const messageId = header?.messageid ?? header?.msgid ?? msgData.MsgId;
  const messageIdStr = messageId != null ? String(messageId) : undefined;

  const rawGroupId = msgData.groupid ?? header?.groupid;
  const groupid =
    typeof rawGroupId === "number" ? rawGroupId : rawGroupId ? Number(rawGroupId) : undefined;

  // Extract timestamp (time is in milliseconds)
  const rawTime = msgData.time ?? header?.servertime;
  const timestamp = rawTime != null ? Number(rawTime) : Date.now();

  logVerbose(
    `[infoflow] group chat: fromuser=${fromuser}, groupid=${groupid}, raw msgData: ${JSON.stringify(msgData)}`,
  );

  if (!fromuser) {
    logVerbose(`[infoflow] group chat dropped: empty fromuser, groupid=${groupid}`);
    return;
  }

  // Extract message content from body array or flat content field
  const message = msgData.message as Record<string, unknown> | undefined;
  const bodyItems = (message?.body ?? msgData.body ?? []) as InfoflowBodyItem[];

  // Resolve account to get robotName for mention detection
  const account = resolveInfoflowAccount({ cfg, accountId });
  const robotName = account.config.robotName;

  // Check if bot was @mentioned
  const wasMentioned = checkBotMentioned(bodyItems, robotName);

  // Build two versions: mes (for CommandBody, no @xxx) and rawMes (for RawBody, with @xxx)
  let textContent = "";
  let rawTextContent = "";
  if (Array.isArray(bodyItems)) {
    for (const item of bodyItems) {
      if (item.type === "TEXT") {
        textContent += item.content ?? "";
        rawTextContent += item.content ?? "";
      } else if (item.type === "LINK") {
        const label = item.label ?? "";
        if (label) {
          textContent += ` ${label} `;
          rawTextContent += ` ${label} `;
        }
      } else if (item.type === "AT") {
        // AT elements only go into rawTextContent, not textContent
        const name = item.name ?? "";
        if (name) {
          rawTextContent += `@${name} `;
        }
      }
    }
  }

  const mes = textContent.trim() || String(msgData.content ?? msgData.text ?? "");
  const rawMes = rawTextContent.trim() || mes;

  if (!mes) {
    logVerbose(
      `[infoflow] group chat dropped: empty mes after parsing, fromuser=${fromuser}, groupid=${groupid}`,
    );
    return;
  }

  // Extract sender name from header or fallback to fromuser
  const senderName = String(header?.username ?? header?.nickname ?? msgData.username ?? fromuser);

  // Delegate to the common message handler (group chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes,
      rawMes,
      chatType: "group",
      groupId: groupid,
      senderName,
      wasMentioned,
      messageId: messageIdStr,
      timestamp,
      bodyItems,
    },
    accountId,
    statusSink,
  });
}

/**
 * Resolves route, builds envelope, records session meta, and dispatches reply for one incoming Infoflow message.
 * Called from monitor after webhook request is validated.
 */
export async function handleInfoflowMessage(params: HandleInfoflowMessageParams): Promise<void> {
  const { cfg, event, accountId, statusSink } = params;
  const { fromuser, mes, chatType, groupId, senderName } = event;

  const account = resolveInfoflowAccount({ cfg, accountId });
  const core = getInfoflowRuntime();

  logVerbose(
    `[infoflow] handleInfoflowMessage invoked: accountId=${accountId}, chatType=${event.chatType}, fromuser=${event.fromuser}, groupId=${event.groupId}`,
  );

  const isGroup = chatType === "group";
  // Convert groupId (number) to string for peerId since routing expects string
  const peerId = isGroup ? (groupId !== undefined ? String(groupId) : fromuser) : fromuser;

  // Resolve route based on chat type
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "infoflow",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Build conversation label and from address based on chat type
  const fromLabel = isGroup ? `group:${groupId}` : senderName || fromuser;
  const fromAddress = isGroup ? `infoflow:group:${groupId}` : `infoflow:${fromuser}`;
  const toAddress = isGroup ? `infoflow:${groupId}` : `infoflow:${account.accountId}`;

  logVerbose(`[infoflow] dispatch: chatType=${chatType}, agentId=${route.agentId}`);

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Infoflow",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: mes,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: event.rawMes ?? mes,
    CommandBody: mes,
    From: fromAddress,
    To: toAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: isGroup ? `group:${groupId}` : undefined,
    SenderName: senderName || fromuser,
    SenderId: fromuser,
    Provider: "infoflow",
    Surface: "infoflow",
    MessageSid: event.messageId ?? `${Date.now()}`,
    Timestamp: event.timestamp ?? Date.now(),
    OriginatingChannel: "infoflow",
    OriginatingTo: toAddress,
    WasMentioned: isGroup ? event.wasMentioned : undefined,
    CommandAuthorized: true,
  });

  // Record session using recordInboundSession for proper session tracking
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      getInfoflowBotLog().error(
        `[infoflow] failed updating session meta (sessionKey=${route.sessionKey}, accountId=${accountId}): ${formatInfoflowError(err)}`,
      );
    },
  });

  // Mention gating: skip reply if requireMention is enabled and bot was not mentioned
  // Session is already recorded above for context history
  if (isGroup) {
    const requireMention = account.config.requireMention !== false;
    const canDetectMention = Boolean(account.config.robotName);
    const wasMentioned = event.wasMentioned === true;

    // When requireMention is enabled, only reply if canDetectMention AND wasMentioned
    const shouldReply = !requireMention || (canDetectMention && wasMentioned);

    if (!shouldReply) {
      // Check if someone on the watch list was @mentioned as a fallback
      const watchMentions = account.config.watchMentions ?? [];
      const matchedWatchName =
        watchMentions.length > 0 && event.bodyItems
          ? checkWatchMentioned(event.bodyItems, watchMentions)
          : undefined;

      if (!matchedWatchName) {
        logVerbose(
          `[infoflow] group chat skipped: not mentioned, fromuser=${fromuser}, groupId=${groupId}`,
        );
        return; // No bot mention, no watch mention -> stay silent
      }

      // Watch-mention triggered: instruct agent to reply only if confident
      ctxPayload.GroupSystemPrompt = buildWatchMentionPrompt(matchedWatchName);
    }
  }

  // Build unified target: "group:<id>" for group chat, username for private chat
  const to = isGroup && groupId !== undefined ? `group:${groupId}` : fromuser;

  const { dispatcherOptions, replyOptions } = createInfoflowReplyDispatcher({
    cfg,
    agentId: route.agentId,
    accountId: account.accountId,
    to,
    statusSink,
    // @mention the sender back when bot was directly @mentioned in a group
    atOptions: isGroup && event.wasMentioned ? { atUserIds: [fromuser] } : undefined,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions,
    replyOptions,
  });

  logVerbose(`[infoflow] dispatch complete: ${chatType} from ${fromuser}`);
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal)
// ---------------------------------------------------------------------------

/** @internal — Check if bot was mentioned in message body. Only exported for tests. */
export const _checkBotMentioned = checkBotMentioned;

/** @internal — Check if any watch-list name was @mentioned. Only exported for tests. */
export const _checkWatchMentioned = checkWatchMentioned;
