// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

export { AbortError, SubagentIpcClient } from "./client.js";
export {
  ContextWrapperComponent,
  padToVisible,
  visibleLen,
} from "./context-wrapper.js";
export { createMessageReader, writeMessage } from "./framing.js";
export { SubagentIpcServer } from "./server.js";
export type {
  IpcMessage,
  MessageMeta,
  SendAndWaitOptions,
  TypedHandler,
  UiBridgeApi,
} from "./types.js";
export { withContext } from "./with-context.js";
