export const SUBAGENT_CONTEXT_HYGIENE_REMINDER =
  'Context warning reached; focus only on request-relevant files and finalize when ready.';

export const SUBAGENT_CONTEXT_HYGIENE_INSTRUCTION_OPEN =
  '<instruction name="subagent_context_hygiene">';

const INSTRUCTION_CLOSE = '</instruction>';
const CONTEXT_WARNING_THRESHOLD = 0.45;
const GENERATED_INSTRUCTION = `${SUBAGENT_CONTEXT_HYGIENE_INSTRUCTION_OPEN}\n${SUBAGENT_CONTEXT_HYGIENE_REMINDER}\n${INSTRUCTION_CLOSE}`;

interface Tokens {
  input?: unknown;
  cache?: { read?: unknown };
}

interface MessagePart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface ChatTransformMessage {
  info: {
    id?: string;
    role?: string;
    agent?: string;
    sessionID?: string;
  };
  parts: MessagePart[];
}

interface LastUserMessage {
  sessionID?: string;
  agent?: string;
  signature: string;
  message: ChatTransformMessage;
}

interface EventInput {
  type: string;
  properties?: {
    info?: {
      id?: string;
      sessionID?: string;
      agent?: string;
      providerID?: string;
      modelID?: string;
      tokens?: Tokens;
    };
    sessionID?: string;
  };
}

interface ToolInput {
  tool: string;
  sessionID?: string;
}

interface Options {
  getContextLimit: (
    providerID: string,
    modelID: string,
  ) => Promise<number | undefined>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

interface UsageState {
  providerID: string;
  modelID: string;
  used: number;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function usedContextTokens(tokens: Tokens | undefined): number | undefined {
  if (!tokens) return undefined;

  const input = tokens.input;
  const cacheRead = tokens.cache?.read;
  if (!isFinitePositiveNumber(input) && !isFinitePositiveNumber(cacheRead)) {
    return undefined;
  }

  return (
    (isFinitePositiveNumber(input) ? input : 0) +
    (isFinitePositiveNumber(cacheRead) ? cacheRead : 0)
  );
}

function stripInstruction(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(GENERATED_INSTRUCTION)) {
    return trimmed;
  }

  return trimmed.slice(0, -GENERATED_INSTRUCTION.length).trimEnd();
}

function appendInstruction(message: ChatTransformMessage): void {
  const textPart = [...message.parts]
    .reverse()
    .find((part) => part.type === 'text' && typeof part.text === 'string');
  if (!textPart) return;

  const baseText = stripInstruction(textPart.text ?? '');
  textPart.text = baseText
    ? `${baseText}\n\n${GENERATED_INSTRUCTION}`
    : GENERATED_INSTRUCTION;
}

function stripInstructionFromMessage(message: ChatTransformMessage): void {
  const textPart = [...message.parts]
    .reverse()
    .find((part) => part.type === 'text' && typeof part.text === 'string');
  if (!textPart) return;

  textPart.text = stripInstruction(textPart.text ?? '');
}

function isExternalUserMessage(message: ChatTransformMessage): boolean {
  return message.info.role === 'user';
}

function inferSessionID(
  messages: ChatTransformMessage[],
  index: number,
): string | undefined {
  const direct = messages[index]?.info.sessionID;
  if (direct) return direct;

  for (let i = index - 1; i >= 0; i--) {
    const sessionID = messages[i]?.info.sessionID;
    if (sessionID) return sessionID;
  }

  for (let i = index + 1; i < messages.length; i++) {
    const sessionID = messages[i]?.info.sessionID;
    if (sessionID) return sessionID;
  }

  return undefined;
}

function getLastExternalUserMessage(
  messages: ChatTransformMessage[],
): LastUserMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isExternalUserMessage(message)) continue;

    const partSignature = message.parts
      .map((part) => {
        if (part.type === 'text' && typeof part.text === 'string') {
          return `${part.type}:${stripInstruction(part.text).trim()}`;
        }
        return part.type ?? 'unknown';
      })
      .join('|');
    const ordinal = messages
      .slice(0, i + 1)
      .filter((item) => isExternalUserMessage(item)).length;

    return {
      sessionID: inferSessionID(messages, i),
      agent: message.info.agent,
      message,
      signature: message.info.id
        ? `${message.info.id}:${partSignature}`
        : `${ordinal}:${partSignature}`,
    };
  }

  return null;
}

