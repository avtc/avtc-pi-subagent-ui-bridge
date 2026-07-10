# avtc-pi-subagent-ui-bridge

Lets extensions' interactive dialogs from nested subagents render in the root session, with the subagent's last message as context, via simple integration.

## Features

- **Last-message context** — the subagent's last assistant message is forwarded alongside UI requests, so the user sees what the subagent was doing
- **No-op fallback** — all functions are transparent no-ops if the bridge isn't installed, so consumer extensions degrade gracefully
- **Cross-platform IPC** — named pipes on Windows, Unix sockets on *nix
- **Works with any subagent extension** — not coupled to a specific orchestrator; discovers the root over environment variables

## What It Looks Like

When a subagent (e.g. `worker`) calls `ask_user_question`, the bridge forwards it to the root session. The root renders the question dialog with the subagent's last message as context above it.

**With preceding message** — the subagent wrote a story, then asked a question. The context section shows the subagent's last assistant message:

![Question with preceding message from subagent](assets/images/with-preceeding-message.png)

**Without preceding message** — the subagent called the tool immediately without writing a message first. No context section is shown:

![Question without preceding message](assets/images/without-preceeding-message.png)

## Installation

```bash
pi install npm:avtc-pi-subagent-ui-bridge
```

## Usage

### Subagent launcher

Forward env vars so child processes can reach the root session's IPC server:

```ts
import { buildUiBridgeEnv } from "./ui-bridge-env.js";

// In your subagent spawn logic:
const env = buildUiBridgeEnv(agentName);
childProc = spawn("pi", [...args], { env: { ...process.env, ...env } });
```

### User-facing extension

Copy [`ui-bridge-forwarding.ts`](./ui-bridge-forwarding.ts) into your extension's source directory.

In your extension entry point:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subscribeToUiBridge, forwardToRoot, type RootHandler } from "./ui-bridge-forwarding.js";

// Define your root-side handler (renders the dialog when a subagent requests it)
const myHandler: RootHandler = async ({ ctx, payload }) => {
  return ctx.ui.custom(/* your dialog component */);
};

export default function (pi: ExtensionAPI) {
  // Registers handler (root side) + captures sendAndWait (child side)
  subscribeToUiBridge(pi, "my-content-type", myHandler);
}

// Child side: forward a request to root
export async function forwardMyRequest(payload: any, signal?: AbortSignal) {
  const reply = await forwardToRoot({
    contentType: "my-content-type",
    payload,
    text: "Request from subagent",
    signal,
    // User dialogs may take arbitrarily long — disable timeout
    timeoutMs: Infinity,
  });
  return reply?.payload ?? null;
}
```

The vendored file handles listener cleanup, reload safety, and session shutdown automatically — no `globalThis` or manual unsubscribe needed. If `avtc-pi-subagent-ui-bridge` isn't installed, all functions are transparent no-ops.

## Environment Variables

The bridge sets the discovery vars automatically; the launcher must forward them and set the agent name (the `buildUiBridgeEnv` helper does all three).

| Variable | Set by | Purpose |
|---|---|---|
| `PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET` | Root session extension | Socket path for child processes to connect to; its presence is also how a session detects it is a child (not the root) |
| `PI_SUBAGENT_UI_BRIDGE_AUTH_TOKEN` | Root session extension | Auth token for IPC handshake |
| `PI_SUBAGENT_CHILD_AGENT` | Subagent launcher (required) | Agent name attached to request metadata and displayed in context headers |

Subagent launchers **must** set `PI_SUBAGENT_CHILD_AGENT` to the agent's name and forward all three vars to child processes. The `buildUiBridgeEnv` helper under [Usage](#usage) does exactly this.

## Integrating with a Third-Party Subagent Extension

For the bridge to work, a subagent extension's **spawning code** (the logic that launches each child pi process) must do three things:

1. **Install this extension** so both the root and every child load it (`pi install npm:avtc-pi-subagent-ui-bridge`). The root then starts the IPC server automatically.
2. **Forward the two discovery env vars** — `PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET` and `PI_SUBAGENT_UI_BRIDGE_AUTH_TOKEN` — from the parent environment into each child. This happens **for free** when children inherit `process.env`; it must be done **explicitly** only if the launcher rebuilds a clean environment for the child.
3. **Set `PI_SUBAGENT_CHILD_AGENT`** to the spawned agent's name. This is never automatic — only the launcher knows which agent it is starting — and it is what labels the context shown in the root's UI.

> **⚠️ RPC spawn mode makes #2 mandatory, not optional.** A child spawned in RPC mode has `ctx.hasUI === true`. The bridge tells root from child by checking for an inherited `PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET`; if a launcher fails to forward it, an RPC-mode child misidentifies as root and starts its **own** server instead of connecting to the real one. Always forward the socket var (the cost is one line) so role detection is correct in every spawn mode.

The `buildUiBridgeEnv` snippet under [Usage](#usage) does exactly steps 2–3.

> Developed with [Z.ai](https://z.ai/subscribe?ic=N5IV4LLOOV) — get 10% off your subscription via this referral link.

## License

MIT
