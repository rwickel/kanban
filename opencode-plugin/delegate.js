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

function projectRow(projectId) {
  const pj = runCli(["project", "list", "--json"])
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
  projectPath,
  sessionId,
}) {
  const styleGuide = loadStyleGuide()
  return (
    `You are ${agentLabel || "a teammate"} executing a delegated subtask. Complete it end-to-end in ${projectPath || "the project"}.\n` +
    `Task id: ${taskId}\nProject id: ${projectId}\nTask: ${title}\nDescription: ${description || "(none)"}\n` +
    `Session id: ${sessionId} (pass as parentSessionId when you create/delegate follow-up tasks).\n\n` +
    `When finished, just write your final answer as the last assistant message — the board captures it as the task result automatically and follows the session outcome (completed→done, failed→blocked). Do NOT call kanban_update_status or PATCH the task status yourself. Never write your answer into the description.` +
    (styleGuide ? `\n${styleGuide}\n` : "") +
    ` Fire-and-forget: the delegator already returned.`
  )
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
  const priority = args.priority || "medium"

  if (!args.agentId) {
    toolError("agentId required — pass a teammate agent id from the project's team (see project.agentIds)")
  }

  const timeoutMs = clamp(args.timeoutSec, 30, 1800, 600) * 1000
  const interval = clamp(args.pollMs, 1000, 15000, 3000)
  const shouldWait = args.wait === true
  const parentSessionId = args.parentSessionId ?? null

  const created = runCli([
    "task", "create",
    "--project", projectId,
    "--title", title,
    "--actor", "delegate",
    "--description", description,
    "--priority", priority,
    ...(args.agentId ? ["--agent-id", args.agentId] : []),
    ...(args.agentName ? ["--agent-name", args.agentName] : []),
    ...(args.modelId ? ["--model-id", args.modelId] : []),
    ...(args.modelProviderID ? ["--model-provider", args.modelProviderID] : []),
    ...(parentSessionId ? ["--parent-session-id", parentSessionId] : []),
  ])
  if (!created.ok) toolError(created.text)

  const tid = parseJson(created.text)?.id
  if (!tid) toolError(created.text)

  const moved = runCli(["task", "move", tid, "running", "--actor", "delegate"])
  if (!moved.ok) toolError(moved.text)

  // The project path drives the session location, and it validates the agent team.
  let projectPath = ""
  try {
    const row = projectRow(projectId)
    if (row) {
      projectPath = row.path || ""
      const team = Array.isArray(row.agentIds) ? row.agentIds : []
      if (team.length > 0 && args.agentId && !team.includes(args.agentId)) {
        toolError(`agentId "${args.agentId}" is not on this project's team [${team.join(", ")}]`)
      }
    }
  } catch (e) {
    toolError(String(e?.message || e))
  }

  const agentLabel = args.agentName || args.agentId || ""

  try {
    const session = await ctx.session.create({
      agent: agentLabel || undefined,
      ...(args.modelId && args.modelProviderID
        ? { model: { id: args.modelId, providerID: args.modelProviderID } }
        : {}),
      ...(projectPath ? { location: { directory: projectPath } } : {}),
    })
    if (!session?.id) throw new Error("session create returned no id")

    runCli([
      "task", "update", tid, "--actor", "delegate",
      "--session-id", session.id,
      ...(args.agentId ? ["--agent-id", args.agentId] : []),
      ...(args.agentName ? ["--agent-name", args.agentName] : []),
      "--startup-phase", "ready",
    ])

    const prompt = buildDelegatePrompt({
      agentLabel,
      taskId: tid,
      projectId,
      title,
      description,
      projectPath,
      sessionId: session.id,
    })

    await ctx.session.prompt({ sessionID: session.id, text: prompt })

    if (!shouldWait) {
      const cur = runCli(["task", "show", tid])
      return jsonResult({
        task: cur.ok ? parseJson(cur.text) ?? cur.text : cur.text,
        sessionId: session.id,
        waited: false,
        parentSessionId,
      })
    }

    return await awaitTask({ ctx, taskId: tid, sessionId: session.id, parentSessionId, timeoutMs, interval })
  } catch (e) {
    let cur = null
    try {
      const u = runCli([
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
    const cur = runCli(["task", "show", taskId])
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
    runCli([
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
    const row = runCli(["task", "show", taskId])
    if (!row.ok) toolError(row.text)
    taskRow = parseJson(row.text)
    sessionId = (taskRow?.sessionId || "").trim()
    if (!sessionId) toolError(`task ${taskId} has no sessionId yet`)
  }
  if (!sessionId) toolError("sessionId or taskId required")

  if (!taskRow) {
    const listed = runCli(["task", "list", "--json"])
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
            await ctx.session.prompt({
              sessionID: parentSessionId,
              text: `[Board] Subtask follow-up update:\n- "${title}" returned a follow-up answer.\n  Task ID: ${taskId || "(missing)"}\n  Session ID: ${sessionId}\n  Answer: ${result}\n\nReport the task title, task ID, session ID, and answer. Start no new work unless asked.`,
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
