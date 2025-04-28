import { ParsedMessage } from "./chatParser";

/**
 * Filters an array of messages based on a search term.
 * Performs a case-insensitive search on the message's rawText.
 *
 * @param messages The array of message objects (must extend ParsedMessage) to filter.
 * @param searchTerm The term to search for.
 * @returns A new array containing only the messages that match the search term, preserving the original message type.
 */
export const searchMessages = <T extends ParsedMessage>(
  messages: T[],
  searchTerm: string
): T[] => {
  if (!searchTerm) {
    return messages; // Return all if search term is empty
  }
  const lowerCaseSearchTerm = searchTerm.toLowerCase();
  return messages.filter((message) =>
    message.rawText.toLowerCase().includes(lowerCaseSearchTerm)
  );
};
