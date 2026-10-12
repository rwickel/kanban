# Concept and Design: Mobile Web View

Phase 1 of the V-Model. Gate: module decomposition named, responsibilities and dependencies listed, review coherent.

## Problem

The board works on a desktop screen. It does not work on a phone.

Facts from the current code:

- `src/App.tsx` puts logo, connection pill, project selector, theme, API, server, team, chat, and New Task in one flex row.
- `src/components/KanbanColumn.tsx` fixes each column to `min-w-[320px] w-[340px]`.
- `src/components/SessionChatWindow.tsx` and `AssistantChatWindow.tsx` sit in `fixed top-3 right-3 bottom-3` with a drag handle for width.
- Drag and drop uses `PointerSensor` with `activationConstraint: { distance: 8 }`.
- Task actions in `src/components/TaskCard.tsx` show only on `group-hover`.
- `TaskModal` and the other modals use `fixed inset-0` plus `max-w-lg`.
- Keyboard only actions exist: `N` for new task, `Cmd+K`, `C` for chat.

On a phone the header wraps or clips, one column fills the screen, the chat panel covers the board, hover buttons never appear, and a drag gesture fights the page scroll.

## Goals

1. Read the board, create a task, edit a task, move a task, and open a chat on a phone from 360 px width.
2. Use touch gestures. Give every control a target of at least 44 px.
3. Keep one codebase. Keep one data path. Keep the desktop view.
4. Reuse the existing store, hooks, chat feed, and modals.

## Non-goals for version 1

- No native app and no app store build.
- No offline write cache. The existing polling and server fallback stay as they are.
- No long press drag and drop. Status moves use an explicit control.
- No new API endpoints. No new database tables.
- The API explorer stays desktop only. It stays reachable but keeps its layout.

## Approach options

Option A, responsive one page.

Tailwind mobile first rules choose the layout at width 640 px. `App.tsx` renders a mobile shell under that width. The desktop shell stays as it is. The cost is that every desktop file changes: `App.tsx`, `KanbanColumn.tsx`, `TaskCard.tsx`, `index.css`, `index.html`. A desktop bug can break a phone change and the reverse.

Option B, a separate `/m` route with its own shell, recommended.

`main.tsx` keeps the desktop path exact and adds a route for `/m`. The mobile shell gets a clean file set under `src/mobile/`. No desktop file changes. The cost is a second board implementation. The two boards must be kept in step by hand.

Option C, device detection with a redirect.

The server sends phones to `/m`. Tablets, resizes, and desktop user agents get the wrong shell. Hard to test and hard to undo.

Decision: Option B.

### Why Option B wins here

1. No existing file changes. `src/App.tsx`, `KanbanColumn.tsx`, `TaskCard.tsx`, `SessionChatWindow.tsx`, and `AssistantChatWindow.tsx` stay exactly as they are.
2. `index.css` stays as it is. The mobile shell loads `src/mobile/mobile.css` on top of it and uses a `m-root` class scope, so no desktop rule changes.
3. No drag and drop conflict. The mobile shell mounts no `DndContext` and never touches `PointerSensor`.
4. No hover problem. The mobile shell has its own card markup with always visible buttons.
5. No chat width conflict. The mobile shell renders the chat feed directly, full screen, and ignores `kanban_chat_width`.
6. A desktop regression is impossible from mobile work, because no desktop file changes.

### Route switch

`main.tsx` keeps one branch before it renders:

```tsx
const isMobileRoute = window.location.pathname.startsWith("/m");
ReactDOM.createRoot(root).render(isMobileRoute ? <MobileApp /> : <App />);
```

Rules:

- `/` and every other path render the desktop board as today.
- `/m` renders the mobile shell. `/m` and `/m/*` both match.
- The mobile shell offers a link back to the desktop board for wide screens.
- No automatic redirect and no user agent check. The user picks the view. A test can open both views.

### What the mobile shell reuses

The shell imports from the existing modules. It does not change them:

