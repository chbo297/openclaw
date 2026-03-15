import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  recordPendingHistoryEntryIfEnabled,
  buildAgentMediaPayload,
} from "openclaw/plugin-sdk";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/mattermost";
import { resolveInfoflowAccount } from "./accounts.js";
import { getInfoflowBotLog, formatInfoflowError, logVerbose } from "./logging.js";
import { createInfoflowReplyDispatcher } from "./reply-dispatcher.js";
import { getInfoflowRuntime } from "./runtime.js";
import { findSentMessage } from "./sent-message-store.js";
import type {
  InfoflowChatType,
  InfoflowMessageEvent,
  InfoflowMentionIds,
  InfoflowReplyMode,
  InfoflowGroupConfig,
  HandleInfoflowMessageParams,
  HandlePrivateChatParams,
  HandleGroupChatParams,
  ResolvedInfoflowAccount,
} from "./types.js";

// Re-export types for external consumers
export type { InfoflowChatType, InfoflowMessageEvent } from "./types.js";

// ---------------------------------------------------------------------------
// @mention detection types and helpers
// ---------------------------------------------------------------------------

/**
 * Body item in Infoflow group message, supporting TEXT, AT, LINK types.
 * For AT items: robot mentions have `robotid` (number), human mentions have `userid` (string).
 * These two fields are mutually exclusive.
 */
type InfoflowBodyItem = {
  type?: string;
  content?: string;
  label?: string;
  /** 机器人 AT 时有此字段（数字），与 userid 互斥 */
  robotid?: number;
  /** AT 元素的显示名称 */
  name?: string;
  /** 人类用户 AT 时有此字段（uuap name），与 robotid 互斥 */
  userid?: string;
  /** IMAGE 类型 body item 的图片下载地址 */
  downloadurl?: string;
  /** replyData 类型 body item 中被引用消息的 ID */
  messageid?: string | number;
};

/**
 * Check if the bot was @mentioned in the message body.
 * Matches by robotName against the AT item's display name (case-insensitive).
 */
function checkBotMentioned(bodyItems: InfoflowBodyItem[], robotName?: string): boolean {
  if (!robotName) return false;
  const normalizedRobotName = robotName.toLowerCase();
  for (const item of bodyItems) {
    if (item.type !== "AT") continue;
    if (item.name?.toLowerCase() === normalizedRobotName) return true;
  }
  return false;
}

/**
 * When the bot is @mentioned (item.name matches robotName), return that AT item's robotid.
 * Used to discover and persist the account's robotId from incoming group messages.
 */
function getBotRobotidFromBody(
  bodyItems: InfoflowBodyItem[],
  robotName?: string,
): number | undefined {
  if (!robotName) return undefined;
  const normalizedRobotName = robotName.toLowerCase();
  for (const item of bodyItems) {
    if (item.type !== "AT") continue;
    if (item.name?.toLowerCase() === normalizedRobotName && item.robotid != null)
      return item.robotid;
  }
  return undefined;
}

/**
 * Check if any entry in the watchlist was @mentioned in the message body.
 * Matching priority: userid > robotid (parsed as number) > name (fallback).
 * Returns the matched ID (from watchMentions), or undefined if none matched.
 */
function checkWatchMentioned(
  bodyItems: InfoflowBodyItem[],
  watchMentions: string[],
): string | undefined {
  if (!watchMentions.length) return undefined;
  const normalizedIds = watchMentions.map((n) => n.toLowerCase());
  // Pre-parse numeric entries for robotid matching
  const numericIds = watchMentions.map((n) => {
    const num = Number(n);
    return Number.isFinite(num) ? num : null;
  });

  for (const item of bodyItems) {
    if (item.type !== "AT") continue;

    // Priority 1: match userid (human AT)
    if (item.userid) {
      const idx = normalizedIds.indexOf(item.userid.toLowerCase());
      if (idx !== -1) return watchMentions[idx];
    }

    // Priority 2: match robotid (robot AT, watchMentions entry parsed as number)
    if (item.robotid != null) {
      const idx = numericIds.indexOf(item.robotid);
      if (idx !== -1) return watchMentions[idx];
    }

    // Priority 3: match by display name (fallback to name-based lookup)
    if (item.name) {
      const idx = normalizedIds.indexOf(item.name.toLowerCase());
      if (idx !== -1) return watchMentions[idx];
    }
  }
  return undefined;
}

/** Normalize watchRegex config to string[] (supports legacy single string). */
function normalizeWatchRegex(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Check if message content matches any of the configured watchRegex patterns. Uses "s" (dotAll) so that . matches newlines. */
function checkWatchRegex(mes: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, "is").test(mes)) return true;
    } catch {
      // skip invalid pattern
    }
  }
  return false;
}

/** Return the first matching pattern index, or -1 if none match. Used for triggerReason and prompt. */
function findMatchingWatchRegex(mes: string, patterns: string[]): number {
  for (let i = 0; i < patterns.length; i++) {
    try {
      if (new RegExp(patterns[i], "is").test(mes)) return i;
    } catch {
      // skip invalid pattern
    }
  }
  return -1;
}

/**
 * Extract non-bot mention IDs from inbound group message body items.
 * Returns human userIds and robot agentIds (excluding the bot itself, matched by robotName).
 */
function extractMentionIds(bodyItems: InfoflowBodyItem[], robotName?: string): InfoflowMentionIds {
  const normalizedRobotName = robotName?.toLowerCase();
  const userIds: string[] = [];
  const agentIds: number[] = [];
  const seenUsers = new Set<string>();
  const seenAgents = new Set<number>();

  for (const item of bodyItems) {
    if (item.type !== "AT") continue;

    if (item.robotid != null) {
      // Skip the bot itself (matched by name)
      if (normalizedRobotName && item.name?.toLowerCase() === normalizedRobotName) continue;
      if (!seenAgents.has(item.robotid)) {
        seenAgents.add(item.robotid);
        agentIds.push(item.robotid);
      }
    } else if (item.userid) {
      const key = item.userid.toLowerCase();
      if (!seenUsers.has(key)) {
        seenUsers.add(key);
        userIds.push(item.userid);
      }
    }
  }
  return { userIds, agentIds };
}

/** Check if the message @mentions other bots or human users (excluding the bot itself). */
function hasOtherMentions(mentionIds?: InfoflowMentionIds): boolean {
  if (!mentionIds) return false;
  return mentionIds.userIds.length > 0 || mentionIds.agentIds.length > 0;
}

