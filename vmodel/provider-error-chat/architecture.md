# Architecture

The change stays inside the existing message normalization boundary. Raw provider data does not enter React components.

The parser prefers an embedded provider status because proxy responses can use a different outer HTTP status. It falls back to the numeric error status.

The parser extracts a nested JSON error message when available. It falls back to the original provider message.
