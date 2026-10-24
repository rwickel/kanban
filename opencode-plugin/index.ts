// kanban plugin — kanban board tools exposed as native OpenCode tools.
//
// Why a plugin instead of an external MCP server: an MCP tool call does not carry the
// caller session. This plugin gets Tool.Context.sessionID, so kanban_delegate and
// kanban_create_task can attach the calling session as parentSessionId on their own.
//
// Register: the plugin must be listed in the OpenCode config, otherwise no
// session gets the kanban tools:
//   ~/.config/opencode/opencode.jsonc
//   { "plugins": ["file:///C:/Users/Robert/work/kanban/opencode-plugin"] }
// A global entry loads the plugin in every folder (main checkout and every
// task worktree), so delegated teammates can delegate further.
//
// Only the board state goes through server/kanban.py. Agent sessions go
// through the running server's own ctx.session client, so no extra
// `opencode serve` and no port or password is needed for delegation.

import { callerSessionId, callingSessionId, cliResult, interruptTaskSession, jsonResult, kanbanFetch, ocBase, ocH, runCli, toolError } from "./core.js"
import { delegateTool, messageToTool } from "./delegate.js"

// Optional arguments are expressed by leaving the key out of `required`,
// so one string helper covers both required and optional fields.
const str = (description: string) => ({ type: "string", description })

const statusEnum = (description: string) => ({
  type: "string",
  enum: ["backlog", "running", "done", "blocked"],
  description,
})

const priorityEnum = (description: string) => ({
  type: "string",
  enum: ["low", "medium", "high", "critical"],
  description,
})

const blockedByProp = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
})

