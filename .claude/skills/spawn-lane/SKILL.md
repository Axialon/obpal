---
name: spawn-lane
description: Start an ob.Pal development lane, meaning a background obpal-lane agent in its own git worktree. The skill picks the lane's ports, writes the short task prompt and records the lane in the coordination brief. Use when the coordinator hands a task to a parallel lane, or resumes one.
---

# Spawn a lane

In usage-conservation mode, Codex lanes are the default. Follow [codex-lane](../codex-lane/SKILL.md) and use `pnpm run lane -- start` / `resume`; the CLI allocates ports and records rounds. The manual Agent workflow below is for an explicitly chosen Claude lane.

The `obpal-lane` agent (.claude/agents/obpal-lane.md) already knows the rules, the e2e runner, the commit identity check, "merge master before you hand back" and the ≤400-word hand-back. The prompt holds only what is specific to this lane.

1. **Ports.** Pick a free pair and check it (`netstat -ano | findstr :<port>`):
   - the stand-in port comes from 5177–5188;
   - the worker port comes from 5190–5199.
   Lanes never get 5189 (the coordinator's worker for master runs), 5175 (dev), 5176 (the shared stand-in), 3000–3003, 5173–5174 or 8080.
2. **Spawn.** Call Agent with `subagent_type: "obpal-lane"` and `run_in_background: true`. Build the prompt from [prompt-template.md](prompt-template.md). The agent sets its own worktree isolation.
3. **Record** the lane in the brief (letter, agent id, ports, base sha, scope, what it waits on). If there's no brief yet, start one from [brief-template.md](brief-template.md) in the session scratchpad. Agent ids are internal: never show them to the owner.
4. **Master moved?** A running lane that depends on the change gets a SendMessage with the new sha, what changed, and "merge master first".

**Resume** a lane with SendMessage to its agent id: say what to change and "merge master <sha> first". Its worktree and context are intact.
