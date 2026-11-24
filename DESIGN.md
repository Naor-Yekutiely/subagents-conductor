# conductor — design note (approved in chat 2026-11-24)

**Why:** when the main agent fans out to subagents, the person mostly waits for them. Make that wait readable:
what each subagent is doing right now, how long it has been running, and whether it is stuck or a zombie.

**Where:** the agent list under the prompt. Each subagent's row is its lane; the lanes stack into one pixel stage.
The `main` row stays the engine's. Terminal only (other surfaces keep the engine's row).

**Views:** `big` (default, 4 rows per agent) and `small` (2 rows). `/conductor big|small` switches and is
remembered across sessions ($.store). Big falls back to small with more than 4 agents or a short terminal.

**Big scene:** an animated Claude-logo conductor (mouth opening and closing) and one small figure per agent in its own
colour, legs stepping while it works. The conductor yells at the live agents in turn (~3 s each): a yellow shout runs
along that agent's wire and a `📣 "<task>, faster!"` bubble shows in its lane. What an agent is doing is an emoji, not
pixels (tiny pixel props were unreadable): 💻 command, 🔍 search, 📄 read, 📝 edit, 💭 thinking, 💤 waiting,
🚨 stuck, 🧟 zombie, ✅ done.

**Text per lane:** task in the agent's colour, a status chip, runtime / current action and how long it has
been running / step count, model and tokens / previous step.

**Health:** stuck = 60 s with no tokens moving while thinking, or one tool call running > 5 min. Zombie = listed as live,
nothing at all for 10 min. Waiting = the engine says it waits on its own background work. Done = the real reply
arrived (an interim "has not reported yet" report is ignored).

**Non-goals:** no progress percentages (dropped: model estimates add tokens and no signal). No tokens spent at all:
the mod only reads the agent list and the subagents' model steps.