- `src/store/kanban`: `getProjects`, `getTasks`, `createTask`, `updateTask`, `deleteTask`, `moveTask`, `getActiveProjectId`, `setActiveProjectId`, `pollDelayMs`, `migrateLocalStorageToServer`.
- `src/api/opencode`: `fetchAgents`, `createSession`, `sendPrompt`, `getServerInfo`.
- `src/hooks/useTheme`: theme state.
- `src/types`: `Task`, `TaskStatus`, `Project`, `Agent`.

### What the mobile shell writes instead of changing

- `src/mobile/mobile.css`: scope every rule under `.m-root`. Add the sheet keyframes, the 44 px target rule, the coarse pointer rule, the safe area padding, and `100dvh`.
- `src/mobile/MobileCard.tsx`: mobile card with always visible buttons. It does not wrap the desktop `TaskCard`.
- `src/mobile/TaskSheet.tsx`: mobile task detail and status control. It does not wrap `TaskModal` for layout. It may reuse `TaskModal` for the edit form.
- `src/mobile/MobileTaskForm.tsx`: full screen task create and edit form. A copy of the fields, not a change to `TaskModal`.
- `src/mobile/MobileChat.tsx`: full screen chat host. It renders the shared `ChatFeed` and sends through the shared session stream hook.

### Data path in the mobile shell

The mobile shell copies the desktop data flow into its own file, `src/mobile/useBoardData.ts`. It runs the same 5 second poll with the same backoff, the same optimistic move stamp, and the same auto start rule for tasks in `running`. Copy is accepted here because the desktop file must not change. The rule is that both files must follow the same poll delay and the same status rules.

## Concept per screen

### Header

Desktop keeps one row. Mobile uses two rows.

Row 1 holds the project name, the connection dot, and a menu button. The menu drawer holds theme, API view, server settings, agent team, assistant chat, project edit, project delete, and new project.

Row 2 holds the column tabs.

### Board

Desktop keeps four columns with drag and drop. Mobile shows one column at full width. The tab bar switches the column. Each tab shows the column name, its icon, and its task count.

### Move a task

Touch drag and drop is not reliable in a narrow scroll area. Status moves use the task detail sheet. The sheet shows a status control with four options. One tap moves the task and calls the same `moveTask` store function.

### Task card

Tap the card body to open the task detail sheet. The action buttons are always visible on touch screens. The delete, edit, copy id, and chat buttons stay at the top of the card. The card keeps its id, title, agent, priority, startup phase, and result text.

### Task detail sheet

The sheet fills the screen from the bottom. It shows title, description, priority, agent, model, result, and the status control. The buttons are edit, chat, delete, and close. The edit button opens the existing `TaskModal` as a full screen sheet.

### New task

A floating button sits at the lower right above the safe area. The button opens the existing `TaskModal` in full screen.

### Chat

Session chat and assistant chat fill the whole screen on a phone. The resize handle hides. A back button closes the chat and returns to the board.

### Modals

`TaskModal`, `ProjectModal`, `AgentTeamModal`, and `ServerConfigModal` anchor to the bottom of the screen and use the full width. The scroll area takes the remaining height. The action buttons stay visible at the bottom.

### Empty and offline states

The no project state shows a full width message and one primary button. The connection pill opens the same server settings as the desktop.

## Modules

New files only. No existing file changes except the route switch in `src/main.tsx`.

Route switch:

- `src/main.tsx`: One branch before render. Path starts with `/m` renders `MobileApp`, otherwise `App` exactly as today. No other line changes.

New mobile file set, all under `src/mobile/`:

