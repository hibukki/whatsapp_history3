// src/chatParser.test.ts
import { describe, it, expect } from "vitest";
import { parseChatTxt } from "./chatParser";
import fs from "node:fs";
import path from "node:path";

describe("parseChatTxt", () => {
  it("should parse the example chat correctly and match snapshot", () => {
    // Construct the path relative to the current file
    // Assumes the test file is in src/ and the example is in examples/
    const filePath = path.resolve(
      __dirname,
      "../examples/chats/WhatsApp Chat - Example Whatsapp Group5/_chat.txt"
    );

    // Read the file content
    const rawContent = fs.readFileSync(filePath, "utf-8");

    // Parse the content
    const parsedMessages = parseChatTxt(rawContent);

    // Compare with snapshot
    expect(parsedMessages).toMatchSnapshot();
  });
});
