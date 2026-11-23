Role Orchestrator lets you define reusable Paseo agent roles with their own instructions, provider, model, and delegation permissions. Launch roles from a workspace and allow selected roles to launch children with no parent context, a summary, or the full session.

Requires Paseo 0.14 through 0.16. Create roles in the plugin settings, choose their providers and models, and configure which child roles they may launch.

Role instructions and the chosen parent context are sent to each agent's configured provider. Agents and judges consume provider quota. Role delegation rules apply to the plugin's role tools; provider-native agent creation is outside those rules.

A role can optionally restrict its subagents so they must run on a Paseo-tool-free `pi-worker` provider and can only message their parent. Setup of that provider is in the reference.

A role can set a compaction threshold for its Pi agents. Pi has no per-session switch for this, so the plugin gives such an agent its own Pi settings directory under `plugin-data/role-orchestrator-pi-agent/` in your Paseo home. That directory holds a copy of your Pi `settings.json` with one added value, the number of tokens Pi keeps free for that model, and links to everything else in your Pi directory, so credentials, sessions and packages stay shared and are not copied. The copy is readable only by you (the directory is mode 0700 and the file 0600), and the plugin sends it nowhere; Pi reads it as its settings. Copies made by an earlier version are tightened to the same permissions when the plugin loads.

A role can also set how long the provider keeps the agent's cached prompt. For Pi agents, `long` sets `PI_CACHE_RETENTION=long` in the agent's environment, which asks the provider to cache the prompt for longer (one hour on Anthropic, 24 hours on OpenAI). That can lower the cost of long runs, but your prompt then stays in the provider's cache for that time. Roles that may delegate default to `long` and others to `short`. Other providers have no such switch, so the option does nothing for them.

A role can optionally re-send its prompt to an agent after that agent's context is compacted, so the agent re-reads its instructions. This sends the role prompt to the agent's provider as a normal follow-up message.

A role can optionally send a prompt of your choosing to each of its running agents every N minutes. The prompt text goes to the agent's provider as a normal message and uses its quota.

A looping agent can stop its periodic prompts when it has nothing to do (`pause_loop`) and is woken by any real prompt. You can also pause and resume an agent's loop with the `/roles-pause-agent-loop` and `/roles-resume-agent-loop` slash commands; a pause you set is only lifted by you. Each pause or resume adds one small line to the agent's timeline. Role prompts should end a periodic prompt with: If there is nothing to do, call pause_loop.
