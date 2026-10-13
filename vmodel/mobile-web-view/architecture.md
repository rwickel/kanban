# Architecture: Mobile Web View

Companion to `concept-design.md`. Phase 1 gate: named module decomposition with responsibilities and dependencies, reviewed coherent.

Rule: no existing file changes except the route switch in `src/main.tsx`.

## Route switch

`main.tsx` chooses the root before it renders:

```tsx
const isMobileRoute = window.location.pathname.startsWith("/m");
ReactDOM.createRoot(root).render(isMobileRoute ? <MobileApp /> : <App />);
```

- `/` and every other path render the desktop `App` exactly as today.
- `/m` and `/m/*` render `MobileApp` from `src/mobile/MobileApp.tsx`.
- Dev server note: `vite.config.js` has no `appType` or `historyApiFallback`. A direct `/m` load in dev may 404. Add no fallback rewrite to the config because that would change an existing file. Use a hash or query flag as an option in Phase 2, or accept that `npm run dev` serves `/m` only when the link runs from `/`.
- Build output note: the production build emits one bundle for both roots. Verify `/m` serves `index.html` on the host in Phase 5.

## Data path

The mobile shell does not import `App.tsx`. It copies the desktop data flow into `src/mobile/useBoardData.ts`:

- `getProjects`, `getTasks`, `getAgents`, `getServerInfo`
- 5 second poll with the same backoff
- same optimistic move stamp and reconcile rule
- same auto start rule for tasks in `running`
- same project switch, create, edit, and delete calls
- same task create, update, move, and delete calls

Copy is accepted because the desktop file must not change. Both paths call the same store and the same API. No mobile module calls the database or the server CLI.

## Module contracts

| Module | Owns | Receives | Calls |
|---|---|---|---|
| `MobileApp` | mobile view state | nothing | `useBoardData`, header, tabs, board, sheet, chat, modals, `mobile.css` |
| `useBoardData` | projects, tasks, poll, optimistic stamp | `useTheme` | `src/store/kanban`, `src/api/opencode` |
| `MobileHeader` | drawer open state | project, connection, callbacks | project selector, settings drawers |
| `ColumnTabs` | none, pure | columns, counts, active, onChange | nothing |
| `MobileCard` | none, pure | task, callbacks | edit, delete, chat, sheet open |
| `TaskSheet` | sheet form state | task, callbacks | `moveTask`, `MobileTaskForm`, chat open |
| `MobileTaskForm` | form fields | task or empty, onSave | store create and update |
| `MobileChat` | back navigation | session or assistant props | `ChatFeed`, session stream send |
| `MobileMenu` | drawer list | theme, project, callbacks | server settings, team, assistant |

No module imports `App.tsx`, `KanbanColumn.tsx`, `TaskCard.tsx`, `TaskModal.tsx`, `SessionChatWindow.tsx`, or `AssistantChatWindow.tsx`. Reuse covers store, API, theme hook, `ChatFeed`, session stream hook, and types.

## Touch rules

- No `DndContext` mounts in the mobile shell. Status moves go through `moveTask` via the sheet status control.
- `MobileCard` buttons are always visible. No hover rule.
- Minimum target 44 px for buttons, tabs, sheet controls, drawer items.
- `mobile.css` is scoped under `.m-root`. It uses `100dvh` and `env(safe-area-inset-*)`.
- `index.html` and `index.css` stay as they are. The viewport meta keeps `width=device-width, initial-scale=1.0`. Phase 2 may add `viewport-fit=cover` to `index.html` as a one line change, or set it only under `/m` in `MobileApp`.
- Full screen chat ignores the stored `kanban_chat_width`.

## Style tokens

`mobile.css` reads the desktop `--bg`, `--surface`, `--border`, `--text`, `--muted`, and `--accent` tokens so the theme stays in step. It adds only scoped rules:

- sheet slide up keyframes
- bottom sheet radius and drag area color
- floating button offset with safe area
- 44 px target rule
- drawer slide rule

## Test seams

- Route: unit test that paths `/m` and `/m/anything` render `MobileApp`, and `/` renders `App`.
- `ColumnTabs`: unit test that four tabs render with counts and onChange fires.
- `TaskSheet`: unit test that the status control calls `moveTask` with the tapped status.
- Integration: open `/m` at 360, 390, 768 px and cover capability list items 1 to 16 in `concept-design.md`.

## File inventory

New files, all under `src/mobile/`: `MobileApp.tsx`, `useBoardData.ts`, `MobileHeader.tsx`, `ColumnTabs.tsx`, `MobileCard.tsx`, `TaskSheet.tsx`, `MobileTaskForm.tsx`, `MobileChat.tsx`, `MobileMenu.tsx`, `mobile.css`, plus concept files already written.

Changed files: `src/main.tsx` only, for the route switch.

Untouched: `App.tsx`, `KanbanColumn.tsx`, `TaskCard.tsx`, `TaskModal.tsx`, `SessionChatWindow.tsx`, `AssistantChatWindow.tsx`, store, API, server, database, chat feed, polling path on desktop, `index.css`, `index.html`, `vite.config.js`.
