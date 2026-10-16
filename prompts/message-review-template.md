# Message Review Template

Review this specific message and its surrounding execution context.

## Project context

- Project: `{projectName}`
- Project path: `{projectPath}`
- Original task: `{taskTitle}`
- Original task description: `{taskDescription}`
- Agent: `{agentName}`
- Model: `{modelName}`
- Session ID: `{sessionId}`
- Message ID: `{messageId}`

Review only the selected message and the relevant preceding tool calls.

## Review areas

### 1. Tool failures

- Identify every failed attempt related to this message.
- Explain the exact failure.
- Check whether the agent lacked access to the required tool.
- Check whether the tool was unavailable, denied, misconfigured, or used incorrectly.
- Separate tool-access problems from agent mistakes.

### 2. Response quality

- Check whether the agent response answers the task.
- Identify vague, incomplete, irrelevant, strange, or fabricated output.
- Check whether the agent ignored tool results or contradicted them.
- Explain what a correct response should contain.

### 3. Provider and model problems

- Identify signs of model or provider failure.
- Check for hallucinations, repetition, malformed output, refusal, timeout, context loss, or poor reasoning.
- Distinguish model problems from prompt, tool, or project problems.

### 4. Execution quality

- Check whether the agent selected the correct tools.
- Check whether it used the tool results correctly.
- Check whether it stopped too early or repeated failed attempts without changing strategy.
- Check whether the agent had enough context and permissions.

## Output

### Pros

- List useful actions, correct reasoning, or successful tool use.

### Cons

For each issue include:

- **Evidence:** Quote or identify the relevant message or tool call.
- **Problem:** Explain what went wrong.
- **Cause:** Classify the cause as agent, tool access, configuration, provider, model, prompt, or project.
- **Expected:** Explain what should have happened.
- **Severity:** Use low, medium, high, or critical.
- **Recommendation:** Give the most direct corrective action.

## Review rules

- Do not perform a generic board audit.
- Do not focus on duplicate tasks, acceptance criteria, progress, or priority unless they directly caused the selected message failure.
- Review the specific message ID and its execution context.
