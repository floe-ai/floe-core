/**
 * ProviderAdapter — the shared interface all provider adapters must implement.
 *
 * Adapters translate between the generic floe-runtime worker lifecycle and
 * provider-specific SDKs (Codex, Claude, Copilot). Implementations differ
 * internally — they share only this contract.
 */

import type {
  WorkerConfig,
  WorkerSession,
  WorkerStatus,
  SendOptions,
  MessageResult,
  EventHandlers,
} from "../types.ts";

export interface ProviderAdapter {
  readonly provider: string;

  /**
   * Start a new worker session with the given configuration.
   * The adapter is responsible for injecting roleContent as the session
   * system prompt in whatever way the provider SDK supports.
   */
  startSession(config: WorkerConfig): Promise<WorkerSession>;

  /**
   * Resume an existing session by its session ID.
   * Adapters that do not support native session persistence should
   * reconstruct context from stored conversation history or metadata.
   */
  resumeSession(sessionId: string, config?: Partial<WorkerConfig>): Promise<WorkerSession>;

  /**
   * Send a message to an active session and return the response.
   */
  sendMessage(
    sessionId: string,
    message: string,
    options?: SendOptions
  ): Promise<MessageResult>;

  /**
   * Stream events from a session message. Calls handlers as events arrive.
   * Resolves when the message is complete or an error occurs.
   */
  streamEvents(
    sessionId: string,
    message: string,
    handlers: EventHandlers
  ): Promise<void>;

  /**
   * Get the current lifecycle status of a session.
   */
  getStatus(sessionId: string): Promise<WorkerStatus>;

  /**
   * Stop a session cleanly. After this, the session cannot receive messages.
   */
  stopSession(sessionId: string): Promise<void>;

  /**
   * Close and clean up a session. Called after stopSession or on error.
   */
  closeSession(sessionId: string): Promise<void>;
}
