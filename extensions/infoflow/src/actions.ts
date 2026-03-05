/**
 * Infoflow channel message actions adapter.
 * Intercepts the "send" action from the message tool to support
 * @all and @user mentions in group messages.
 */

import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk";
import { extractToolSend, jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./accounts.js";
import { logVerbose } from "./logging.js";
import { prepareInfoflowImageBase64, sendInfoflowImageMessage } from "./media.js";
import { sendInfoflowMessage, recallInfoflowGroupMessage } from "./send.js";
import {
  findSentMessage,
  querySentMessages,
  removeRecalledMessages,
} from "./sent-message-store.js";
import { normalizeInfoflowTarget } from "./targets.js";
import type { InfoflowMessageContentItem } from "./types.js";

export const infoflowMessageActions: ChannelMessageActionAdapter = {
  listActions: (): ChannelMessageActionName[] => ["send", "delete"],

  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),

  handleAction: async ({ action, params, cfg, accountId }) => {
    // -----------------------------------------------------------------------
    // delete (群消息撤回) — Mode A: by messageId, Mode B: by count
    // -----------------------------------------------------------------------
    if (action === "delete") {
      const rawTo = readStringParam(params, "to", { required: true });
      if (!rawTo) {
        throw new Error("delete requires a target (to).");
      }
      const to = normalizeInfoflowTarget(rawTo) ?? rawTo;
      const target = to.replace(/^infoflow:/i, "");

      // Only group messages can be recalled
      const groupMatch = target.match(/^group:(\d+)/i);
      if (!groupMatch) {
        throw new Error(
          "Infoflow recall is only supported for group messages (target must be group:<id>).",
        );
      }
      const groupId = Number(groupMatch[1]);

      const account = resolveInfoflowAccount({ cfg, accountId: accountId ?? undefined });
      if (!account.config.appKey || !account.config.appSecret) {
        throw new Error("Infoflow appKey/appSecret not configured.");
      }

      const messageId = readStringParam(params, "messageId");
      // Default to count=1 (recall latest message) when neither messageId nor count is provided
      const countStr = readStringParam(params, "count") ?? (messageId ? undefined : "1");

      // Mode A: single message recall by messageId
      if (messageId) {
        // Try to find msgseqid from store; fall back to params
        let msgseqid = readStringParam(params, "msgseqid") ?? "";
        if (!msgseqid) {
          const stored = findSentMessage(account.accountId, messageId);
          if (stored?.msgseqid) {
            msgseqid = stored.msgseqid;
          }
        }
        if (!msgseqid) {
          throw new Error(
            "delete requires msgseqid (not found in store; provide it explicitly or send messages first).",
          );
        }

        const result = await recallInfoflowGroupMessage({
          account,
          groupId,
          messageid: Number(messageId),
          msgseqid: Number(msgseqid),
        });

        if (result.ok) {
          try {
            removeRecalledMessages(account.accountId, [messageId]);
          } catch {
            // ignore cleanup errors
          }
        }

        return jsonResult({
          ok: result.ok,
          channel: "infoflow",
          to,
          ...(result.error ? { error: result.error } : {}),
        });
      }

      // Mode B: batch recall by count
      if (countStr) {
        const count = Number(countStr);
        if (!Number.isFinite(count) || count < 1) {
          throw new Error("count must be a positive integer.");
        }

        const records = querySentMessages(account.accountId, { target: `group:${groupId}`, count });
        // Filter to records that have msgseqid (required for recall)
        const recallable = records.filter((r) => r.msgseqid);

        if (recallable.length === 0) {
          return jsonResult({
            ok: true,
            channel: "infoflow",
            to,
            recalled: 0,
            message: "No recallable messages found in store.",
          });
        }

        let succeeded = 0;
        let failed = 0;
        const recalledIds: string[] = [];
        const details: Array<{ messageid: string; digest: string; ok: boolean; error?: string }> =
          [];

        for (const record of recallable) {
          const result = await recallInfoflowGroupMessage({
            account,
            groupId,
            messageid: Number(record.messageid),
            msgseqid: Number(record.msgseqid),
          });

          if (result.ok) {
            succeeded++;
            recalledIds.push(record.messageid);
            details.push({ messageid: record.messageid, digest: record.digest, ok: true });
          } else {
            failed++;
            details.push({
              messageid: record.messageid,
              digest: record.digest,
              ok: false,
              error: result.error,
            });
          }
        }

        // Remove successfully recalled messages from store
        if (recalledIds.length > 0) {
          try {
            removeRecalledMessages(account.accountId, recalledIds);
          } catch {
            // ignore cleanup errors
          }
        }

        return jsonResult({
          ok: failed === 0,
          channel: "infoflow",
          to,
          recalled: succeeded,
          failed,
          total: recallable.length,
          details,
        });
      }
    }

    // -----------------------------------------------------------------------
    // send
    // -----------------------------------------------------------------------
    if (action !== "send") {
      throw new Error(`Action "${action}" is not supported for Infoflow.`);
    }

    const account = resolveInfoflowAccount({ cfg, accountId: accountId ?? undefined });
    if (!account.config.appKey || !account.config.appSecret) {
      throw new Error("Infoflow appKey/appSecret not configured.");
    }

    const rawTo = readStringParam(params, "to", { required: true });
    if (!rawTo) {
      throw new Error("send requires a target (to).");
    }
    const to = normalizeInfoflowTarget(rawTo) ?? rawTo;
    const message = readStringParam(params, "message", { required: false, allowEmpty: true }) ?? "";
    const mediaUrl = readStringParam(params, "media", { trim: false });

    // Infoflow-specific mention params
    const atAll = params.atAll === true || params.atAll === "true";
    const mentionUserIdsRaw = readStringParam(params, "mentionUserIds");

    const isGroup = /^group:\d+$/i.test(to);
    const contents: InfoflowMessageContentItem[] = [];

    // Build AT content nodes (group messages only)
    if (isGroup) {
      if (atAll) {
        contents.push({ type: "at", content: "all" });
      } else if (mentionUserIdsRaw) {
        const userIds = mentionUserIdsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (userIds.length > 0) {
          contents.push({ type: "at", content: userIds.join(",") });
        }
      }
    }

    // Prepend @all/@user prefix to display text (same pattern as reply-dispatcher.ts)
    let messageText = message;
    if (isGroup) {
      if (atAll) {
        messageText = `@all ${message}`;
      } else if (mentionUserIdsRaw) {
        const userIds = mentionUserIdsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (userIds.length > 0) {
          const prefix = userIds.map((id) => `@${id}`).join(" ");
          messageText = `${prefix} ${message}`;
        }
      }
    }

    if (messageText.trim()) {
      contents.push({ type: "markdown", content: messageText });
    }

    if (mediaUrl) {
      logVerbose(
        `[infoflow:action:send] to=${to}, atAll=${atAll}, mentionUserIds=${mentionUserIdsRaw ?? "none"}`,
      );

      // Send text+mentions first (if any)
      if (contents.length > 0) {
        await sendInfoflowMessage({ cfg, to, contents, accountId: accountId ?? undefined });
      }

      // Try native image send, fallback to link
      try {
        const prepared = await prepareInfoflowImageBase64({ mediaUrl });
        if (prepared.isImage) {
          const imgResult = await sendInfoflowImageMessage({
            cfg,
            to,
            base64Image: prepared.base64,
            accountId: accountId ?? undefined,
          });
          return jsonResult({
            ok: imgResult.ok,
            channel: "infoflow",
            to,
            messageId: imgResult.messageId ?? (imgResult.ok ? "sent" : "failed"),
            ...(imgResult.error ? { error: imgResult.error } : {}),
          });
        }
      } catch {
        // fallback to link below
      }

      // Non-image or native send failed → send as link
      const linkResult = await sendInfoflowMessage({
        cfg,
        to,
        contents: [{ type: "link", content: mediaUrl }],
        accountId: accountId ?? undefined,
      });
      return jsonResult({
        ok: linkResult.ok,
        channel: "infoflow",
        to,
        messageId: linkResult.messageId ?? (linkResult.ok ? "sent" : "failed"),
        ...(linkResult.error ? { error: linkResult.error } : {}),
      });
    }

    if (contents.length === 0) {
      throw new Error("send requires text or media");
    }

    logVerbose(
      `[infoflow:action:send] to=${to}, atAll=${atAll}, mentionUserIds=${mentionUserIdsRaw ?? "none"}`,
    );

    const result = await sendInfoflowMessage({
      cfg,
      to,
      contents,
      accountId: accountId ?? undefined,
    });

    return jsonResult({
      ok: result.ok,
      channel: "infoflow",
      to,
      messageId: result.messageId ?? (result.ok ? "sent" : "failed"),
      ...(result.error ? { error: result.error } : {}),
    });
  },
};