/** True if this AT item is an "other" mention (another bot or another human), not this bot. */
function isOtherMentionItem(item: InfoflowBodyItem, agentIdSet: Set<number>): boolean {
  if (item.type !== "AT") return false;
  if (item.robotid != null && agentIdSet.has(item.robotid)) return true;
  if (item.userid) return true;
  return false;
}

/**
 * Concatenate text content from body items before the first AT.
 * Used to decide whether to add "对 xxx 说：" prefix (only when this text, stripped, has length <= 4).
 */
function getTextBeforeFirstAt(bodyItems: InfoflowBodyItem[] | undefined): string {
  if (!bodyItems?.length) return "";
  let out = "";
  for (const item of bodyItems) {
    if (item.type === "AT") break;
    if (item.type === "TEXT" || item.type === "MD") out += item.content ?? "";
  }
  return out;
}

/**
 * Display names for leading consecutive "other" ATs (name only; used for "对 xxx 说：").
 * Returns null if there are no leading other ATs.
 */
function getLeadingOtherMentionNames(
  bodyItems: InfoflowBodyItem[] | undefined,
  mentionIds: InfoflowMentionIds | undefined,
): string | null {
  if (!bodyItems?.length || !mentionIds) return null;
  const agentIdSet = new Set(mentionIds.agentIds);
  const names: string[] = [];
  for (const item of bodyItems) {
    if (item.type !== "AT") break;
    if (!isOtherMentionItem(item, agentIdSet)) continue;
    const label =
      item.name?.trim() || (item.robotid != null ? `ID ${item.robotid}` : (item.userid ?? ""));
    if (label) names.push(label);
  }
  return names.length > 0 ? names.join("、") : null;
}

/**
 * Full label for leading "other" ATs in same format as bodyForAgent (e.g. "地图不打烊 (robotid:4105001326)").
 * Used to build "对 xxx 说: rest" so the model sees the same identifier.
 */
function getLeadingOtherMentionLabelFull(
  bodyItems: InfoflowBodyItem[] | undefined,
  mentionIds: InfoflowMentionIds | undefined,
): string | null {
  if (!bodyItems?.length || !mentionIds) return null;
  const agentIdSet = new Set(mentionIds.agentIds);
  const labels: string[] = [];
  for (const item of bodyItems) {
    if (item.type !== "AT") break;
    if (!isOtherMentionItem(item, agentIdSet)) continue;
    const label =
      item.robotid != null
        ? `${item.name?.trim() ?? "ID"} (robotid:${item.robotid})`
        : item.userid
          ? item.name?.trim()
            ? `${item.name} (${item.userid})`
            : item.userid
          : (item.name?.trim() ?? "");
    if (label) labels.push(label);
  }
  return labels.length > 0 ? labels.join("、") : null;
}

/**
 * Content after the leading "other" ATs (TEXT/MD concatenation from bodyItems).
 */
function getRestAfterLeadingOtherAts(
  bodyItems: InfoflowBodyItem[] | undefined,
  mentionIds: InfoflowMentionIds | undefined,
): string {
  if (!bodyItems?.length || !mentionIds) return "";
  const agentIdSet = new Set(mentionIds.agentIds);
  let i = 0;
  while (
    i < bodyItems.length &&
    bodyItems[i].type === "AT" &&
    isOtherMentionItem(bodyItems[i], agentIdSet)
  ) {
    i++;
  }
  let out = "";
  for (; i < bodyItems.length; i++) {
    const item = bodyItems[i];
    if (item.type === "TEXT" || item.type === "MD") out += item.content ?? "";
  }
  return out.trimStart();
}

/** Strip whitespace and punctuation to measure "content" length (for ≤4 check). */
function stripPunctuationAndWhitespace(s: string): string {
  return s.replace(/\s/g, "").replace(/[\p{P}\p{S}]/gu, "");
}

/**
 * Get human-readable "name (ID)" for each other-mentioned entity (bot or human) from body items.
 * Used in followUp-other-mentioned to inject an explicit reminder so the LLM does not
 * confuse itself with the @mentioned person/bot (e.g. "你" in "@地图不打烊 你讲个笑话" refers to 地图不打烊).
 */
function getOtherMentionedDisplayNames(
  bodyItems: InfoflowBodyItem[] | undefined,
  mentionIds: InfoflowMentionIds | undefined,
): string[] {
  if (!bodyItems?.length || !mentionIds) return [];
  const agentIdSet = new Set(mentionIds.agentIds);
  const userIdSetLower = new Set(mentionIds.userIds.map((id) => id.toLowerCase()));
  const names: string[] = [];
  for (const item of bodyItems) {
    if (item.type !== "AT") continue;
    if (item.robotid != null && agentIdSet.has(item.robotid)) {
      const label = item.name?.trim() ? `${item.name} (ID ${item.robotid})` : `ID ${item.robotid}`;
      names.push(label);
    } else if (item.userid && userIdSetLower.has(item.userid.toLowerCase())) {
      const label = item.name?.trim() ? `${item.name} (${item.userid})` : item.userid;
      names.push(label);
    }
  }
  return [...new Set(names)];
}

/**
 * When in follow-up window and message has other @mentions (not this bot): record only and
 * return "record_only" (no LLM dispatch). Otherwise return "dispatch".
 */
function resolveFollowUpOtherMentioned(params: {
  mentionIds: InfoflowMentionIds | undefined;
  groupId: number | undefined;
  bodyForAgent: string;
  senderName: string;
  fromuser: string;
}): "record_only" | "dispatch" {
  const { mentionIds, groupId, bodyForAgent, senderName, fromuser } = params;
  if (!hasOtherMentions(mentionIds)) return "dispatch";
  const groupIdStr = groupId != null ? String(groupId) : undefined;
  if (groupIdStr) {
    recordPendingHistoryEntryIfEnabled({
      historyMap: chatHistories,
      historyKey: groupIdStr,
      entry: {
        sender: senderName || fromuser,
        body: bodyForAgent,
        timestamp: Date.now(),
      },
      limit: DEFAULT_GROUP_HISTORY_LIMIT,
    });
  }
  logVerbose(
    `[infoflow:bot] skip dispatch: from=${fromuser}, group=${groupId}, reason=followUp-other-mentioned (record only, no LLM)`,
  );
  return "record_only";
}

// ---------------------------------------------------------------------------
// Reply-to-bot detection (引用回复机器人消息)
// ---------------------------------------------------------------------------

/**
 * Check if the message is a reply (引用回复) to one of the bot's own messages.
 * Looks up replyData body items' messageid against the sent-message-store.
 */
