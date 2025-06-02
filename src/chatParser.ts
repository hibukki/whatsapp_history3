// src/chatParser.ts

// --- Type Definitions ---
export type TextDirection = "ltr" | "rtl" | "center";

export type ParsedMessage = {
  startLine: number;
  rawText: string; // Keep raw text for now, maybe remove later
  timestamp: string | null;
  sender: string | null;
  content: string;
  attachment: string | null;
  direction: TextDirection;
};

// --- Parsing Helper Functions ---

// Unicode character ranges
const HEBREW_RANGE = /[֐-׿]/;
const LATIN_RANGE = /[A-Za-z]/;
// Add other RTL ranges if needed (Arabic: /[؀-ۿ]/, etc.)

// Determines the primary text direction of a string
const detectTextDirection = (text: string): TextDirection => {
  if (!text) {
    return "center"; // Or 'ltr'? Default for empty seems neutral.
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (HEBREW_RANGE.test(char)) {
      return "rtl";
    }
    if (LATIN_RANGE.test(char)) {
      return "ltr";
    }
    // Ignore neutral characters like spaces, punctuation, numbers, symbols for initial detection
  }
  // If no strong LTR or RTL characters were found
  return "center"; // Treat messages with only symbols/numbers as center
};

// Parses [DATE, TIME] Sender: or [DATE, TIME] from the start of a single message's raw text
// Returns timestamp, sender (if applicable), and the remaining text content
const extractMessageMetadata = (
  rawMessageText: string
): { timestamp: string | null; sender: string | null; remaining: string } => {
  // Regex V1: Matches [TIMESTAMP] SENDER: [optional LRM]CONTENT
  // Captures: 1:Timestamp, 2:Sender, 3:Optional LRM, 4:Initial Content
  // Support multiple date formats: DD/MM/YYYY, D.M.YYYY, DD.MM.YYYY, etc.
  const messageStartRegex =
    /^\[(\d{1,2}[.\/]\d{1,2}[.\/]\d{4}, \d{1,2}:\d{2}:\d{2})\] (.*?):\s?(\u200E)?(.*)/s;

  // Regex V2: Matches [TIMESTAMP] [optional LRM]CONTENT (System message)
  // Captures: 1:Timestamp, 2:Optional LRM, 3:Initial Content
  const systemMessageRegex =
    /^\[(\d{1,2}[.\/]\d{1,2}[.\/]\d{4}, \d{1,2}:\d{2}:\d{2})\]\s?(\u200E)?(.*)/s;

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

// --- Main Orchestrating Parsing Function ---
export const parseChatTxt = (rawContent: string): ParsedMessage[] => {
  const lines = rawContent.split("\n");
  const messages: ParsedMessage[] = [];
  let currentMessageLines: string[] = [];
  let currentMessageStartLine: number | null = null;

  // Regex to identify the start of *any* message line (standard or system)
  // Used only to group lines, not for deep parsing here. Handles optional LRM.
  // Support multiple date formats: DD/MM/YYYY, D.M.YYYY, DD.MM.YYYY, etc.
  const messageLineStartRegex =
    /^(\u200E)?\[\d{1,2}[.\/]\d{1,2}[.\/]\d{4}, \d{1,2}:\d{2}:\d{2}\]/;

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

      // 4. Detect direction based on final content
      const direction = detectTextDirection(content);

      messages.push({
        startLine: currentMessageStartLine,
        rawText: fullRawText, // Store original raw block
        timestamp: timestamp,
        sender: sender,
        content: content,
        attachment: attachment,
        direction: direction, // Add direction
      });

      // Reset for next message
      currentMessageLines = [];
      currentMessageStartLine = null;
    }
  };

  // --- Line Grouping Loop ---
  let messageStartCount = 0;
  let firstNonMatchingLines: string[] = [];
  
  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (messageLineStartRegex.test(line)) {
      // If a new message starts, finalize the previous one
      finalizeCurrentMessage();
      // Start the new message
      currentMessageStartLine = lineNumber;
      currentMessageLines = [line]; // Start with the first line
      messageStartCount++;
    } else if (currentMessageStartLine !== null) {
      // If it's a continuation line for an active message
      currentMessageLines.push(line);
    } else {
      // Lines before first message or lines that don't match
      if (firstNonMatchingLines.length < 10) {
        firstNonMatchingLines.push(`Line ${lineNumber}: "${line}"`);
      }
    }
    // Ignore lines before the first valid message starts
  });
  
  // Finalize the very last message after the loop
  finalizeCurrentMessage();

  return messages;
};
