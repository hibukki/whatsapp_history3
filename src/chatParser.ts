// src/chatParser.ts

// --- Type Definition ---
export type ParsedMessage = {
  startLine: number;
  rawText: string; // Keep raw text for now, maybe remove later
  timestamp: string | null;
  sender: string | null;
  content: string;
  attachment: string | null;
};

// --- Helper: Extract Content & Attachment ---
const extractContentAndAttachment = (
  msgLines: string[],
  meta: { timestamp: string | null; sender: string | null }
) => {
  const fullJoinedContent = msgLines.join("\n");
  let effectiveContent = fullJoinedContent;
  let attachment: string | null = null;
  // Regex to match the core attachment part anywhere in the string
  // No ^ anchor, allow for potential leading LRM or whitespace after prefix removal
  const attachmentContentRegex = /<attached: (.*)>/;

  // 1. Remove metadata prefix
  if (meta.timestamp) {
    const prefix = `[${meta.timestamp}] ${
      meta.sender ? meta.sender + ": " : ""
    }`;
    if (effectiveContent.startsWith(prefix)) {
      effectiveContent = effectiveContent.substring(prefix.length);
    } else if (
      !meta.sender &&
      effectiveContent.startsWith(`[${meta.timestamp}] `)
    ) {
      effectiveContent = effectiveContent.substring(
        `[${meta.timestamp}] `.length
      );
    }
  }

  // 2. Remove potential leading LRM and trim whitespace *from the potentially modified content*
  const cleanedContent = effectiveContent.replace(/^\u200E/, "").trim();

  // 3. Check if the cleaned content *contains* the attachment pattern
  const attachmentMatch = cleanedContent.match(attachmentContentRegex);

  if (attachmentMatch) {
    // 4. If it contains the pattern, check if the cleaned content is *ONLY* that pattern
    // We verify this by seeing if the matched string is the same as the whole cleaned string.
    if (cleanedContent === attachmentMatch[0]) {
      // It's an attachment-only message (after meta removal)
      attachment = attachmentMatch[1]; // Extract filename
      effectiveContent = ""; // Set final content to empty
    } else {
      // The pattern exists, but there's other text. Treat as regular content.
      // (This case is unlikely for <attached:...>, but handles edge cases)
      effectiveContent = cleanedContent;
    }
  } else {
    // No attachment pattern found in the cleaned content.
    effectiveContent = cleanedContent;
  }

  // Final cleanup is implicitly done by setting effectiveContent above
  // if (!effectiveContent.trim()) {
  //   effectiveContent = '';
  // }

  return { content: effectiveContent, attachment };
};

// --- Main Parsing Function ---
export const parseChatTxt = (rawContent: string): ParsedMessage[] => {
  const lines = rawContent.split("\n");
  const messages: ParsedMessage[] = [];
  let currentMessageLines: string[] = [];
  let currentMessageStartLine: number | null = null;
  let currentMessageMeta = {
    timestamp: null as string | null,
    sender: null as string | null,
  };

  // Regex V1: Basic message start with timestamp and sender
  // Handles optional LRM (‎) before the opening bracket
  const messageStartRegex =
    /^(\u200E)?\[(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})\] (.*?): (.*)$/;
  // Regex V2: System message (no sender)
  // Handles optional LRM (‎) before the opening bracket
  const systemMessageRegex =
    /^(\u200E)?\[(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})\] (.*)$/;

  // Helper: Finalize and Reset
  const finalizeCurrentMessage = () => {
    if (currentMessageStartLine !== null && currentMessageLines.length > 0) {
      const { content, attachment } = extractContentAndAttachment(
        currentMessageLines,
        currentMessageMeta
      );
      const fullRawText = currentMessageLines.join("\n").trimEnd();

      messages.push({
        startLine: currentMessageStartLine,
        rawText: fullRawText,
        timestamp: currentMessageMeta.timestamp,
        sender: currentMessageMeta.sender,
        content: content,
        attachment: attachment,
      });

      // Reset state for the next message
      currentMessageLines = [];
      currentMessageStartLine = null;
      currentMessageMeta = { timestamp: null, sender: null };
    }
  };

  // Main Parsing Loop
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmedLine = line.trimEnd();
    let handledAsStartOfMessage = false;

    const match = trimmedLine.match(messageStartRegex);
    if (match) {
      finalizeCurrentMessage();
      currentMessageStartLine = lineNumber;
      currentMessageMeta = { timestamp: match[2], sender: match[3] };
      currentMessageLines.push(line);
      handledAsStartOfMessage = true;
    }

    if (!handledAsStartOfMessage) {
      const systemMatch = trimmedLine.match(systemMessageRegex);
      if (systemMatch) {
        finalizeCurrentMessage();
        currentMessageStartLine = lineNumber;
        currentMessageMeta = { timestamp: systemMatch[2], sender: null };
        currentMessageLines.push(line);
        handledAsStartOfMessage = true;
      }
    }

    if (!handledAsStartOfMessage && currentMessageStartLine !== null) {
      currentMessageLines.push(line);
    }
  });

  finalizeCurrentMessage();

  return messages;
};