function checkReplyToBot(bodyItems: InfoflowBodyItem[], accountId: string): boolean {
  for (const item of bodyItems) {
    if (item.type !== "replyData") continue;
    const msgId = item.messageid;
    if (msgId == null) continue;
    const msgIdStr = String(msgId);
    if (!msgIdStr) continue;
    try {
      const found = findSentMessage(accountId, msgIdStr);
      if (found) return true;
    } catch {
      // DB lookup failure should not block message processing
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared reply judgment rules (reused across prompt builders)
// ---------------------------------------------------------------------------

/** Shared judgment rules and reply format requirements for all conditional-reply prompts */
function buildReplyJudgmentRules(): string {
  return [
    "# Rules for Group Message Response",
    "",
    "## When to Reply",
    "",
    "Reply if ANY of the following is true:",
    "- The message is directed at you — either by explicit mention, or by contextual signals suggesting the user expects your response (e.g., a question following your previous reply, a topic clearly within your role, or conversational flow implying you are the intended recipient)",
    "- The message contains a clear question or request that you can answer using your knowledge, skills, tools, or reasoning",
    "- You have relevant domain expertise, documentation, or codebase context that adds value",
    "",
    "## When NOT to Reply — output only `NO_REPLY`",
    "",
    "Do NOT reply if ANY of the following is true:",
    "- The message is casual chatter, banter, emoji-only, or has no actionable question/request",
    "- The user explicitly indicates they don't want your response",
    "- The message is directed at another person, not at you",
    "- You lack the context or knowledge to give a useful answer (e.g., private/internal info you don't have access to)",
    "- The message intent is ambiguous and a wrong guess would be more disruptive than silence",
    "",
    "## Response Format",
    "",
    "- If you can answer: respond directly and concisely. Do not explain why you chose to answer. Do not add filler or pleasantries.",
    "- If you cannot answer: output exactly `NO_REPLY` — nothing else, no explanation, no apology.",
    "",
    "## Guiding Principle",
    "",
    "When in doubt, prefer silence (`NO_REPLY`). A missing reply is far less disruptive than an irrelevant or incorrect one in a group chat.",
  ].join("\n");
}

/**
 * Build a GroupSystemPrompt for watch-mention triggered messages.
 * Instructs the agent to reply only when confident, otherwise use NO_REPLY.
 */
function buildWatchMentionPrompt(mentionedId: string): string {
  return [
    `Someone in the group @mentioned ${mentionedId}. As ${mentionedId}'s assistant, you observed this message.`,
    "Decide whether you can answer on their behalf or provide help.",
    "",
    buildReplyJudgmentRules(),
    "",
    "# Examples",
    "",
    'Message: "What is 1+1?"',
    "→ 2",
    "",
    'Message: "What is the qt parameter for search requests in the client code?"',
    "(Assuming documentation records qt=s)",
    "→ According to the documentation, the qt parameter for search requests is qt=s",
    "",
    'Message: "asdfghjkl random gibberish"',
    "→ NO_REPLY",
    "",
    'Message: "Can you check today\'s release progress?"',
    "(Assuming no relevant information available)",
    "→ NO_REPLY",
  ].join("\n");
}

/**
 * Build a GroupSystemPrompt for watch-content triggered messages.
 * Instructs the agent to reply only when confident, otherwise use NO_REPLY.
 */
function buildWatchRegexPrompt(patterns: string[]): string {
  const label = patterns.length ? `(${patterns.join(" | ")})` : "";
  return [
    `The message content matched one of the configured watch patterns ${label}.`,
    "As the group assistant, you observed this message. Decide whether you can provide help or a valuable reply.",
    "",
    buildReplyJudgmentRules(),
  ].join("\n");
}

/**
 * Build a GroupSystemPrompt for follow-up replies after bot's last response.
 * Uses three-tier semantic priority: (1) intent to talk to bot → must reply,
 * (2) explicit stop request → must not reply, (3) topic continuity judgment.
 *
 * When isReplyToBot is true, injects a strong signal that the user quoted the bot's message.
 */
function buildFollowUpPrompt(isReplyToBot: boolean): string {
  const lines: string[] = [
    "You just replied to a message in this group. Someone has now sent a new message.",
    "Follow the priority rules below **in order** to decide whether to reply.",
    "",
  ];

  if (isReplyToBot) {
    lines.push(
      "**Important context: this message is a quoted reply to your previous message. This is a strong signal that the user is following up with you.**",
      "",
    );
  }

  lines.push(
    "# Priority 1: The sender intends to talk to you → MUST reply",
    "",
    "Based on semantic analysis, if the sender shows ANY of the following intents or expectations, you **MUST** reply (do NOT output NO_REPLY):",
    "- Asking a follow-up question about your previous answer (e.g. 'why?', 'what else?', 'what if...?')",
    "- Quoted/replied to your message (indicating a conversation with you)",
    "- Addressing you by name, or using words like 'bot', 'assistant', etc.",
    "- Requesting you to do something (e.g. 'help me...', 'explain...', 'translate...')",
    "- Semantically expects a reply from you",
    "",
    "# Priority 2: Explicitly asking you to stop → MUST NOT reply",
    "",
    "If the message explicitly tells you to stop replying (e.g. 'shut up', 'stop', 'don't reply',",
    "'no need for bot', or equivalent expressions in any language),",
    "output only NO_REPLY.",
    "",
    "# Priority 3: No explicit intent → Judge topic continuity",
    "",
    "If neither Priority 1 nor Priority 2 applies:",
    "- If the message continues the same topic you previously replied to, and you can provide valuable help → reply.",
    "- If it is a new/unrelated topic, or you cannot add value → output only NO_REPLY.",
    "",
    buildReplyJudgmentRules(),
  );

  return lines.join("\n");
}

/**
 * Build a GroupSystemPrompt for follow-up messages that @mention another person or bot.
 * Default NO_REPLY; reply only when the message is clearly directed at the bot, not the @mentioned.
 */
function buildFollowUpOtherMentionedPrompt(): string {
  return [
    "You were NOT @mentioned in this message. The @ refers to another person or bot, not you.",
    "You recently replied in this group. A new message has arrived, but it @mentions someone else.",
    "",
    "# Core Principle",
    "",
    "Default: NO_REPLY. The @mention almost certainly means the sender is talking to THEM, not you.",
    "",
    "# Analysis Steps",
    "",
    "## Step 1: Strip pronouns to reveal true structure",
    "",
    "Rewrite the message by removing all instances of 你/您 (or 'you' in English).",
    "Compare the original and the stripped version:",
    "- If the stripped version still makes sense as a command/question directed at the @mentioned person → the 你 was addressing them.",
    "  Original:  '@lisi 你来看看这个接口为什么报错'",
    "  Stripped:  '@lisi 来看看这个接口为什么报错'",
    "  → Meaning unchanged. 你 = @lisi. NOT you.",
    "",
    "- If removing 你 breaks a clause that has NO syntactic connection to the @mention → that 你 MIGHT address you.",
    "  Original:  '工程部负责人是 @zhangsan，我去找他了，你还有什么要说的吗'",
    "  Stripped:  '工程部负责人是 @zhangsan，我去找他了，还有什么要说的吗'",
    "  → The last clause loses its subject; it was a separate question directed at you (continuing prior conversation). 你 = you.",
    "",
    "## Step 2: Identify the action and intended performer",
    "",
    "Based on the stripped message, determine:",
    "- What ACTION does the sender want performed?",
    "- WHO is expected to perform it — the @mentioned person, the sender themselves, or you?",
    "",
    "## Step 3: Decide",
    "",
    "- If Step 1 shows all 你 refer to the @mentioned person → NO_REPLY.",
    "- If Step 1 is ambiguous → NO_REPLY. Do not guess.",
    "- If Step 1 clearly shows a 你 addressing you, AND Step 2 confirms the sender is directing speech at you → REPLY.",
    "",
    "# Decision Rules",
    "",
    "## NO_REPLY (default, ~95% of cases)",
    "",
    "Output NO_REPLY if ANY is true:",
    "- The sender is talking to / assigning to / asking the @mentioned person",
    "- You cannot confidently determine who 你 refers to",
    "- The message is casual chat or social coordination with the @mentioned person",
    "",
    "Examples:",
    "  '@lisi 你觉得呢'",
    "  Strip → '@lisi 觉得呢' → still a question to @lisi. → NO_REPLY.",
    "",
    "  '这个问题 @lisi 你和他都看看吧'",
    "  Strip → '这个问题 @lisi 和他都看看吧' → task assigned to @lisi+他. 你=@lisi. → NO_REPLY.",
    "",
    "  '@lisi 你从日志开始排查一下'",
    "  Strip → '@lisi 从日志开始排查一下' → debug task to @lisi. → NO_REPLY.",
    "",
    "## REPLY (requires BOTH conditions)",
    "",
    "Reply ONLY when BOTH are confirmed:",
    "  (a) The @mention is informational (a name, a reference), not the addressee",
    "  (b) The sender is clearly directing speech at you (continuing your conversation, asking you a question)",
    "",
    "Example:",
    "  Prior context — you said: '这个事情需要找隔壁工程部门的人'",
    "  New message: '好的，工程部门负责人是 @zhangsan，我去找他了，你还有什么要说的吗'",
    "  Strip → '好的，工程部门负责人是 @zhangsan，我去找他了，还有什么要说的吗'",
    "  → @zhangsan is referenced as info. The orphaned clause continues YOUR conversation. → REPLY.",
    "",
    "## Emergency Override (rare)",
    "",
    "Interject even if the message targets the @mentioned person ONLY when:",
    "- The suggested action would cause SEVERE, hard-to-reverse damage (production data loss, security breach, financial loss)",
    "- Silence would be irresponsible",
    "",
    "  '@lisi 你直接把线上数据库的表 drop 掉重建就行了' → REPLY. Production data loss risk.",
    "  '@lisi 你用 println 打个日志看看吧' → NO_REPLY. Harmless.",
  ].join("\n");
}

/**
 * Build a GroupSystemPrompt for proactive mode.
 * Instructs the agent to think about the message and reply when helpful.
 */
function buildProactivePrompt(): string {
  return [
    "You observed this message in the group. Decide whether you can provide help or a valuable reply.",
    "If you need more context or clarification, you may ask follow-up questions.",
    "",
    buildReplyJudgmentRules(),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Group reply tracking (in-memory) for follow-up window
// ---------------------------------------------------------------------------

/** In-memory map tracking bot's last reply timestamp per group */
const groupLastReplyMap = new Map<string, number>();

/** In-memory map accumulating recent group messages for context injection when bot is @mentioned */
const chatHistories = new Map<string, HistoryEntry[]>();

/** Record that the bot replied to a group (called after successful send) */
export function recordGroupReply(groupId: string): void {
  groupLastReplyMap.set(groupId, Date.now());
}

/** Check if a group is within the follow-up window */
function isWithinFollowUpWindow(groupId: string, windowSeconds: number): boolean {
  const lastReply = groupLastReplyMap.get(groupId);
  if (!lastReply) return false;
  return Date.now() - lastReply < windowSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Group config resolution
// ---------------------------------------------------------------------------

type ResolvedGroupConfig = {
  replyMode: InfoflowReplyMode;
  followUp: boolean;
  followUpWindow: number;
  watchMentions: string[];
  watchRegex: string[];
  systemPrompt?: string;
};

/** Infer replyMode from legacy requireMention + watchMentions fields */
function inferLegacyReplyMode(account: ResolvedInfoflowAccount): InfoflowReplyMode {
  const requireMention = account.config.requireMention !== false;
  const hasWatch = (account.config.watchMentions ?? []).length > 0;
  if (!requireMention) return "proactive";
  if (hasWatch) return "mention-and-watch";
  return "mention-only";
}

/** Resolve effective group config by merging group-level → account-level → legacy defaults */
function resolveGroupConfig(
  account: ResolvedInfoflowAccount,
  groupId?: number,
): ResolvedGroupConfig {
  const groupCfg: InfoflowGroupConfig | undefined =
    groupId != null ? account.config.groups?.[String(groupId)] : undefined;
  return {
    replyMode: groupCfg?.replyMode ?? account.config.replyMode ?? inferLegacyReplyMode(account),
    followUp: groupCfg?.followUp ?? account.config.followUp ?? true,
    followUpWindow: groupCfg?.followUpWindow ?? account.config.followUpWindow ?? 300,
    watchMentions: groupCfg?.watchMentions ?? account.config.watchMentions ?? [],
    watchRegex: normalizeWatchRegex(groupCfg?.watchRegex ?? account.config.watchRegex),
    systemPrompt: groupCfg?.systemPrompt,
  };
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

  // Detect image messages: MsgType=image with PicUrl
  const msgType = String(msgData.MsgType ?? msgData.msgtype ?? "");
  const picUrl = String(msgData.PicUrl ?? msgData.picurl ?? "");
  const imageUrls: string[] = [];
  if (msgType === "image" && picUrl.trim()) {
    imageUrls.push(picUrl.trim());
  }

  logVerbose(
    `[infoflow] private chat: fromuser=${fromuser}, senderName=${senderName}, mes=${mes}, msgType=${msgType}, raw msgData: ${JSON.stringify(msgData)}`,
  );

  if (!fromuser || (!mes.trim() && imageUrls.length === 0)) {
    return;
  }

  // For image-only messages (no text), use placeholder
  let effectiveMes = mes.trim();
  if (!effectiveMes && imageUrls.length > 0) {
    effectiveMes = "<media:image>";
  }

  // Delegate to the common message handler (private chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes: effectiveMes,
      chatType: "direct",
      senderName,
      messageId: messageIdStr,
      timestamp,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
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

  logVerbose(`[infoflow] group chat: raw msgData: ${JSON.stringify(msgData)}`);

  // Extract sender from nested structure or flat fields.
  // Some Infoflow events (including bot-authored forwards) only populate `fromid` on the root,
  // so include msgData.fromid as a final fallback.
  const header = (msgData.message as Record<string, unknown>)?.header as
    | Record<string, unknown>
    | undefined;
  const fromuser = String(
    header?.fromuserid ?? msgData.fromuserid ?? msgData.from ?? msgData.fromid ?? "",
  );

  // Extract message ID (priority: header.messageid > header.msgid > MsgId)
  const messageId = header?.messageid ?? header?.msgid ?? msgData.MsgId;
  const messageIdStr = messageId != null ? String(messageId) : undefined;

  const rawGroupId = msgData.groupid ?? header?.groupid;
  const groupid =
    typeof rawGroupId === "number" ? rawGroupId : rawGroupId ? Number(rawGroupId) : undefined;

  // Extract timestamp (time is in milliseconds)
  const rawTime = msgData.time ?? header?.servertime;
  const timestamp = rawTime != null ? Number(rawTime) : Date.now();

  if (!fromuser) {
    return;
  }

  // Extract message content from body array or flat content field
  const message = msgData.message as Record<string, unknown> | undefined;
  const bodyItems = (message?.body ?? msgData.body ?? []) as InfoflowBodyItem[];

  // Resolve account to get robotName for mention detection
  const account = resolveInfoflowAccount({ cfg, accountId });
  const robotName = account.config.robotName;

  // Check if bot was @mentioned (by robotName)
  const wasMentioned = checkBotMentioned(bodyItems, robotName);

  // When bot is @mentioned, discover and persist robotId from the AT item so we can ignore our own messages later.
  let effectiveRobotId = account.config.robotId?.trim() || undefined;
  const discoveredRobotid = getBotRobotidFromBody(bodyItems, robotName);
  if (wasMentioned && discoveredRobotid != null) {
    const newRobotId = String(discoveredRobotid);
    if (newRobotId !== effectiveRobotId) {
      try {
        const runtime = getInfoflowRuntime();
        const cfg = runtime.config.loadConfig();
        const channel = (cfg.channels ?? {}) as Record<string, unknown>;
        const infoflow = (channel.infoflow ?? {}) as Record<string, unknown>;
        const accounts = { ...((infoflow.accounts ?? {}) as Record<string, unknown>) };
        const accountCfg = {
          ...((accounts[accountId] ?? {}) as Record<string, unknown>),
          robotId: newRobotId,
        };
        accounts[accountId] = accountCfg;
        (infoflow as Record<string, unknown>).accounts = accounts;
        (channel as Record<string, unknown>).infoflow = infoflow;
        (cfg as Record<string, unknown>).channels = channel;
        await runtime.config.writeConfigFile(cfg);
        logVerbose(
          `[infoflow] group chat: persisted robotId=${newRobotId} for account ${accountId}`,
        );
      } catch (e) {
        getInfoflowBotLog().warn(`[infoflow] failed to persist robotId: ${formatInfoflowError(e)}`);
      }
    }
    effectiveRobotId = newRobotId;
  }

  // Ignore our own bot messages: only when robotId is set, treat fromid === robotId as own message.
  const fromid = msgData.fromid;
  if (effectiveRobotId != null && effectiveRobotId !== "" && fromid != null && fromid !== "") {
    if (String(fromid) === effectiveRobotId) {
      logVerbose(
        `[infoflow] group chat: ignoring own bot message (fromid=${fromid}, robotId=${effectiveRobotId})`,
      );
      return;
    }
  }

  // Extract non-bot mention IDs (userIds + agentIds) for LLM-driven @mentions
  const mentionIds = extractMentionIds(bodyItems, robotName);

  // Build three versions: mes (for CommandBody, no @xxx), rawMes (for RawBody, with @xxx),
  // and bodyForAgent (for LLM: @name with robotid when present so model sees "@地图不打烊 (robotid:N)")
  let textContent = "";
  let rawTextContent = "";
  let agentVisibleText = "";
  const replyContextItems: string[] = [];
  const imageUrls: string[] = [];
  if (Array.isArray(bodyItems)) {
    for (const item of bodyItems) {
      if (item.type === "replyData") {
        // 引用回复：提取被引用消息的内容（可能有多条引用）
        const replyBody = (item.content ?? "").trim();
        if (replyBody) {
          replyContextItems.push(replyBody);
        }
      } else if (item.type === "TEXT" || item.type === "MD") {
        textContent += item.content ?? "";
        rawTextContent += item.content ?? "";
        agentVisibleText += item.content ?? "";
      } else if (item.type === "LINK") {
        const label = item.label ?? "";
        if (label) {
          textContent += ` ${label} `;
          rawTextContent += ` ${label} `;
          agentVisibleText += ` ${label} `;
        }
      } else if (item.type === "AT") {
        // AT elements only go into rawTextContent and agentVisibleText, not textContent
        const name = item.name ?? "";
        if (name) {
          rawTextContent += `@${name} `;
          agentVisibleText +=
            item.robotid != null ? `@${name} (robotid:${item.robotid}) ` : `@${name} `;
        }
      } else if (item.type === "IMAGE") {
        // 提取图片下载地址
        const url = item.downloadurl;
        if (typeof url === "string" && url.trim()) {
          imageUrls.push(url.trim());
        }
      } else if (typeof item.content === "string" && item.content.trim()) {
        // Fallback: for any other item types with string content, treat content as text.
        textContent += item.content;
        rawTextContent += item.content;
        agentVisibleText += item.content;
      }
    }
  }

  let mes = textContent.trim() || String(msgData.content ?? msgData.text ?? "");
  const rawMes = rawTextContent.trim() || mes;

  const replyContext = replyContextItems.length > 0 ? replyContextItems : undefined;

  if (!mes && !replyContext && imageUrls.length === 0) {
    return;
  }
  // 纯图片消息：设置占位符
  if (!mes && imageUrls.length > 0) {
    mes = `<media:image>${imageUrls.length > 1 ? ` (${imageUrls.length} images)` : ""}`;
  }
  // If mes is empty but replyContext exists, use a placeholder so the message is not dropped
  if (!mes && replyContext) {
    mes = "(引用回复)";
  }
  // Body for LLM: include @mentions with robotid so model sees e.g. "@地图不打烊 (robotid:N)"
  const bodyForAgent = agentVisibleText.trim() || rawMes || mes;

  // Extract sender name from header or fallback to fromuser
  const senderName = String(header?.username ?? header?.nickname ?? msgData.username ?? fromuser);

  // Detect reply-to-bot: check if any replyData item quotes a bot-sent message
  const isReplyToBot = replyContext ? checkReplyToBot(bodyItems, accountId) : false;

  // Delegate to the common message handler (group chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes,
      rawMes,
      bodyForAgent,
      chatType: "group",
      groupId: groupid,
      senderName,
      wasMentioned,
      messageId: messageIdStr,
      timestamp,
      bodyItems,
      mentionIds:
        mentionIds.userIds.length > 0 || mentionIds.agentIds.length > 0 ? mentionIds : undefined,
      replyContext,
      isReplyToBot: isReplyToBot || undefined,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
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
  // Single source for "body shown to LLM": already computed in group handler (line ~666)
  const bodyForAgent = event.bodyForAgent ?? mes;

  const account = resolveInfoflowAccount({ cfg, accountId });
  const core = getInfoflowRuntime();

  const isGroup = chatType === "group";
  // Convert groupId (number) to string for peerId since routing expects string
  const peerId = isGroup ? (groupId !== undefined ? String(groupId) : fromuser) : fromuser;

  // Resolve per-group config for replyMode gating
  const groupCfg = isGroup ? resolveGroupConfig(account, groupId) : undefined;

  // "ignore" mode: discard immediately, no save, no think, no reply
  if (isGroup && groupCfg?.replyMode === "ignore") {
    return;
  }

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
  const toAddress = isGroup ? `infoflow:group:${groupId}` : `infoflow:${fromuser}`;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Infoflow",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent,
  });

  // Inject accumulated group chat history into the body for context
  const historyKey = isGroup && groupId !== undefined ? String(groupId) : undefined;
  let combinedBody = body;
  if (isGroup && historyKey) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: chatHistories,
      historyKey,
      limit: DEFAULT_GROUP_HISTORY_LIMIT,
      currentMessage: body,
      formatEntry: (entry) =>
        core.channel.reply.formatAgentEnvelope({
          channel: "Infoflow",
          from: entry.sender,
          timestamp: entry.timestamp ?? Date.now(),
          body: entry.body,
        }),
    });
  }

  const inboundHistory =
    isGroup && historyKey
      ? (chatHistories.get(historyKey) ?? []).map((e) => ({
          sender: e.sender,
          body: e.body,
          timestamp: e.timestamp,
        }))
      : undefined;

  // --- Resolve inbound media (images) ---
  const INFOFLOW_MAX_IMAGES = 20;
  const mediaMaxBytes = 30 * 1024 * 1024; // 30MB default, matching Feishu
  const mediaList: Array<{ path: string; contentType?: string }> = [];
  const failReasons: string[] = [];

  if (event.imageUrls && event.imageUrls.length > 0) {
    // Collect unique hostnames from image URLs for SSRF allowlist.
    // Infoflow image servers (e.g. xp2.im.baidu.com, e4hi.im.baidu.com) resolve to
    // internal IPs on Baidu's network, so they need to be explicitly allowed.
    const allowedHostnames: string[] = [];
    for (const imageUrl of event.imageUrls) {
      try {
        const hostname = new URL(imageUrl).hostname;
        if (hostname && !allowedHostnames.includes(hostname)) {
          allowedHostnames.push(hostname);
        }
      } catch {
        // invalid URL, will fail at fetch time
      }
    }
    const ssrfPolicy = allowedHostnames.length > 0 ? { allowedHostnames } : undefined;

    const urls = event.imageUrls.slice(0, INFOFLOW_MAX_IMAGES);
    const results = await Promise.allSettled(
      urls.map(async (imageUrl) => {
        const fetched = await core.channel.media.fetchRemoteMedia({
          url: imageUrl,
          maxBytes: mediaMaxBytes,
          ssrfPolicy,
        });
        const saved = await core.channel.media.saveMediaBuffer(
          fetched.buffer,
          fetched.contentType ?? undefined,
          "inbound",
          mediaMaxBytes,
        );
        logVerbose(`[infoflow] downloaded image from ${imageUrl}, saved to ${saved.path}`);
        return { path: saved.path, contentType: saved.contentType ?? fetched.contentType };
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        mediaList.push(result.value);
      } else {
        const reason = String(result.reason);
        logVerbose(`[infoflow] failed to download image: ${reason}`);
        failReasons.push(reason);
      }
    }
  }

  const mediaPayload = buildAgentMediaPayload(mediaList);

  // If user sent images but some/all downloads failed, adjust the body to inform the LLM.
  const requestedImageCount = event.imageUrls?.length ?? 0;
  const downloadedImageCount = mediaList.length;
  const failedImageCount = requestedImageCount - downloadedImageCount;
  if (requestedImageCount > 0 && failedImageCount > 0) {
    // Deduplicate error reasons and truncate for readability
    const uniqueReasons = [...new Set(failReasons)];
    const reasonSummary = uniqueReasons.map((r) => r.slice(0, 200)).join("; ");

    if (downloadedImageCount === 0) {
      // All failed
      const failNote =
        `[The user sent ${requestedImageCount > 1 ? `${requestedImageCount} images` : "an image"}, ` +
        `but failed to load: ${reasonSummary}]`;
      if (combinedBody.includes("<media:image>")) {
        combinedBody = combinedBody.replace(/<media:image>(\s*\(\d+ images\))?/, failNote);
      } else {
        combinedBody += `\n\n${failNote}`;
      }
    } else {
      // Partial failure: some images loaded, some didn't
      const failNote = `[${failedImageCount} of ${requestedImageCount} images failed to load: ${reasonSummary}]`;
      combinedBody += `\n\n${failNote}`;
    }
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: combinedBody,
    RawBody: event.rawMes ?? mes,
    CommandBody: mes,
    BodyForAgent: bodyForAgent,
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
    ReplyToBody: event.replyContext ? event.replyContext.join("\n---\n") : undefined,
    InboundHistory: inboundHistory,
    CommandAuthorized: true,
    ...mediaPayload,
  });

  // Ensure BodyForAgent stays set for group messages (with @ and robotid) so the LLM sees full context
  if (isGroup && bodyForAgent !== mes) {
    (ctxPayload as Record<string, unknown>).BodyForAgent = bodyForAgent;
    logVerbose(
      `[infoflow] group: BodyForAgent set for LLM (${bodyForAgent.length} chars, includes @/robotid)`,
    );
  }

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

  // Reply mode gating for group messages
  // Session is already recorded above for context history
  let triggerReason = "direct-message";
  if (isGroup && groupCfg) {
    const { replyMode } = groupCfg;
    const groupIdStr = groupId !== undefined ? String(groupId) : undefined;

    // "record" mode: save to session only, no think, no reply
    if (replyMode === "record") {
      if (groupIdStr) {
        logVerbose(
          `[infoflow:bot] pending: from=${fromuser}, group=${groupId}, reason=record-mode`,
        );
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: groupIdStr,
          entry: {
            sender: senderName || fromuser,
            body: bodyForAgent,
            timestamp: Date.now(),
          },
          limit: DEFAULT_GROUP_HISTORY_LIMIT,
        });
      }
      return;
    }

    const canDetectMention = Boolean(account.config.robotName);
    const wasMentioned = event.wasMentioned === true;

    if (replyMode === "mention-only") {
      // Only reply if bot was @mentioned
      const shouldReply = canDetectMention && wasMentioned;
      if (shouldReply) {
        triggerReason = "bot-mentioned";
      } else {
        // Check follow-up window: if bot recently replied, allow LLM to decide
        if (
          groupCfg.followUp &&
          groupIdStr &&
          isWithinFollowUpWindow(groupIdStr, groupCfg.followUpWindow)
        ) {
          if (hasOtherMentions(event.mentionIds)) {
            if (
              resolveFollowUpOtherMentioned({
                mentionIds: event.mentionIds,
                groupId,
                bodyForAgent,
                senderName: senderName || fromuser,
                fromuser,
              }) === "record_only"
            ) {
              return;
            }
          } else {
            triggerReason = "followUp";
            ctxPayload.GroupSystemPrompt = buildFollowUpPrompt(event.isReplyToBot === true);
          }
        } else {
          if (groupIdStr) {
            logVerbose(
              `[infoflow:bot] pending: from=${fromuser}, group=${groupId}, reason=mention-only-not-mentioned`,
            );
            recordPendingHistoryEntryIfEnabled({
              historyMap: chatHistories,
              historyKey: groupIdStr,
              entry: {
                sender: senderName || fromuser,
                body: bodyForAgent,
                timestamp: Date.now(),
              },
              limit: DEFAULT_GROUP_HISTORY_LIMIT,
            });
          }
          return;
        }
      }
    } else if (replyMode === "mention-and-watch") {
      // Reply if bot @mentioned, or if watched person @mentioned, or follow-up
      const botMentioned = canDetectMention && wasMentioned;
      if (botMentioned) {
        triggerReason = "bot-mentioned";
      } else {
        // Check watch-mention
        const watchMentions = groupCfg.watchMentions;
        const matchedWatchId =
          watchMentions.length > 0 && event.bodyItems
            ? checkWatchMentioned(event.bodyItems, watchMentions)
            : undefined;

        if (matchedWatchId) {
          triggerReason = `watchMentions(${matchedWatchId})`;
          // Watch-mention triggered: instruct agent to reply only if confident
          ctxPayload.GroupSystemPrompt = buildWatchMentionPrompt(matchedWatchId);
        } else if (groupCfg.watchRegex.length > 0 && checkWatchRegex(mes, groupCfg.watchRegex)) {
          const idx = findMatchingWatchRegex(mes, groupCfg.watchRegex);
          triggerReason =
            idx >= 0
              ? `watchRegex(${groupCfg.watchRegex[idx]})`
              : `watchRegex(${groupCfg.watchRegex.join("|")})`;
          // Watch-content triggered: message matched one of the configured regex patterns
          ctxPayload.GroupSystemPrompt = buildWatchRegexPrompt(groupCfg.watchRegex);
        } else if (
          groupCfg.followUp &&
          groupIdStr &&
          isWithinFollowUpWindow(groupIdStr, groupCfg.followUpWindow)
        ) {
          if (hasOtherMentions(event.mentionIds)) {
            if (
              resolveFollowUpOtherMentioned({
                mentionIds: event.mentionIds,
                groupId,
                bodyForAgent,
                senderName: senderName || fromuser,
                fromuser,
              }) === "record_only"
            ) {
              return;
            }
          } else {
            triggerReason = "followUp";
            ctxPayload.GroupSystemPrompt = buildFollowUpPrompt(event.isReplyToBot === true);
          }
        } else {
          if (groupIdStr) {
            logVerbose(
              `[infoflow:bot] pending: from=${fromuser}, group=${groupId}, reason=mention-and-watch-no-trigger`,
            );
            recordPendingHistoryEntryIfEnabled({
              historyMap: chatHistories,
              historyKey: groupIdStr,
              entry: {
                sender: senderName || fromuser,
                body: bodyForAgent,
                timestamp: Date.now(),
              },
              limit: DEFAULT_GROUP_HISTORY_LIMIT,
            });
          }
          return;
        }
      }
    } else if (replyMode === "proactive") {
      // Always think and potentially reply
      const botMentioned = canDetectMention && wasMentioned;
      if (botMentioned) {
        triggerReason = "bot-mentioned";
      } else {
        // Check watch-mention first (higher priority prompt)
        const watchMentions = groupCfg.watchMentions;
        const matchedWatchId =
          watchMentions.length > 0 && event.bodyItems
            ? checkWatchMentioned(event.bodyItems, watchMentions)
            : undefined;
        if (matchedWatchId) {
          triggerReason = `watchMentions(${matchedWatchId})`;
          ctxPayload.GroupSystemPrompt = buildWatchMentionPrompt(matchedWatchId);
        } else {
          triggerReason = "proactive";
          ctxPayload.GroupSystemPrompt = buildProactivePrompt();
        }
      }
    }

    // Inject per-group systemPrompt (append, don't replace)
    if (groupCfg.systemPrompt) {
      const existing = ctxPayload.GroupSystemPrompt ?? "";
      ctxPayload.GroupSystemPrompt = existing
        ? `${existing}\n\n---\n\n${groupCfg.systemPrompt}`
        : groupCfg.systemPrompt;
    }
  }

  // Build unified target: "group:<id>" for group chat, username for private chat
  const to = isGroup && groupId !== undefined ? `group:${groupId}` : fromuser;

  // When followUp-other-mentioned: if text before first AT (stripped) has length <= 4, replace
  // the current message with "对 xxx 说: rest" so the envelope stays and only the message line changes.
  if (isGroup && triggerReason === "followUp-other-mentioned") {
    const textBeforeFirstAt = getTextBeforeFirstAt(event.bodyItems);
    const stripped = stripPunctuationAndWhitespace(textBeforeFirstAt);
    if (stripped.length <= 4) {
      const leadingLabelFull = getLeadingOtherMentionLabelFull(event.bodyItems, event.mentionIds);
      if (leadingLabelFull) {
        const rest = getRestAfterLeadingOtherAts(event.bodyItems, event.mentionIds);
        const newBodyForAgent = `对 ${leadingLabelFull} 说: ${rest}`;
        const lastIdx = ctxPayload.Body.lastIndexOf(bodyForAgent);
        if (lastIdx !== -1) {
          ctxPayload.Body =
            ctxPayload.Body.slice(0, lastIdx) +
            newBodyForAgent +
            ctxPayload.Body.slice(lastIdx + bodyForAgent.length);
        }
      }
    }
  }

  // Provide mention context to the LLM so it can decide who to @mention
  if (isGroup && event.mentionIds) {
    const parts: string[] = [];
    if (event.mentionIds.userIds.length > 0) {
      parts.push(`User IDs: ${event.mentionIds.userIds.join(", ")}`);
    }
    if (event.mentionIds.agentIds.length > 0) {
      parts.push(`Bot IDs: ${event.mentionIds.agentIds.join(", ")}`);
    }
    if (parts.length > 0) {
      const notYouHint =
        triggerReason === "followUp-other-mentioned"
          ? " Others @mentioned in this message (not you):"
          : " @mentioned in group:";
      ctxPayload.Body += `\n\n[System:${notYouHint} ${parts.join("; ")}. To @mention someone in your reply, use the @id format]`;
      // In followUp-other-mentioned, tell the model who it is and who was @mentioned so it does not
      // confuse itself (e.g. "你" in "@地图不打烊 你讲个笑话" refers to 地图不打烊, not this bot).
      if (triggerReason === "followUp-other-mentioned") {
        const robotName = account.config.robotName?.trim();
        const robotId = account.config.robotId?.trim();
        const youAre =
          robotName && robotId
            ? `You are ${robotName} (ID ${robotId}). `
            : robotName
              ? `You are ${robotName}. `
              : "";
        const otherNames = getOtherMentionedDisplayNames(event.bodyItems, event.mentionIds);
        if (youAre || otherNames.length > 0) {
          const rest =
            otherNames.length > 0
              ? `The only @mentioned in this message: ${otherNames.join(", ")}. You are NOT that bot/person. Any "你/您" in the message refers to them. Default: NO_REPLY.`
              : "Default: NO_REPLY.";
          ctxPayload.Body += `\n[System: ${youAre}${rest}]`;
        }
      }
    }
  }

  const mentionIdsLog =
    isGroup && event.mentionIds
      ? `, mentionIds={userIds:[${event.mentionIds.userIds.join(",")}], agentIds:[${event.mentionIds.agentIds.join(",")}]}`
      : "";
  const bodyPreview =
    (ctxPayload as Record<string, unknown>).Body != null
      ? String((ctxPayload as Record<string, unknown>).Body)
      : "";
  const bodyLog = `bodyLen=${bodyPreview.length} bodyPreview=${bodyPreview.length > 5000 ? bodyPreview.slice(0, 5000) + "..." : bodyPreview}`;
  const sysPrompt =
    (ctxPayload as Record<string, unknown>).GroupSystemPrompt != null
      ? String((ctxPayload as Record<string, unknown>).GroupSystemPrompt)
      : "";
  const sysPromptLog = `groupSystemPromptLen=${sysPrompt.length} groupSystemPromptPreview=${sysPrompt.length > 5000 ? sysPrompt.slice(0, 5000) + "..." : sysPrompt}`;
  logVerbose(
    `[infoflow:bot] dispatching to LLM: from=${fromuser}, group=${groupId ?? "N/A"}, trigger=${triggerReason}, replyMode=${groupCfg?.replyMode ?? "N/A"}${mentionIdsLog} | ${bodyLog} | ${sysPromptLog}`,
  );

  const { dispatcherOptions, replyOptions } = createInfoflowReplyDispatcher({
    cfg,
    agentId: route.agentId,
    accountId: account.accountId,
    to,
    statusSink,
    // @mention the sender back when bot was directly @mentioned in a group
    atOptions: isGroup && event.wasMentioned ? { atUserIds: [fromuser] } : undefined,
    // Pass mention IDs for LLM-driven @mention resolution in outbound text
    mentionIds: isGroup ? event.mentionIds : undefined,
    // Pass inbound messageId for outbound reply-to (group only)
    replyToMessageId: isGroup ? event.messageId : undefined,
    replyToPreview: isGroup ? bodyForAgent : undefined,
    mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, route.agentId),
  });

  const dispatchResult = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions,
    replyOptions,
  });

  const didReply = dispatchResult?.queuedFinal ?? false;

  // Clear accumulated history after dispatch (it's now in the session transcript)
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({
      historyMap: chatHistories,
      historyKey,
      limit: DEFAULT_GROUP_HISTORY_LIMIT,
    });
  }

  // Record bot reply timestamp for follow-up window tracking
  if (didReply && isGroup && groupId !== undefined) {
    recordGroupReply(String(groupId));
  }

  logVerbose(
    `[infoflow] dispatch complete: ${chatType} from ${fromuser}, replied=${didReply}, finalCount=${dispatchResult?.counts.final ?? 0}, hasGroupSystemPrompt=${Boolean(ctxPayload.GroupSystemPrompt)}`,
  );
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal)
// ---------------------------------------------------------------------------

/** @internal — Check if bot was mentioned in message body. Only exported for tests. */
export const _checkBotMentioned = checkBotMentioned;
export const _getBotRobotidFromBody = getBotRobotidFromBody;

/** @internal — Check if any watch-list name was @mentioned. Only exported for tests. */
export const _checkWatchMentioned = checkWatchMentioned;

/** @internal — Extract non-bot mention IDs. Only exported for tests. */
export const _extractMentionIds = extractMentionIds;

/** @internal — Check if message matches any watchRegex pattern (dotAll). Only exported for tests. */
export const _checkWatchRegex = checkWatchRegex;

/** @internal — Check if message is a reply to one of the bot's own messages. Only exported for tests. */
export const _checkReplyToBot = checkReplyToBot;

/** @internal — Text before first AT (for "对 xxx 说：" prefix condition). Only exported for tests. */
export const _getTextBeforeFirstAt = getTextBeforeFirstAt;

/** @internal — Leading other AT display names for "对 xxx 说：". Only exported for tests. */
export const _getLeadingOtherMentionNames = getLeadingOtherMentionNames;
