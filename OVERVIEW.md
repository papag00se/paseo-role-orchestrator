Role Orchestrator lets you define reusable Paseo agent roles with their own instructions, provider, model, and delegation permissions. Launch roles from a workspace and allow selected roles to launch children with no parent context, a summary, or the full session.

Requires Paseo 0.14.x. Create roles in the plugin settings, choose their providers and models, and configure which child roles they may launch. An optional completion gate uses a separate judge to assess whether a role has finished its work.

Role instructions and the chosen parent context are sent to each agent's configured provider. When enabled, the completion gate also sends conversation evidence to its judge provider and can send a follow-up to the agent. Agents and judges consume provider quota. Role delegation rules apply to the plugin's role tools; provider-native agent creation is outside those rules.
