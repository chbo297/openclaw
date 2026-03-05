import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: {
      shouldLogVerbose: () => false,
      logVerbose: () => {},
      getChildLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
  })),
}));

vi.mock("./accounts.js", () => ({
  resolveInfoflowAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      apiHost: "https://api.infoflow.test",
      appKey: "key",
      appSecret: "secret",
      checkToken: "tok",
      encodingAESKey: "aes",
    },
  })),
}));

const mockSendInfoflowMessage = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({
  sendInfoflowMessage: mockSendInfoflowMessage,
}));

const mockPrepareInfoflowImageBase64 = vi.hoisted(() => vi.fn());
const mockSendInfoflowImageMessage = vi.hoisted(() => vi.fn());
vi.mock("./media.js", () => ({
  prepareInfoflowImageBase64: mockPrepareInfoflowImageBase64,
  sendInfoflowImageMessage: mockSendInfoflowImageMessage,
}));

import { infoflowMessageActions } from "./actions.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("infoflowMessageActions", () => {
  beforeEach(() => {
    mockSendInfoflowMessage.mockReset();
    mockSendInfoflowMessage.mockResolvedValue({ ok: true, messageId: "msg-1" });
    mockPrepareInfoflowImageBase64.mockReset();
    mockPrepareInfoflowImageBase64.mockResolvedValue({ isImage: false }); // default: non-image
    mockSendInfoflowImageMessage.mockReset();
    mockSendInfoflowImageMessage.mockResolvedValue({ ok: true, messageId: "img-1" });
  });

  it("listActions returns send", () => {
    const actions = infoflowMessageActions.listActions!({ cfg: {} as never });
    expect(actions).toEqual(["send"]);
  });

  it("throws for unsupported actions", async () => {
    await expect(
      infoflowMessageActions.handleAction!({
        channel: "infoflow",
        action: "delete" as never,
        cfg: {} as never,
        params: { to: "group:123", message: "hi" },
      }),
    ).rejects.toThrow('Action "delete" is not supported for Infoflow.');
  });

  // -------------------------------------------------------------------------
  // Basic send (no mentions)
  // -------------------------------------------------------------------------

  it("sends plain text to a group without mentions", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "Hello group" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(1);
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "Hello group" }],
      accountId: undefined,
    });
  });

  it("sends plain text to a private user", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "user1", message: "Hello user" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "user1",
      contents: [{ type: "markdown", content: "Hello user" }],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // @all mention
  // -------------------------------------------------------------------------

  it("sends @all mention in group message (boolean)", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:456", message: "Important notice", atAll: true },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:456",
      contents: [
        { type: "at", content: "all" },
        { type: "markdown", content: "@all Important notice" },
      ],
      accountId: undefined,
    });
  });

  it("sends @all mention in group message (string 'true')", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:456", message: "Notice", atAll: "true" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:456",
      contents: [
        { type: "at", content: "all" },
        { type: "markdown", content: "@all Notice" },
      ],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // @specific users mention
  // -------------------------------------------------------------------------

  it("sends @specific users mention in group message", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:789", message: "Check this", mentionUserIds: "alice,bob" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:789",
      contents: [
        { type: "at", content: "alice,bob" },
        { type: "markdown", content: "@alice @bob Check this" },
      ],
      accountId: undefined,
    });
  });

  it("trims and filters empty mentionUserIds entries", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:789", message: "Hello", mentionUserIds: " alice , , bob " },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:789",
      contents: [
        { type: "at", content: "alice,bob" },
        { type: "markdown", content: "@alice @bob Hello" },
      ],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Private messages ignore mention params
  // -------------------------------------------------------------------------

  it("ignores atAll for private messages", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "user1", message: "Hello", atAll: true },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "user1",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: undefined,
    });
  });

  it("ignores mentionUserIds for private messages", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "user1", message: "Hello", mentionUserIds: "alice" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "user1",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Media URL support
  // -------------------------------------------------------------------------

  it("sends media URL as native image when image detected", async () => {
    mockPrepareInfoflowImageBase64.mockResolvedValue({ isImage: true, base64: "AQIDBA==" });

    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "See this", media: "https://example.com/image.png" },
    });

    // Text sent first
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "See this" }],
      accountId: undefined,
    });
    // Then native image
    expect(mockSendInfoflowImageMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      base64Image: "AQIDBA==",
      accountId: undefined,
    });
  });

  it("falls back to link for non-image media", async () => {
    // Default mock returns { isImage: false }
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "See this", media: "https://example.com/image.png" },
    });

    // Text sent first, then link fallback
    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(2);
    expect(mockSendInfoflowMessage).toHaveBeenNthCalledWith(1, {
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "See this" }],
      accountId: undefined,
    });
    expect(mockSendInfoflowMessage).toHaveBeenNthCalledWith(2, {
      cfg: {},
      to: "group:123",
      contents: [{ type: "link", content: "https://example.com/image.png" }],
      accountId: undefined,
    });
  });

  it("sends media-only message without text", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "", media: "https://example.com/file.pdf" },
    });

    // No text message sent (empty contents)
    // Non-image media falls back to link
    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(1);
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "link", content: "https://example.com/file.pdf" }],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("ignores empty mentionUserIds string", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "Hello", mentionUserIds: "" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: undefined,
    });
  });

  it("throws when no text or media is provided", async () => {
    await expect(
      infoflowMessageActions.handleAction!({
        channel: "infoflow",
        action: "send",
        cfg: {} as never,
        params: { to: "group:123", message: "" },
      }),
    ).rejects.toThrow("send requires text or media");
  });

  it("returns error from sendInfoflowMessage", async () => {
    mockSendInfoflowMessage.mockResolvedValue({ ok: false, error: "network timeout" });

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "Hello" },
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              channel: "infoflow",
              to: "group:123",
              messageId: "failed",
              error: "network timeout",
            },
            null,
            2,
          ),
        },
      ],
      details: {
        ok: false,
        channel: "infoflow",
        to: "group:123",
        messageId: "failed",
        error: "network timeout",
      },
    });
  });

  it("passes accountId through to sendInfoflowMessage", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "Hello" },
      accountId: "my-account",
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: "my-account",
    });
  });

  it("combines @all with media", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: {
        to: "group:123",
        message: "Check the doc",
        atAll: true,
        media: "https://example.com/doc.pdf",
      },
    });

    // Text+mentions sent first, then non-image media falls back to link
    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(2);
    expect(mockSendInfoflowMessage).toHaveBeenNthCalledWith(1, {
      cfg: {},
      to: "group:123",
      contents: [
        { type: "at", content: "all" },
        { type: "markdown", content: "@all Check the doc" },
      ],
      accountId: undefined,
    });
    expect(mockSendInfoflowMessage).toHaveBeenNthCalledWith(2, {
      cfg: {},
      to: "group:123",
      contents: [{ type: "link", content: "https://example.com/doc.pdf" }],
      accountId: undefined,
    });
  });

  it("normalizes infoflow: prefix from target", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "infoflow:group:123", message: "Hello" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: undefined,
    });
  });
});
