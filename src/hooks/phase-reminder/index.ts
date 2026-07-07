/**
 * Phase reminder to append after each latest user message.
 *
 * Keeping this at the tail preserves immediate workflow guidance without
 * mutating the cached system prompt or prepending request-local content ahead
 * of the user's actual turn.
 */
import { PHASE_REMINDER } from '../../config/constants';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import type { SessionLifecycle } from '../session-lifecycle';
import { isUserMessageWithParts } from '../types';

export { PHASE_REMINDER };

interface PhaseReminderOptions {
  /** If provided, only inject when this returns true for the session. */
  shouldInject?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
}

/**
 * Creates the experimental.chat.messages.transform hook for phase reminder injection.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 * Only injects for the orchestrator agent.
 */
export function createPhaseReminderHook(
  options: PhaseReminderOptions | SessionLifecycle = {},
) {
  // Backward-compatible: if called with a SessionLifecycle directly, treat as coordinator
  const opts: PhaseReminderOptions =
    typeof options === 'object' && 'onSessionDeleted' in options
      ? { coordinator: options as SessionLifecycle }
      : (options as PhaseReminderOptions);
  const { coordinator, shouldInject } = opts;
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      if (messages.length === 0) {
        return;
      }

      let lastUserMessageIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (isUserMessageWithParts(messages[i])) {
          lastUserMessageIndex = i;
          break;
        }
      }

      if (lastUserMessageIndex === -1) {
        return;
      }

      const lastUserMessage = messages[lastUserMessageIndex];
      if (!isUserMessageWithParts(lastUserMessage)) {
        return;
      }

      const agent = lastUserMessage.info.agent;
      if (agent && agent !== 'orchestrator') {
        return;
      }

      const sessionId = (lastUserMessage as { info?: { sessionID?: string } })
        ?.info?.sessionID;
      if (shouldInject && (!sessionId || !shouldInject(sessionId))) {
        return;
      }

      // If post-file-tool-nudge is pending for this session, it handles
      // injection via system prompt — skip message-level injection.
      if (sessionId && coordinator?.hasPendingSession(sessionId)) {
        return;
      }

      const textPartIndex = lastUserMessage.parts.findIndex(
        (p) => p.type === 'text' && p.text !== undefined,
      );

      if (textPartIndex === -1) {
        return;
      }

      const originalText = lastUserMessage.parts[textPartIndex].text ?? '';
      if (originalText.includes(SLIM_INTERNAL_INITIATOR_MARKER)) {
        return;
      }
      // Prevent duplicate injection: check if any existing part already contains
      // the phase reminder (either merged into text or as a standalone part).
      if (lastUserMessage.parts.some((p) => p.text?.includes(PHASE_REMINDER))) {
        return;
      }

      // Append reminder as a new, separate message part instead of mutating
      // the user-authored text. This prevents the reminder from leaking into
      // the UI display and chat history (issue #448).
      lastUserMessage.parts.push({
        type: 'text',
        text: PHASE_REMINDER,
      });
    },
  };
}