export default {
  id: "kanban",
  async setup(ctx: any) {
    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "kanban",
        description: "Shared kanban board: boards, tasks, and agent delegation",
      })

      editor.add({
        name: "kanban_list_models",
        description: "kanban_list_models: kanban_list_models: List models available from the connected OpenCode providers for delegation.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "kanban" },
        execute: async () => {
          try {
            // OpenCode client versions expose this endpoint differently. Keep
            // the native client path, then use the stable HTTP endpoint when
            // the installed client has no provider namespace.
            let response
            if (typeof ctx.client?.provider?.list === "function") {
              response = await ctx.client.provider.list()
            } else if (typeof ctx.client?.model?.list === "function") {
              response = await ctx.client.model.list()
            } else {
              const httpResponse = await fetch(`${ocBase()}/model`, {
                headers: Object.fromEntries(Object.entries(ocH()).filter(([, value]) => value !== undefined)),
              })
              if (!httpResponse.ok) throw new Error(`model endpoint returned HTTP ${httpResponse.status}`)
              response = await httpResponse.json()
            }
            const data = response?.data ?? response
            return jsonResult(Array.isArray(data) ? data : [])
          } catch (error) {
            return toolError(`failed to list connected models: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      })

      editor.add({
        name: "kanban_update_project_models",
        description:
          "kanban_update_project_models: Replace a project's allowed model list after checking it against the current OpenCode model list. Pass an empty array to remove the restriction.",
        input: {
          type: "object",
          properties: {
            projectId: str("Project uuid"),
            allowedModels: {
              type: "array",
              items: { type: "string" },
              description: "Current provider/model pairs to allow; [] means unrestricted",
            },
          },
          required: ["projectId", "allowedModels"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          if (!Array.isArray(input.allowedModels)) return toolError("allowedModels must be an array")
          const requested = input.allowedModels.map((value: unknown) => String(value).trim()).filter(Boolean)
          if (requested.some((value: string) => !value.includes("/") || value.startsWith("/") || value.endsWith("/"))) {
            return toolError("allowedModels must contain provider/model pairs")
          }

          try {
            const response = await fetch(`${ocBase()}/model`, {
              headers: Object.fromEntries(Object.entries(ocH()).filter(([, value]) => value !== undefined)),
            })
            if (!response.ok) throw new Error(`model endpoint returned HTTP ${response.status}`)
            const payload = await response.json()
            const models = Array.isArray(payload) ? payload : (payload?.data ?? [])
            const available = new Set(models.map((model: any) => `${model.providerID}/${model.modelID}`))
            const invalid = requested.filter((value: string) => !available.has(value))
            if (invalid.length > 0) return toolError(`invalid or unavailable models: ${invalid.join(", ")}`)

            const argv = ["project", "update", input.projectId, "--actor", "agent"]
            if (requested.length === 0) argv.push("--clear-allowed-models")
            else for (const model of requested) argv.push("--allowed-model", model)
            return cliResult(await runCli(argv))
          } catch (error) {
            return toolError(`failed to validate or update project models: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      })

      // --- boards ---------------------------------------------------------

      editor.add({
        name: "kanban_create_board",
        description:
          "kanban_create_board: Create a new kanban board (project). Returns the created board JSON including its uuid. Pass folder (name inside KANBAN_PROJECTS_ROOT) or path (must be inside KANBAN_PROJECTS_ROOT).",
        input: {
          type: "object",
          properties: {
            name: str("Board name"),
            folder: str("Folder name inside KANBAN_PROJECTS_ROOT"),
            path: str("Full project path (must be inside KANBAN_PROJECTS_ROOT)"),
            description: str("Board description"),
            gitUrl: str("Git remote URL"),
            gitBranch: str("Pinned git branch (default main)"),
            agentIds: {
              type: "array",
              items: { type: "string" },
              description: "Teammate agent ids for this board",
            },
            id: str("Explicit board uuid (default random)"),
          },
          required: ["name"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          if (!input.name?.trim()) toolError("name required")
          const argv = ["project", "create", "--name", input.name, "--actor", "agent"]
          if (input.folder) argv.push("--folder", input.folder)
          if (input.path) argv.push("--path", input.path)
          if (input.description) argv.push("--description", input.description)
          if (input.gitUrl) argv.push("--git-url", input.gitUrl)
          if (input.gitBranch) argv.push("--git-branch", input.gitBranch)
          if (input.id) argv.push("--id", input.id)
          for (const a of input.agentIds ?? []) if (a) argv.push("--agent-id", a)
          return cliResult(await runCli(argv))
        },
      })

      editor.add({
        name: "kanban_list_boards",
        description: "kanban_list_boards: kanban_list_boards: List all kanban boards (projects) from the shared store.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "kanban" },
        execute: async () => cliResult(await runCli(["project", "list", "--json"])),
      })

      editor.add({
        name: "kanban_get_board",
        description: "kanban_get_board: kanban_get_board: Show one kanban board by id with its task counts.",
        input: {
          type: "object",
          properties: { projectId: str("Board uuid (project id)") },
          required: ["projectId"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          if (!input.projectId?.trim()) toolError("projectId required")
          const r = await runCli(["project", "list", "--json"])
          if (!r.ok) return cliResult(r)
          const row = JSON.parse(r.text).find?.((p: any) => p.id === input.projectId)
          if (!row) toolError(`board not found: ${input.projectId}`)
          return jsonResult(row)
        },
      })

      editor.add({
        name: "kanban_update_board",
        description:
          "kanban_update_board: Patch a kanban board's name, folder/path, description, git settings, or agent team. Returns updated board JSON.",
        input: {
          type: "object",
          properties: {
            projectId: str("Board uuid (project id)"),
            name: str("New board name"),
            folder: str("New folder name inside KANBAN_PROJECTS_ROOT"),
            path: str("New full path (must be inside KANBAN_PROJECTS_ROOT)"),
            description: str("New description"),
            gitUrl: str("New git remote URL"),
            gitBranch: str("New pinned git branch"),
            agentIds: {
              type: "array",
              items: { type: "string" },
              description: "Replace agent team list",
            },
          },
          required: ["projectId"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          if (!input.projectId?.trim()) toolError("projectId required")
          const argv = ["project", "update", input.projectId, "--actor", "agent"]
          if (input.name !== undefined) argv.push("--name", input.name)
          if (input.folder !== undefined) argv.push("--folder", input.folder)
          if (input.path !== undefined) argv.push("--path", input.path)
          if (input.description !== undefined) argv.push("--description", input.description)
          if (input.gitUrl !== undefined) argv.push("--git-url", input.gitUrl)
          if (input.gitBranch !== undefined) argv.push("--git-branch", input.gitBranch)
          if (input.agentIds !== undefined) {
            for (const a of input.agentIds) if (a) argv.push("--agent-id", a)
          }
          if (argv.length <= 4) toolError("nothing to update")
          return cliResult(await runCli(argv))
        },
      })

      editor.add({
        name: "kanban_delete_board",
        description: "kanban_delete_board: kanban_delete_board: Delete a kanban board and all its tasks. This cannot be undone.",
        input: {
          type: "object",
          properties: { projectId: str("Board uuid (project id) to delete") },
          required: ["projectId"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          if (!input.projectId?.trim()) toolError("projectId required")
          return cliResult(await runCli(["project", "delete", input.projectId, "--actor", "agent"]))
        },
      })

      // --- tasks ----------------------------------------------------------

      editor.add({
        name: "kanban_create_task",
        description:
          "kanban_create_task: Create a new task in a project's backlog. Returns the created task JSON including its uuid. The calling session is attached as parentSessionId automatically, and the server links the new task to the task that owns that session (parentTaskId). Never pass a parent session yourself: the parent is always the session you run in. Pass blockedByTaskIds to make the task wait for other tasks of the same project.",
        input: {
          type: "object",
          properties: {
            projectId: str("Project uuid the task belongs to"),
            title: str("Task title"),
            description: str("Task description"),
            acceptanceCriteria: str(
              "Acceptance criteria, one per line. The board shows them on the card and sends them to the teammate.",
            ),
            priority: priorityEnum("Priority (default medium)"),
            blockedByTaskIds: blockedByProp(
              "Depends-on: predecessor task ids (same project) that must be done before this task may start. Unknown ids, self-references, foreign-project ids and cycles are rejected with an error.",
            ),
          },
          required: ["projectId", "title"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any, context: any) => {
          const argv = [
            "task", "create",
            "--project", input.projectId,
            "--title", input.title,
            "--actor", "agent",
          ]
          if (input.description) argv.push("--description", input.description)
          if (input.acceptanceCriteria) argv.push("--acceptance-criteria", input.acceptanceCriteria)
          if (input.priority) argv.push("--priority", input.priority)
          if (Array.isArray(input.blockedByTaskIds) && input.blockedByTaskIds.length > 0) {
            argv.push("--blocked-by", input.blockedByTaskIds.map((v: unknown) => String(v).trim()).filter(Boolean).join(","))
          }
          // The parent of the new task is always the calling session. Never
          // take an explicit value: the board builds the task tree from it.
          const parent = callerSessionId(context)
          if (parent) argv.push("--parent-session-id", parent)
          return cliResult(await runCli(argv))
        },
      })

      editor.add({
        name: "kanban_list_tasks",
        description:
          "kanban_list_tasks: List tasks from the shared store, optionally filtered by project and/or status.",
        input: {
          type: "object",
          properties: {
            projectId: str("Project uuid filter"),
            status: statusEnum("Task status filter"),
          },
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          const argv = ["task", "list"]
          if (input.projectId) argv.push("--project", input.projectId)
          if (input.status) argv.push("--status", input.status)
          return cliResult(await runCli(argv))
        },
      })

      editor.add({
        name: "kanban_task_status",
        description: "kanban_task_status: kanban_task_status: Show one task by id. Without a task id, list recent board events.",
        input: {
          type: "object",
          properties: { taskId: str("Task uuid. If omitted, lists recent events instead.") },
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          if (input.taskId) return cliResult(await runCli(["task", "show", input.taskId]))
          return cliResult(await runCli(["events", "list", "--limit", "20"]))
        },
      })

      editor.add({
        name: "kanban_start_task",
        description: "kanban_start_task: kanban_start_task: Start or retry an existing blocked/backlog/done task in place. Requires an agent on the project team and an available, allowed model/provider pair. Never creates a duplicate task.",
        input: {
          type: "object",
          properties: {
            taskId: str("Existing Kanban task id"),
            agentId: str("Teammate id already configured on the project"),
            agentName: str("Teammate display name"),
            modelId: str("Available and project-allowed model id"),
            modelProviderID: str("Provider id for the selected model"),
          },
          required: ["taskId"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          const row = await runCli(["task", "show", input.taskId])
          if (!row.ok) return cliResult(row)
          const r = await kanbanFetch(`/api/kanban/tasks/${encodeURIComponent(input.taskId)}/start`, {
            method: "POST", headers: ocH(), body: JSON.stringify(input),
          })
          const payload = await r.json().catch(() => ({}))
          if (!r.ok) return jsonResult({ ok: false, status: r.status, ...payload })
          return jsonResult(payload)
        },
      })

      editor.add({
        name: "kanban_update_status",
        description:
          "kanban_update_status: Move a kanban task to a new status. Call with status 'done' when complete, 'blocked' if stuck. Prefer task_result for the answer; result/resultContext here are stored alongside the move. Do NOT rewrite the description.",
        input: {
          type: "object",
          properties: {
            taskId: str("Kanban task id (uuid, from the Task id in your prompt)"),
            status: statusEnum("New status"),
            result: str("Task result — last assistant message + context"),
            resultContext: str("Extra context for the result"),
          },
          required: ["taskId", "status"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          const moved = await runCli(["task", "move", input.taskId, input.status, "--actor", "agent"])
          if (!moved.ok) return cliResult(moved)
          if (input.result !== undefined || input.resultContext !== undefined) {
            const argv = ["task", "update", input.taskId, "--actor", "agent"]
            if (input.result !== undefined) argv.push("--result", input.result)
            if (input.resultContext !== undefined) argv.push("--result-context", input.resultContext)
            const u = await runCli(argv)
            if (u.ok) return cliResult(u)
          }
          return cliResult(moved)
        },
      })

      editor.add({
        name: "kanban_stop_task",
        description: "Stop a running task session, then mark its task blocked with the stop reason.",
        input: {
          type: "object",
          properties: { taskId: str("Running Kanban task uuid"), reason: str("Why the task must stop") },
          required: ["taskId", "reason"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any, context: any) => {
          const taskId = String(input.taskId).trim()
          const current = await runCli(["task", "show", taskId])
          if (!current.ok) return cliResult(current)
          const task = JSON.parse(current.text)
          if (task.status !== "running") return toolError("Only a running task can be stopped")
          if (task.sessionId) {
            const interrupted = await interruptTaskSession(context, ocBase(), ocH(), task.sessionId)
            if (!interrupted) return toolError("Could not interrupt task session")
          }
          const moved = await runCli(["task", "move", taskId, "blocked", "--actor", "agent"])
          if (!moved.ok) return cliResult(moved)
          const result = await runCli(["task", "update", taskId, "--actor", "agent", "--result", `Stopped: ${String(input.reason).trim()}`])
          return cliResult(result.ok ? result : moved)
        },
      })

      editor.add({
        name: "kanban_task_result",
        description:
          "kanban_task_result: Optional. Store or override the board's visible result for a task (shown under the card). Normally the last assistant message becomes the result automatically — use this only when you need a different, corrected, or richer result. Never write your answer into the description.",
        input: {
          type: "object",
          properties: {
            taskId: str("Kanban task id (uuid)"),
            result: str("Final answer / outcome summary, shown on the board card"),
            resultContext: str("Extra context for the result (sources, links, notes)"),
          },
          required: ["taskId", "result"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          const argv = [
            "task", "update", input.taskId,
            "--actor", "agent",
            "--result", input.result,
          ]
          if (input.resultContext !== undefined) {
            argv.push("--result-context", input.resultContext)
          }
          return cliResult(await runCli(argv))
        },
      })

      editor.add({
        name: "kanban_update_task",
        description:
          "kanban_update_task: Patch a task's metadata (title/description/priority/parent-session/depends-on). The description is the original task brief — do NOT overwrite it with your answer. Write your answer with task_result instead. Returns updated task JSON.",
        input: {
          type: "object",
          properties: {
            taskId: str("Kanban task id (uuid)"),
            title: str("New title (renames the task)"),
            description: str("Original task brief — never to store your result"),
            priority: priorityEnum("New priority"),
            parentSessionId: str("Parent session that created this task"),
            blockedByTaskIds: blockedByProp(
              "Depends-on: replace the predecessor list (same project). Pass [] to clear all dependencies. Unknown ids, self-references, foreign-project ids and cycles are rejected with an error.",
            ),
          },
          required: ["taskId"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          const argv = ["task", "update", input.taskId, "--actor", "agent"]
          if (input.title !== undefined) argv.push("--title", input.title)
          if (input.description !== undefined) argv.push("--description", input.description)
          if (input.priority !== undefined) argv.push("--priority", input.priority)
          if (input.parentSessionId !== undefined) {
            argv.push("--parent-session-id", input.parentSessionId)
          }
          if (Array.isArray(input.blockedByTaskIds)) {
            argv.push(
              "--blocked-by",
              input.blockedByTaskIds.map((v: unknown) => String(v).trim()).filter(Boolean).join(","),
            )
          }
          if (argv.length <= 3) toolError("nothing to update")
          return cliResult(await runCli(argv))
        },
      })

      // --- worktree isolation ---------------------------------------------

      editor.add({
        name: "kanban_worktree",
        description:
          "kanban_worktree: Manage the per-task git worktrees that isolate parallel tasks. action=create gives a task its own folder and branch; action=sync rebases the branch of a task onto the current project branch (call it before the verification step, so the checks run against the current code); action=merge merges that branch into the project branch; action=remove deletes the worktree folder; action=list shows all worktrees of a board. A task that reaches 'done' is merged automatically - use merge to retry a failed or conflicting merge.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "sync", "merge", "remove", "list"],
              description: "What to do with the worktree",
            },
            taskId: str("Task uuid. Required for create, sync, merge and remove."),
            projectId: str("Board uuid. Used by list; defaults to the board of the task."),
            target: str("Target branch for merge (default: the project branch)"),
            cleanup: {
              type: "boolean",
              description: "Merge only: remove the worktree folder after a successful merge",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          const action = String(input.action || "").trim().toLowerCase()
          if (action === "list") {
            const argv = ["worktree", "list"]
            if (input.projectId) argv.push("--project", String(input.projectId).trim())
            return cliResult(await runCli(argv))
          }
          if (!input.taskId?.trim()) toolError("taskId required")
          const taskId = String(input.taskId).trim()
          if (action === "create") return cliResult(await runCli(["worktree", "create", taskId]))
          if (action === "sync") {
            const argv = ["worktree", "sync", taskId]
            if (input.target) argv.push("--target", String(input.target).trim())
            return cliResult(await runCli(argv))
          }
          if (action === "merge") {
            const argv = ["worktree", "merge", taskId]
            if (input.target) argv.push("--target", String(input.target).trim())
            if (input.cleanup) argv.push("--cleanup")
            return cliResult(await runCli(argv))
          }
          if (action === "remove") {
            const argv = ["worktree", "remove", taskId, "--force"]
            return cliResult(await runCli(argv))
          }
          toolError("action must be create, merge, remove or list")
        },
      })

      editor.add({
        name: "kanban_heartbeat",
        description:
          "kanban_heartbeat: Report that this task is still alive, with a short progress note. The progress text shows on the board card. Send it once before you wait for a sub-task. Never loop or sleep: end your turn instead — the board queues the result of a finished sub-task into your session.",
        input: {
          type: "object",
          properties: {
            taskId: str("Kanban task id (your own task)"),
            progress: str("Short progress note, for example: waiting for the verification step"),
          },
          required: ["taskId"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any) => {
          if (!input.taskId?.trim()) toolError("taskId required")
          const argv = ["task", "heartbeat", String(input.taskId).trim(), "--actor", "agent"]
          if (input.progress) argv.push("--progress", String(input.progress))
          return cliResult(await runCli(argv))
        },
      })

      // --- features -------------------------------------------------------

      editor.add({
        name: "kanban_feature",
        description:
          "kanban_feature: Manage the feature worktrees of this board. A feature groups the steps of one unit of work (concept, implementation, verification, review, merge). action=create gives the feature one worktree and one branch that all its steps share. action=show lists the feature with its tasks. action=list shows the features of a board. action=merge merges the feature branch into the project branch (main) — only the integrator does this. action=delete removes the feature worktree; its tasks stay on the board.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "show", "list", "merge", "delete"],
              description: "What to do with the feature",
            },
            featureId: str("Feature uuid. Required for show, merge and delete."),
            projectId: str("Board uuid. Required for create; used by list."),
            title: str("Feature title (create)"),
            description: str("Feature description (create)"),
            base: str("Base branch for the feature (create, default: the project branch)"),
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any, context: any) => {
          const action = String(input.action || "").trim().toLowerCase()
          if (action === "create") {
            if (!input.projectId?.trim()) toolError("projectId required")
            if (!input.title?.trim()) toolError("title required")
            // The owner session: the steps that this session delegates later
            // join this feature automatically.
            const owner = callerSessionId(context)
            const argv = ["feature", "create", "--project", String(input.projectId).trim(),
              "--title", String(input.title).trim(), "--actor", "agent",
              ...(owner ? ["--owner-session-id", owner] : [])]
            if (input.description) argv.push("--description", String(input.description))
            if (input.base) argv.push("--base", String(input.base).trim())
            return cliResult(await runCli(argv))
          }
          if (action === "list") {
            const argv = ["feature", "list"]
            if (input.projectId) argv.push("--project", String(input.projectId).trim())
            return cliResult(await runCli(argv))
          }
          if (!input.featureId?.trim()) toolError("featureId required")
          const featureId = String(input.featureId).trim()
          if (action === "show") return cliResult(await runCli(["feature", "show", featureId]))
          if (action === "merge") return cliResult(await runCli(["feature", "merge", featureId]))
          if (action === "delete") {
            return cliResult(await runCli(["feature", "delete", featureId, "--actor", "agent"]))
          }
          toolError("action must be create, show, list, merge or delete")
        },
      })

      // --- delegation -----------------------------------------------------

      editor.add({
        name: "kanban_delegate",
        description:
          "kanban_delegate: Create a task for another agent on the team and start it immediately. Fire-and-forget by default — returns { task, sessionId, waited:false, parentSessionId } right away so the caller can fan out. Pass wait:true to block until done/blocked. This session is attached as parentSessionId automatically and is always the parent of the new task; never pass a parent session yourself. The subtask flips to done/blocked when the teammate is done. Pass blockedByTaskIds to make the subtask wait for other tasks: when a predecessor is not done yet the subtask is created in the backlog (started:false) instead of running. Pass featureId to run the subtask in the worktree of a feature, shared with the other steps of that feature. Every subtask without a feature gets its own git worktree, so parallel subtasks never share files. When you delegate from inside a delegated task, keep wait:false — the board queues the subtask result back into your session.",
        input: {
          type: "object",
          properties: {
            projectId: str("Project uuid the subtask belongs to"),
            title: str("Subtask title"),
            description: str("Subtask description / instructions for the teammate"),
            acceptanceCriteria: str(
              "Acceptance criteria, one per line. The board stores them on the card and sends them to the teammate.",
            ),
            priority: priorityEnum("Priority (default medium)"),
            agentId: str("Teammate agent id (must be in the project's team). Required."),
            agentName: str("Teammate agent display name"),
            modelId: str("Model id for the teammate session"),
            modelProviderID: str("Model provider id for the teammate session"),
            featureId: str(
              "Feature uuid. The task then works in the feature worktree and on the feature branch, shared with the other steps of that feature. Use it only for the steps of one feature, one step at a time.",
            ),
            blockedByTaskIds: blockedByProp(
              "Depends-on: predecessor task ids (same project) that must be done before this subtask starts. The server rejects unknown ids, self-references, foreign-project ids and cycles.",
            ),
            timeoutSec: {
              type: "number",
              description: "Max seconds to wait when wait:true (default 600, cap 1800)",
            },
            pollMs: { type: "number", description: "Poll interval in ms when wait:true (default 3000)" },
            wait: {
              type: "boolean",
              description: "When true, WAIT until done/blocked before returning. Default false.",
            },
          },
          required: ["projectId", "title", "agentId"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any, context: any) =>
          delegateTool(
            { ...input, parentSessionId: callerSessionId(context) },
            context,
            ctx,
          ),
      })

      editor.add({
        name: "kanban_message_to",
        description:
          "kanban_message_to: Send a follow-up into an existing subtask session. Fire-and-forget by default. The answer is queued into the calling parent chat. Pass wait:true only when an immediate tool result is required.",
        input: {
          type: "object",
          properties: {
            sessionId: str("Subtask session id (from a delegate return). Either this or taskId."),
            taskId: str("Subtask id — resolves to its sessionId. Either this or sessionId."),
            text: str("Follow-up question/instruction for the teammate"),
            parentSessionId: str("Override the answer destination (default: this calling session)"),
            timeoutSec: { type: "number", description: "Max seconds to monitor the answer (default 120, cap 600)" },
            pollMs: { type: "number", description: "Answer poll interval in ms (default 1500)" },
            wait: { type: "boolean", description: "Return the answer directly when true. Default false." },
          },
          required: ["text"],
          additionalProperties: false,
        },
        options: { namespace: "kanban" },
        execute: async (input: any, context: any) => messageToTool(input, context, ctx),
      })
    })
  },
}
