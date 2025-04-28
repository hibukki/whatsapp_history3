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

// --- Parsing Helper Functions ---

// Parses [DATE, TIME] Sender: or [DATE, TIME] from the start of a single message's raw text
// Returns timestamp, sender (if applicable), and the remaining text content
const extractMessageMetadata = (
  rawMessageText: string
): { timestamp: string | null; sender: string | null; remaining: string } => {
  // Regex V1: Matches [TIMESTAMP] SENDER: [optional LRM]CONTENT
  // Captures: 1:Timestamp, 2:Sender, 3:Optional LRM, 4:Initial Content
  const messageStartRegex =
    /^\[(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})\] (.*?):\s?(\u200E)?(.*)/s; // Added \s?(\u200E)?

  // Regex V2: Matches [TIMESTAMP] [optional LRM]CONTENT (System message)
  // Captures: 1:Timestamp, 2:Optional LRM, 3:Initial Content
  const systemMessageRegex =
    /^\[(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})\]\s?(\u200E)?(.*)/s; // Added \s?(\u200E)?

  // Remove potential leading LRM character (U+200E) AND leading/trailing whitespace before matching
  const textToParse = rawMessageText.trim().replace(/^\u200E/, "");

  let timestamp: string | null = null;
  let sender: string | null = null;
  let remaining = textToParse; // Default to the cleaned text

  const matchV1 = textToParse.match(messageStartRegex);
  if (matchV1) {
    timestamp = matchV1[1];
    sender = matchV1[2];
    remaining = matchV1[4]; // Content is the 4th group now
  } else {
    const matchV2 = textToParse.match(systemMessageRegex);
    if (matchV2) {
      timestamp = matchV2[1];
      sender = null; // System message
      remaining = matchV2[3]; // Content is the 3rd group now
    }
    // Else: No metadata matched, return original cleaned text as remaining
  }

  return { timestamp, sender, remaining };
};

// Parses <attached: filename> from the *end* of the remaining text of a single message
// Returns attachment filename and the text *without* the attachment line
const parseAttachment = (
  remainingText: string
): { attachment: string | null; remaining: string } => {
  // Regex matches optional LRM, <attached: filename>, optional whitespace, then end of string $
  const attachmentSuffixRegex = /(\u200E?)<attached: (.*)>\s*$/; // Removed unnecessary escapes
  let attachment: string | null = null;
  let finalRemaining = remainingText;

  const match = remainingText.match(attachmentSuffixRegex);
  if (match) {
    attachment = match[2]; // The filename
    // Remove the matched suffix (including potential preceding newline)
    finalRemaining = remainingText.substring(0, match.index).trimEnd();
  }

  return { attachment, remaining: finalRemaining };
};

// --- Main Parsing Function ---
export const parseChatTxt = (rawContent: string): ParsedMessage[] => {
  const lines = rawContent.split("\n");
  const messages: ParsedMessage[] = [];
  let currentMessageLines: string[] = [];
  let currentMessageStartLine: number | null = null;

  // Regex to identify the start of *any* message line (standard or system)
  // Used only to group lines, not for deep parsing here. Handles optional LRM.
  const messageLineStartRegex =
    /^(\u200E)?\[\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}\]/;

  const finalizeCurrentMessage = () => {
    if (currentMessageStartLine !== null && currentMessageLines.length > 0) {
      const fullRawText = currentMessageLines.join("\n"); // Preserve original formatting

      // --- Pipeline Parsing ---
      // 1. Extract Metadata (Timestamp, Sender)
      const {
        timestamp,
        sender,
        remaining: remainingAfterMeta,
      } = extractMessageMetadata(fullRawText);

      // 2. Extract Attachment (from the end of remaining text)
      const { attachment, remaining: remainingAfterAttachment } =
        parseAttachment(remainingAfterMeta);

      // 3. The rest is content
      const content = remainingAfterAttachment.trim(); // Final trim for content

      messages.push({
        startLine: currentMessageStartLine,
        rawText: fullRawText, // Store original raw block
        timestamp: timestamp,
        sender: sender,
        content: content,
        attachment: attachment,
      });

      // Reset for next message
      currentMessageLines = [];
      currentMessageStartLine = null;
    }
  };

  // --- Line Grouping Loop ---
  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (messageLineStartRegex.test(line)) {
      // If a new message starts, finalize the previous one
      finalizeCurrentMessage();
      // Start the new message
      currentMessageStartLine = lineNumber;
      currentMessageLines = [line]; // Start with the first line
    } else if (currentMessageStartLine !== null) {
      // If it's a continuation line for an active message
      currentMessageLines.push(line);
    }
    // Ignore lines before the first valid message starts
  });

  // Finalize the very last message after the loop
  finalizeCurrentMessage();

  return messages;
};