- `src/mobile/mobile.css`: Scope every rule under `.m-root`. Sheet keyframes, 44 px target rule, coarse pointer rule, safe area padding, `100dvh`, full screen modals, full screen chat.
- `src/mobile/MobileApp.tsx`: Compose the mobile header, tabs, board, sheet, chat, and modals. Own the mobile view state. Load the store, the API, the poll, and the theme.
- `src/mobile/useBoardData.ts`: Load projects and tasks, run the poll with backoff, hold the optimistic move stamp, run the auto start rule for tasks in `running`.
- `src/mobile/MobileHeader.tsx`: Show the project name, the connection dot, and the menu drawer. Own the drawer open state.
- `src/mobile/ColumnTabs.tsx`: Show the four status tabs with counts. Receive the active status and an onChange callback.
- `src/mobile/MobileCard.tsx`: Render the task card with always visible buttons and a tap handler for the sheet.
- `src/mobile/TaskSheet.tsx`: Show the task fields, the status control, and the task actions. Call `moveTask`, edit, delete, and open chat.
- `src/mobile/MobileTaskForm.tsx`: Full screen create and edit form. Save through the store.
- `src/mobile/MobileChat.tsx`: Render the session chat or the assistant chat full screen. Own the back button. Send through the session stream.
- `src/mobile/MobileMenu.tsx`: Show theme, server settings, agent team, assistant chat, project switch, project edit, project delete, and new project.

### Dependencies

- `main.tsx` depends on `App` and `MobileApp`. It chooses one and renders it.
- `MobileApp` depends on `useBoardData`, `MobileHeader`, `ColumnTabs`, `MobileCard`, `TaskSheet`, `MobileTaskForm`, `MobileChat`, `MobileMenu`, `useTheme`, and `mobile.css`.
- `useBoardData` depends on `src/store/kanban` and `src/api/opencode`.
- `TaskSheet` depends on `MobileTaskForm` for the edit form.
- `MobileChat` depends on `src/components/ChatFeed.tsx` and the session stream hook.
- No mobile module changes an existing file. No mobile module imports `App.tsx`, `KanbanColumn.tsx`, `TaskCard.tsx`, `SessionChatWindow.tsx`, or `AssistantChatWindow.tsx`.

## Capability list

Phase 2 turns each item into a `REQ-MOBILE-nn` requirement.

1. The user opens `/m` and reads the board at 360 px width with no page scroll sideways.
2. The user switches columns with the tab bar.
3. The user creates a task with the floating button.
4. The user edits a task in a full screen form.
5. The user moves a task with the status control.
6. The user deletes a task.
7. The user opens the session chat full screen and returns with the back button.
8. The user opens the assistant chat full screen.
9. The user switches the project and creates a project.
10. The user opens the agent team and the server settings.
11. The user changes the theme.
12. Every visible control has a target of at least 44 px.
13. No control depends on hover.
14. The desktop board keeps its layout and its drag and drop. No desktop file changes except the route switch in `main.tsx`.
15. The `/` path renders the desktop board exactly as today.
16. The `/m` path renders the mobile shell.

## Risks

- R1: Two boards drift from the same data rules. Mitigation: `useBoardData.ts` copies the desktop poll delay, optimistic stamp, and status rules. A checklist runs on every board change.
- R2: `100vh` ignores the mobile browser bar. Mitigation: the mobile shell uses `100dvh` in `mobile.css` only.
- R3: Chat width is stored in `localStorage` as `kanban_chat_width`. Mitigation: the mobile chat ignores the stored width and hides the resize handle.
- R4: The mobile shell copies fields from `TaskModal` and `TaskCard`. Mitigation: keep the copy small and cover it with the capability checks above.
- R5: The branch carries uncommitted work from the desktop chat fix. Mitigation: no desktop file changes except `main.tsx`.
- R6: No mobile test tool exists in the repository. Open decision for Phase 2: add Playwright, or use manual device checks.

## Open decisions for Phase 2

- D1: Choose the mobile end to end test tool. Playwright gives real touch emulation.
- D2: Choose the phone widths to verify. The proposal is 360 px, 390 px, and 768 px.
- D3: Choose the target device floor. The proposal is a 2019 Android phone with Chrome.
- D4: Choose the safe area values for the header and the floating button.