export function createSubagentContextHygiene(options: Options) {
  const pending = new Set<string>();
  const sessionAgents = new Map<string, string>();
  const usageBySession = new Map<string, UsageState>();
  const requestSignatureBySession = new Map<string, string>();

  function clear(sessionID: string): void {
    pending.delete(sessionID);
    usageBySession.delete(sessionID);
    requestSignatureBySession.delete(sessionID);
    sessionAgents.delete(sessionID);
  }

  function isSubagentSession(sessionID: string, agent?: string): boolean {
    const resolved = agent ?? sessionAgents.get(sessionID);
    return Boolean(resolved && resolved !== 'orchestrator');
  }

  async function isOverThreshold(sessionID: string): Promise<boolean> {
    const usage = usageBySession.get(sessionID);
    if (!usage) return false;

    const limit = await options.getContextLimit(
      usage.providerID,
      usage.modelID,
    );
    if (!isFinitePositiveNumber(limit)) {
      return false;
    }

    return usage.used / limit >= CONTEXT_WARNING_THRESHOLD;
  }

  return {
    handleChatMessage(input: { sessionID: string; agent?: string }): void {
      if (!input.agent) return;
      sessionAgents.set(input.sessionID, input.agent);
    },

    async handleToolExecuteAfter(input: ToolInput): Promise<void> {
      if (!input.sessionID || !isSubagentSession(input.sessionID)) {
        return;
      }

      if (await isOverThreshold(input.sessionID)) {
        pending.add(input.sessionID);
        options.log?.('Armed subagent context hygiene reminder', {
          sessionID: input.sessionID,
          tool: input.tool,
        });
      }
    },

    async handleMessagesTransform(output: {
      messages: ChatTransformMessage[];
    }): Promise<void> {
      const lastUserMessage = getLastExternalUserMessage(output.messages);
      if (!lastUserMessage?.sessionID) {
        return;
      }

      const { sessionID } = lastUserMessage;
      const agent = lastUserMessage.agent ?? sessionAgents.get(sessionID);
      if (!isSubagentSession(sessionID, agent)) {
        stripInstructionFromMessage(lastUserMessage.message);
        return;
      }

      if (
        requestSignatureBySession.get(sessionID) !== lastUserMessage.signature
      ) {
        requestSignatureBySession.set(sessionID, lastUserMessage.signature);
        stripInstructionFromMessage(lastUserMessage.message);
        pending.delete(sessionID);
        return;
      }

      if (pending.has(sessionID)) {
        appendInstruction(lastUserMessage.message);
        pending.delete(sessionID);
      } else {
        stripInstructionFromMessage(lastUserMessage.message);
      }
    },

    async handleEvent(event: EventInput): Promise<void> {
      if (event.type === 'session.deleted') {
        const sessionID =
          event.properties?.sessionID ?? event.properties?.info?.id;
        if (sessionID) clear(sessionID);
        return;
      }

      if (event.type !== 'message.updated') {
        return;
      }

      const info = event.properties?.info;
      const sessionID = info?.sessionID;
      if (!sessionID) return;

      if (info.agent) {
        sessionAgents.set(sessionID, info.agent);
      }

      if (!info.providerID || !info.modelID) {
        return;
      }

      const used = usedContextTokens(info.tokens);
      if (used === undefined) {
        return;
      }

      usageBySession.set(sessionID, {
        providerID: info.providerID,
        modelID: info.modelID,
        used,
      });
    },
  };
}
