# Software Unit Requirements

## SW-UR-CHAT-EVENTS-01

- Purpose: Preserve assistant provider failures as visible chat messages.
- Interface: `toChatMessage(raw: unknown): ChatMessage[]`.
- Data contract: A valid message ID and top-level error produce one `kind: error` message.
- Requirement: REQ-PROVIDER-ERROR-01.
- Test: `chatEvents.test.ts` provider error test.

## SW-UR-CHAT-EVENTS-02

- Purpose: Format useful provider error details.
- Interface: Internal provider error formatter.
- Data contract: Prefer an embedded bracketed status and nested JSON message. Use the numeric status and raw message as fallbacks.
- Requirement: REQ-PROVIDER-ERROR-02.
- Test: Both tests in `chatEvents.test.ts`.
