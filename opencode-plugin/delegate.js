// Delegate and follow-up tools for the kanban OpenCode plugin.
//
// These two tools drive real agent sessions. An external bridge had to reach
// OpenCode over HTTP (port plus password from .env). A plugin does not: the
// running server hands the plugin its own ctx.session client, so no port, no
// password, and no separate `opencode serve` is required. Board data still
// goes through server/kanban.py, so the CLI and the plugin share the store.

import {
  findPendingQuestion as findPendingQuestionMsg,
  findStuckTool,
  jsonResult,
  loadStyleGuide,
  parseJson,
  runCli,
  toolError,
} from "./core.js"

const clamp = (value, min, max, fallback) =>
  Math.min(Math.max(Number(value) || fallback, min), max)

async function projectRow(projectId) {
  const pj = await runCli(["project", "list", "--json"])
  if (!pj.ok) return null
  const list = parseJson(pj.text)
  return Array.isArray(list) ? list.find((p) => p.id === projectId) || null : null
}

function buildDelegatePrompt({
  agentLabel,
  taskId,
  projectId,
  title,
  description,
  acceptanceCriteria,
  projectPath,
  sessionId,
  worktree,
  feature,
}) {
  const styleGuide = loadStyleGuide()
  const place = worktree?.path || projectPath || "the project"
  let isolation
  if (feature?.path) {
    isolation =
      `You work in a FEATURE worktree that is shared with the other steps of this feature: ${feature.path}\n` +
      `Feature branch: ${feature.branch}\n` +
      `Rules: change only files inside this worktree. Commit your work on the feature branch ` +
      `(git add -A && git commit -m "..."). Do NOT merge, do NOT push, do NOT switch branches, ` +
      `and do NOT reset, clean or delete the folder — the work of the earlier steps is in it. ` +
      `Only one step works here at a time. The integrator merges the feature branch into main at the end.\n`
  } else if (worktree?.path) {
    isolation =
      `You work in an ISOLATED git worktree: ${worktree.path}\n` +
      `Branch: ${worktree.branch} (base ${worktree.base || "the project branch"})\n` +
      `Rules: change only files inside this worktree. Commit your work on this branch ` +
      `(git add -A && git commit -m "..."). Do NOT merge, do NOT push, do NOT switch branches, ` +
      `and do NOT edit the main project folder. The board merges your branch when the task is done. ` +
      `State the branch name and the changed files in your final message.\n`
  } else {
    isolation = `You work in the project folder: ${place}\n`
  }
  return (
    `You are ${agentLabel || "a teammate"} executing a delegated subtask. Complete it end-to-end in ${place}.\n` +
    isolation +
    `Task id: ${taskId}\nProject id: ${projectId}\nTask: ${title}\nDescription: ${description || "(none)"}\n` +
    (acceptanceCriteria ? `Acceptance criteria: ${acceptanceCriteria}\n` : "") +
    `Session id: ${sessionId} (pass as parentSessionId when you create/delegate follow-up tasks).\n\n` +
    `Before finishing, verify every acceptance criterion and required check. End with KANBAN_TASK_COMPLETE only when all are met; otherwise explain what remains and end with KANBAN_TASK_INCOMPLETE. A successful session alone does not prove completion. Do NOT call kanban_update_status or PATCH the task status yourself. Never write your answer into the description.` +
    (styleGuide ? `\n${styleGuide}\n` : "") +
    ` Fire-and-forget: the delegator already returned.`
  )
}

/**
 * Give the task its own git worktree so parallel tasks never share files,
 * git index or build output. Returns { path, branch, base } or null when the
 * project is not a git repo (the caller then uses the plain project folder).
 */
async function createWorktree(taskId) {
  const created = await runCli(["worktree", "create", taskId])
  if (!created.ok) return null
  const info = parseJson(created.text)
  if (!info || !info.ok || !info.path) return null
  return { path: info.path, branch: info.branch, base: info.base }
}

/** Flatten an assistant message payload to plain text, or "" when not text. */
function assistantText(msg) {
  if (!msg || typeof msg !== "object") return ""
  const pool = [
    ...(Array.isArray(msg.content) ? msg.content : []),
    ...(Array.isArray(msg.parts) ? msg.parts : []),
  ]
  const direct = pool.filter(
    (p) =>
      p &&
      typeof p === "object" &&
      String(p.type || "").toLowerCase() === "text" &&
      typeof p.text === "string" &&
      p.text.trim(),
  )
  if (direct.length) return direct.map((p) => p.text.trim()).join("\n").trim()
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim()
  return ""
}

async function listMessages(ctx, sessionId, limit = 30) {
  try {
    const res = await ctx.message.list({
      sessionID: sessionId,
      limit: { limit, order: "desc" },
    })
    return Array.isArray(res?.data) ? res.data : []
  } catch {
    // The message endpoint can fail while a session spins up.
    return []
  }
}

