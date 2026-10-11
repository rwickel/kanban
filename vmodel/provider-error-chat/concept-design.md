# Concept and Design

## Problem

Assistant messages can finish with a provider error and no content parts. The chat parser currently removes these messages.

## Design

Update the chat event parser to convert a top-level assistant error into a visible error row before content parsing.

## Modules

- `chatEvents`: Parse provider error data and return a safe, concise chat message.
- `ChatFeed`: Render the existing error message type without changes.

## Dependencies

`ChatFeed` depends on the normalized `ChatMessage` output from `chatEvents`.
