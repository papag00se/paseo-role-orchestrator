<div align="center">

![Paseo Role Orchestrator — illustrated project cover](docs/media/hero.png)

# Paseo Role Orchestrator

![Paseo compatibility](https://img.shields.io/badge/Paseo-0.9.1%E2%80%930.9.x-22c55e?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Desktop,%20web%20%26%20mobile-64748b?style=flat-square)

[Features](#features) · [Getting started](#getting-started) · [Compatibility](#compatibility) · [Reference](docs/REFERENCE.md)

</div>

🧑‍✈️ Build your own agent team. Define a **Coder**, a **Reviewer** and a **Supervisor** once, each with its own model, reasoning level and standing instructions. Then launch them from any workspace.

🤝 Roles can delegate to other roles, but only the ones you allow, and you choose how much of the parent's session each child sees. 🌳 Every child is a normal Paseo agent nested under its parent, so you can watch the whole tree work.

## Features

| Feature | What you get |
| --- | --- |
| 🧩 Reusable roles | Name, prompt, provider, model, reasoning level and mode, saved once |
| 🤝 Controlled delegation | Each role lists exactly which roles it may launch |
| 📦 Context per child | No parent context, the full session, or a summary |
| 🚀 Native launch panels | A **Roles** panel per workspace and a **Child roles** panel per agent |
| 🛠️ Role-aware tools | `list_roles` and `launch_role` only offer what the caller is allowed |
| 🌳 Visible hierarchy | Parents, children and helper agents show up in the normal workspace |
| ✅ Completion gate | An independent judge model checks finished turns (original plugin) |

## How it fits

![How role settings work together: the parts of a role, a Supervisor launching Coder, Reviewer and General Purpose children, and the three child context options](docs/media/role-settings.png)

## Getting started

Requires Paseo 0.9.1–0.9.x:

```bash
git clone https://github.com/papag00se/paseo-role-orchestrator.git
cd paseo-role-orchestrator
npm ci --legacy-peer-deps
npm run typecheck
paseo plugin install "$PWD"
```

Open **Settings → Plugins → Role Orchestrator → Roles and delegation**, create your roles, then launch them from the workspace **Roles** panel. Each role runs as a normal Paseo agent using its configured provider.

<p align="center"><img src="docs/media/role-setup.png" width="520" alt="Editing the Supervisor role in Paseo: name, delegation description, provider, model, reasoning level, mode, role prompt, completion gate, and allowed child roles with their context"></p>

**Completion gate** settings set the judge's provider, model, reasoning level and prompt once for every role that enables the gate.

![Role Orchestrator completion gate settings in Paseo: judge provider, model, reasoning level and gate prompt](docs/media/settings-completion-gate.png)

## Compatibility

Targets Paseo **0.9.1–0.9.x**. **Automatic completion hooks are not registered in this version:** completion settings and code are kept, but no automatic judge, wake or summary agents start. The earlier Paseo 0.8 implementation with automatic hooks is in Git history.

Provider-native `create_agent` remains outside the role policy: the plugin cannot enforce a per-agent ban through Paseo's provider-wide tool settings. See the reference for the exact delegation boundary.

## Development

```bash
npm run typecheck
npm test
```

[Role settings, delegation, completion evidence, and known limits →](docs/REFERENCE.md)
