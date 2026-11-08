---
description: "Enable authored fixed multi-agent workflows — flow documents, the graph runtime, and the Web canvas panel — with one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-flow-profile

English | [中文](README.zh.md)

## Summary

This bundle adds one layer to a dsh profile: the Agent Flow service that stores agent templates, validated flow documents, and run records; the graph runtime that executes a document through the profile's subagent provider; and the Web panel that edits graphs on a canvas and starts runs. No shipped profile includes it, so a profile gains fixed workflows only after this layer is added, and removing it withdraws all three rows. The layer changes composition only: it registers no model-facing tool, prompt, or session event of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

Add the layer to an initialized profile. From a source checkout, install it by path:

```sh
dsh plugin --profile web add /abs/path/to/packages/experimental/agent-flow-profile
dsh --profile web --dump-config
```

From the published package, install it by name, and remove it the same way:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-flow-profile
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-agent-flow-profile
```

The profile must already contain `@deepseek-ai/dsh-base`, whose storage trio and `spawn` subagent provider this layer consumes. Both forms were run against this checkout: the install links the bundle into the profile's dependencies and lists it in `dsh.profile.bundles`, and the dump then shows the `agent-flow`, `agent-flow-runtime`, and `ui-agent-flow` rows under this layer's header.

### What you get

The layer adds three rows. `agent-flow` owns templates, documents, and runs behind `ctx.agentFlows`; `agent-flow-runtime` registers the `graph` executor that interprets a document; `ui-agent-flow` adds the **Agent Flow** sidebar entry and its panel. Enable the bundle on the Web or Desktop Plugins page to activate the panel, which reads its [icon](icon.svg) from this package's `package.json.icon` declaration even while the bundle is disabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is its `dsh.bundle.patch` document: one `insert` list with the three rows and their configuration defaults. Because a bundle inserts rows rather than replacing them, a profile's own patch layer still overrides any of the three by id, and the rows keep the base layer's storage and subagent wiring. The service row selects the executor name the runtime row registers under, so the two must agree; both default to `graph`. The runtime row names the subagent provider used for node agents, which the base layer registers as `spawn`.

| Row | Package | Owns |
|---|---|---|
| `agent-flow` | [`dsh-experimental-agent-flow`](../agent-flow/README.md) | Templates, validated documents, run records, executor registry |
| `agent-flow-runtime` | [`dsh-experimental-agent-flow-runtime`](../agent-flow-runtime/README.md) | Graph scheduling and node-agent delegation |
| `ui-agent-flow` | [`dsh-experimental-client-ui-agent-flow`](../client-ui-agent-flow/README.md) | Canvas panel, template forms, run control |

No runtime invariant companion is published because the bundle carries a patch document and no runtime code.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Profiles and bundles](../../../docs/architecture.md#profiles-and-bundles) — how layers stack and how a patch targets a row.
- [dsh-experimental-agent-flow](../agent-flow/README.md) — the service and its validation rules.
- [dsh-experimental-agent-flow-runtime](../agent-flow-runtime/README.md) — scheduling, joins, and failure semantics.
- [Agent Flow subsystem](../../../docs/subsystems/agent-flow.md) — the flow types and executor seam.

-----

<a id="model-experience"></a>
## Model Experience

None, as this bundle registers no model-facing contribution of its own.

#### KV Cache effect

No direct effect; the runtime's node agents own any model-visible use a run performs.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what this layer cannot do yet or where it needs special operational care. They are current package constraints, not a task backlog.

- **No model-facing trigger** — the bundle adds no tool, so a run starts from the panel or host code only.
- **Executor and runtime names must agree** — the service's `executor` value and the runtime's registration name are separate configuration fields.
- **One provider for every node agent** — the runtime row's `provider` applies to all nodes; a per-node provider needs a template-level override the layer does not yet expose.
- **Experimental prototype with no stability promise** — the bundle is public, but its contracts can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>