/** Wait for the session to go idle, giving up after timeoutMs. */
async function waitForIdle(ctx, sessionId, timeoutMs) {
  let timer
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  try {
    const result = await Promise.race([ctx.session.wait({ sessionID: sessionId }), guard])
    return result === "timeout" ? "timeout" : "idle"
  } catch {
    return "error"
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a subtask, start it immediately, and wait when asked.
 * Same contract as the HTTP POST /api/kanban/delegate.
 * The caller session id comes from the tool context, so callers never pass it.
 */
export async function delegateTool(args, context, ctx) {
  const projectId = args.projectId
  const title = args.title
  const description = args.description || ""
  const acceptanceCriteria = (args.acceptanceCriteria || "").trim()
  const priority = args.priority || "medium"

  if (!args.agentId) {
    toolError("agentId required — pass a teammate agent id from the project's team (see project.agentIds)")
  }

  const timeoutMs = clamp(args.timeoutSec, 30, 1800, 600) * 1000
  const interval = clamp(args.pollMs, 1000, 15000, 3000)
  const shouldWait = args.wait === true
  const parentSessionId = args.parentSessionId ?? null
  const featureId = (args.featureId ?? "").trim() || null
  const blockedBy = Array.isArray(args.blockedByTaskIds)
    ? args.blockedByTaskIds.map((v) => String(v ?? "").trim()).filter(Boolean)
    : []

  const created = await runCli([
    "task", "create",
    "--project", projectId,
    "--title", title,
    "--actor", "delegate",
    "--description", description,
    "--priority", priority,
    ...(acceptanceCriteria ? ["--acceptance-criteria", acceptanceCriteria] : []),
    ...(args.agentId ? ["--agent-id", args.agentId] : []),
    ...(args.agentName ? ["--agent-name", args.agentName] : []),
    ...(args.modelId ? ["--model-id", args.modelId] : []),
    ...(args.modelProviderID ? ["--model-provider", args.modelProviderID] : []),
    ...(parentSessionId ? ["--parent-session-id", parentSessionId] : []),
    ...(blockedBy.length ? ["--blocked-by", blockedBy.join(",")] : []),
    ...(featureId ? ["--feature", featureId] : []),
  ])
  if (!created.ok) toolError(created.text)

  const taskRow = parseJson(created.text)
  const tid = taskRow?.id
  if (!tid) toolError(created.text)

  // Depends-on: only start the teammate when every predecessor is done.
  // Otherwise the task stays in the backlog; the caller can poll it with
  // kanban_task_status or re-delegate once the predecessors finish.
  if (blockedBy.length) {
    const deps = await runCli(["task", "deps", tid])
    const info = deps.ok ? parseJson(deps.text) : null
    if (info && info.ready === false) {
      const pending = (info.predecessors || [])
        .filter((p) => !p.done)
        .map((p) => `${p.title || p.id} (${p.status ?? "missing"})`)
      return jsonResult({
        task: parseJson(created.text),
        started: false,
        waited: false,
        parentSessionId,
        blockedByTaskIds: info.blockedByTaskIds,
        reason:
          `Not started: ${pending.length} predecessor task(s) are not done yet — the task waits in the backlog. ` +
          `Pending: ${pending.join("; ")}. Once they are done, start it via kanban_update_status or re-delegate.`,
      })
    }
  }

  // The project path drives the session location, and it validates the agent team.
  let projectPath = ""
  try {
    const row = await projectRow(projectId)
    if (row) {
      projectPath = row.path || ""
      const team = Array.isArray(row.agentIds) ? row.agentIds : []
      if (!team.includes(args.agentId)) {
        toolError(`agentId "${args.agentId}" is not on this project's team [${team.join(", ")}]`)
      }
    }
  } catch (e) {
    toolError(String(e?.message || e))
  }

  const agentLabel = args.agentName || args.agentId || ""

  // Isolation: a feature task works in the feature worktree (shared by all
  // steps). A normal task gets its own worktree. Without a git repo the
  // session falls back to the plain project folder.
  const feature = featureId
    ? {
        id: featureId,
        path: taskRow?.worktreePath || "",
        branch: taskRow?.worktreeBranch || "",
      }
    : null
  const worktree = feature ? null : await createWorktree(tid)
  const workDir = feature?.path || worktree?.path || projectPath

  try {
    const session = await ctx.session.create({
      agent: agentLabel || undefined,
      ...(args.modelId && args.modelProviderID
        ? { model: { id: args.modelId, providerID: args.modelProviderID } }
        : {}),
      ...(workDir ? { location: { directory: workDir } } : {}),
    })
    if (!session?.id) throw new Error("session create returned no id")

    // The phase "sending-prompt" marks a task that the delegate starts
    // itself. The board tab starts every running task without a phase, so
    // without this mark it would start the task a second time (two sessions,
    // two features, two merges).
    await runCli([
      "task", "update", tid, "--actor", "delegate",
      "--session-id", session.id,
      ...(args.agentId ? ["--agent-id", args.agentId] : []),
      ...(args.agentName ? ["--agent-name", args.agentName] : []),
      "--startup-phase", "sending-prompt",
    ])
    const moved = await runCli(["task", "move", tid, "running", "--actor", "delegate", "--startup-phase", "sending-prompt"])
    if (!moved.ok) toolError(moved.text)

    const prompt = buildDelegatePrompt({
      agentLabel,
      taskId: tid,
      projectId,
      title,
      description,
      acceptanceCriteria,
      projectPath,
      sessionId: session.id,
      worktree,
      feature,
    })

    await ctx.session.prompt({ sessionID: session.id, text: prompt })
    // The prompt is in. The board may now follow the session.
    await runCli(["task", "update", tid, "--actor", "delegate", "--startup-phase", "ready"])

    if (!shouldWait) {
      const cur = await runCli(["task", "show", tid])
      return jsonResult({
        task: cur.ok ? parseJson(cur.text) ?? cur.text : cur.text,
        sessionId: session.id,
        waited: false,
        parentSessionId,
        ...(worktree ? { worktree } : {}),
      })
    }

    return await awaitTask({ ctx, taskId: tid, sessionId: session.id, parentSessionId, timeoutMs, interval })
  } catch (e) {
    let cur = null
    try {
      const u = await runCli([
        "task", "update", tid, "--actor", "delegate",
        "--status", "blocked",
        "--startup-phase", "error",
        "--startup-error", String(e?.message || e).slice(0, 500),
      ])
      cur = u.ok ? parseJson(u.text) : null
    } catch {
      /* best effort */
    }
    toolError({ ok: false, error: String(e?.message || e), task: cur })
  }
}

async function awaitTask({ ctx, taskId, sessionId, parentSessionId, timeoutMs, interval }) {
  const deadline = Date.now() + timeoutMs
  let lastStuckNotifiedAt = 0

  for (;;) {
    // The board is the source of truth for status, so keep polling it.
    const cur = await runCli(["task", "show", taskId])
    const row = cur.ok ? parseJson(cur.text) : null

    if (row && (row.status === "done" || row.status === "blocked")) {
      return jsonResult({ task: row, sessionId, waited: true, parentSessionId })
    }

    // The subtask is blocked on a human question. Hand it to the caller
    // instead of silently polling until timeout — the caller's own session
    // has a picker, so it can relay the question to the user and answer back.
    const pending = await findPendingQuestion(ctx, sessionId)
    if (pending) {
      return jsonResult({
        ok: true,
        needsAnswer: true,
        questions: pending.questions,
        questionToolId: pending.toolId,
        sessionId,
        taskId,
        parentSessionId,
        task: row,
        howToReply:
          "This subtask is waiting on a question nobody can answer from its own session. " +
          "Ask the user using your OWN question tool with the questions above, then relay the picked " +
          "labels back by finding the pending form for this session (GET /session/{sessionId}/form " +
          `with the tool id ${pending.toolId}) and replying POST /session/{sessionId}/form/{formID}/reply { answer: { q0, q1, … } } ` +
          "(one key per asked question, each value the chosen label or label array). " +
          "Do not mark the task done until you have relayed the answer.",
      })
    }

    const stuck = await detectStuckTool(ctx, sessionId, lastStuckNotifiedAt, taskId)
    if (stuck) {
      lastStuckNotifiedAt = Date.now()
      return jsonResult(stuck)
    }

    if (Date.now() >= deadline) {
      toolError({
        ok: false,
        error: `delegate timed out after ${Math.round(timeoutMs / 1000)}s — still ${row?.status ?? "unknown"}`,
        task: row,
        sessionId,
      })
    }

    const remaining = deadline - Date.now()
    await waitForIdle(ctx, sessionId, Math.min(interval, Math.max(remaining, 1000)))
  }
}

/**
 * Scan the subtask session for a running question/waiting tool.
 * Returns { toolId, tool, questions } or null.
 */
async function findPendingQuestion(ctx, sessionId) {
  try {
    const list = await listMessages(ctx, sessionId, 15)
    for (const msg of list) {
      const hit = findPendingQuestionMsg(msg)
      if (hit && hit.questions && hit.questions.length > 0) return hit
    }
  } catch {
    /* best effort — a scan failure just means keep polling */
  }
  return null
}

/**
 * Park a subtask as blocked when a tool ran longer than 90s without completing.
 * Returns a result payload when it acted, or null when the session is healthy.
 */
async function detectStuckTool(ctx, sessionId, lastNotifiedAt, taskId) {
  if (Date.now() - lastNotifiedAt <= 120000) return null
  try {
    const list = await listMessages(ctx, sessionId, 15)
    let stuck = null
    for (const msg of list) {
      const hit = findStuckTool(msg, 90000)
      if (hit && (!stuck || hit.ageMs > stuck.ageMs)) stuck = hit
    }
    if (!stuck) return null

    const msg = `stalled: tool '${stuck.name}' running for ${Math.round(stuck.ageMs / 1000)}s without completion`
    await ctx.session.interrupt({ sessionID: sessionId }).catch(() => {})
    await runCli([
      "task", "update", taskId, "--actor", "watchdog",
      "--status", "blocked",
      "--startup-phase", "error",
      "--startup-error", msg.slice(0, 500),
    ])
    return {
      ok: false,
      error: msg,
      task: { id: taskId, status: "blocked", stuckTool: stuck },
      sessionId,
      stalled: true,
    }
  } catch {
    return null
  }
}

/** Ask an existing subtask session and queue its answer to the parent by default. */
export async function messageToTool(args, context, ctx) {
  const text = (args.text || "").trim()
  if (!text) toolError("text required")

  let sessionId = (args.sessionId || "").trim()
  let taskId = args.taskId || null
  let taskRow = null

  if (!sessionId && taskId) {
    const row = await runCli(["task", "show", taskId])
    if (!row.ok) toolError(row.text)
    taskRow = parseJson(row.text)
    sessionId = (taskRow?.sessionId || "").trim()
    if (!sessionId) toolError(`task ${taskId} has no sessionId yet`)
  }
  if (!sessionId) toolError("sessionId or taskId required")

  if (!taskRow) {
    const listed = await runCli(["task", "list", "--json"])
    const rows = listed.ok ? parseJson(listed.text) : []
    taskRow = Array.isArray(rows) ? rows.find((row) => row?.sessionId === sessionId) || null : null
    if (!taskId) taskId = taskRow?.id || null
  }

  const timeoutMs = clamp(args.timeoutSec, 15, 600, 120) * 1000
  const interval = clamp(args.pollMs, 1000, 10000, 1500)
  const shouldWait = args.wait === true
  const parentSessionId = (args.parentSessionId || context?.sessionID || taskRow?.parentSessionId || "").trim()

  try {
    const before = await listMessages(ctx, sessionId, 20)
    const beforeId = before[0]?.id ?? null

    await ctx.session.prompt({ sessionID: sessionId, text })

    if (!shouldWait) {
      void (async () => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          await waitForIdle(ctx, sessionId, Math.min(interval, Math.max(deadline - Date.now(), 1000)))
          const list = await listMessages(ctx, sessionId, 30)
          const fresh = list.find((m) => m?.id && m.id !== beforeId && assistantText(m))
          if (fresh) {
            if (!parentSessionId || parentSessionId === sessionId) return
            const full = assistantText(fresh)
            const result = full.length > 4000 ? full.slice(0, 4000) : full
            const title = String(taskRow?.title || "(unknown task)").slice(0, 200)
            const branch = String(taskRow?.worktreeBranch ?? taskRow?.worktree_branch ?? "").trim()
            const branchLine = branch ? `\n  Worktree branch: ${branch}` : ""
            await ctx.session.prompt({
              sessionID: parentSessionId,
              text: `[Board] Subtask follow-up update:\n- "${title}" returned a follow-up answer.\n  Task ID: ${taskId || "(missing)"}\n  Session ID: ${sessionId}${branchLine}\n  Answer: ${result}\n\nReport the task title, task ID, session ID, worktree branch, and answer. Start no new work unless asked.`,
              delivery: "queue",
            })
            return
          }
          if (Date.now() >= deadline) return
        }
      })().catch(() => {})
      return jsonResult({ sessionId, taskId, waited: false, parentSessionId })
    }

    const deadline = Date.now() + timeoutMs
    for (;;) {
      await waitForIdle(ctx, sessionId, Math.min(interval, Math.max(deadline - Date.now(), 1000)))

      const list = await listMessages(ctx, sessionId, 30)
      const fresh = list.find((m) => m?.id && m.id !== beforeId && assistantText(m))
      if (fresh) {
        const full = assistantText(fresh)
        return jsonResult({
          sessionId,
          taskId,
          resultText: full.length > 4000 ? full.slice(0, 4000) : full,
          resultTruncated: full.length > 4000,
          messageId: fresh.id,
          waited: true,
        })
      }
      if (Date.now() >= deadline) {
        toolError({
          ok: false,
          error: `message_to timed out after ${Math.round(timeoutMs / 1000)}s — no new assistant message in ${sessionId}`,
          sessionId,
          taskId,
        })
      }
    }
  } catch (e) {
    toolError({ ok: false, error: String(e?.message || e), sessionId, taskId })
  }
}
