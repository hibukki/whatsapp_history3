import React, { useState, useEffect, ChangeEvent } from "react";
import { Routes, Route, Link, useParams, useNavigate } from "react-router-dom"; // Import Router components
import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  User,
} from "firebase/auth";
import {
  ref,
  uploadBytes,
  listAll,
  StorageReference,
  getBytes,
} from "firebase/storage";
import { auth, storage } from "./firebaseConfig";
import "./App.css";

// Define the message type
type ParsedMessage = {
  startLine: number;
  rawText: string;
  timestamp: string | null;
  sender: string | null;
  content: string;
  attachment: string | null;
};

// Helper function to recursively list all files (used by fetchExtractedFiles and fetchChatFiles for debug list)
const listAllFilesHelper = async (ref: StorageReference): Promise<string[]> => {
  let files: string[] = [];
  const result = await listAll(ref);
  files = files.concat(result.items.map((item) => item.fullPath));
  for (const prefixRef of result.prefixes) {
    const subFiles = await listAllFilesHelper(prefixRef);
    files = files.concat(subFiles);
  }
  return files;
};

// Chat Parsing Logic
const parseChatTxt = (rawContent: string): ParsedMessage[] => {
  const lines = rawContent.split("\n");
  const messages: ParsedMessage[] = [];
  let currentMessageLines: string[] = [];
  let currentMessageStartLine: number | null = null;
  let currentMessageMeta = {
    timestamp: null as string | null,
    sender: null as string | null,
  };

  // --- Helper: Extract Content & Attachment ---
  const extractContentAndAttachment = (
    msgLines: string[],
    meta: { timestamp: string | null; sender: string | null }
  ) => {
    let content = msgLines.join("\n"); // Start with raw joined lines
    let attachment: string | null = null;
    const attachmentRegex = /^\u200E?<attached: (.*)>$/;

    // 1. Remove metadata prefix (if applicable) from the effective content
    // We do this *before* checking for attachments on the last line
    if (meta.timestamp) {
      const prefix = `[${meta.timestamp}] ${
        meta.sender ? meta.sender + ": " : ""
      }`;
      if (content.startsWith(prefix)) {
        content = content.substring(prefix.length);
      }
      // Handle system messages where prefix has no sender
      else if (!meta.sender && content.startsWith(`[${meta.timestamp}] `)) {
        content = content.substring(`[${meta.timestamp}] `.length);
      }
    }
    // Trim leading/trailing whitespace that might result from prefix removal or original lines
    content = content.trim();

    // 2. Check for attachment on the *original* last line
    const originalLastLine = msgLines[msgLines.length - 1] || "";
    const attachmentMatch = originalLastLine.match(attachmentRegex);

    if (attachmentMatch) {
      attachment = attachmentMatch[1];
      // 3. If attachment found, refine content by removing the last line *if appropriate*
      // Check if the effective content *ends with* the attachment line
      // Need to handle potential whitespace differences
      const contentEndsWithAttachmentLine = content.endsWith(
        originalLastLine.trim()
      );

      if (contentEndsWithAttachmentLine) {
        content = content
          .substring(0, content.length - originalLastLine.length)
          .trimEnd();
      }
      // If removing the last line leaves content empty, set it explicitly
      if (!content.trim()) {
        content = "";
      }
    }

    return { content, attachment };
  };

  // Regex V1: Basic message start with timestamp and sender
  const messageStartRegex =
    /^(\u200E)?\[(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})\] (.*?): (.*)$/;
  // Regex V2: System message (no sender)
  const systemMessageRegex =
    /^(\u200E)?\[(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})\] (.*)$/;

  // --- Helper: Finalize and Reset ---
  const finalizeCurrentMessage = () => {
    if (currentMessageStartLine !== null && currentMessageLines.length > 0) {
      const { content, attachment } = extractContentAndAttachment(
        currentMessageLines,
        currentMessageMeta
      );
      const fullRawText = currentMessageLines.join("\n").trimEnd();

      messages.push({
        startLine: currentMessageStartLine,
        rawText: fullRawText, // Keep original lines joined for raw view if needed
        timestamp: currentMessageMeta.timestamp,
        sender: currentMessageMeta.sender,
        content: content, // Use processed content
        attachment: attachment,
      });

      // Reset state for the next message
      currentMessageLines = [];
      currentMessageStartLine = null;
      currentMessageMeta = { timestamp: null, sender: null };
    }
  };

  // --- Main Parsing Loop ---
  lines.forEach((line, index) => {
    const lineNumber = index + 1; // 1-based line number
    const trimmedLine = line.trimEnd(); // Keep leading whitespace for potential formatting, remove trailing
    let handledAsStartOfMessage = false;

    // Try matching standard message first
    const match = trimmedLine.match(messageStartRegex);
    if (match) {
      finalizeCurrentMessage(); // Finalize previous before starting new
      currentMessageStartLine = lineNumber;
      currentMessageMeta = { timestamp: match[2], sender: match[3] };
      // Add the *original* untrimmed line to preserve potential leading whitespace
      currentMessageLines.push(line);
      handledAsStartOfMessage = true;
    }

    // If not standard, try matching system message
    if (!handledAsStartOfMessage) {
      const systemMatch = trimmedLine.match(systemMessageRegex);
      if (systemMatch) {
        finalizeCurrentMessage(); // Finalize previous before starting new
        currentMessageStartLine = lineNumber;
        currentMessageMeta = { timestamp: systemMatch[2], sender: null }; // No sender
        currentMessageLines.push(line); // Add original untrimmed line
        handledAsStartOfMessage = true;
      }
    }

    // If it wasn't a starting line, and we have an active message, append
    if (!handledAsStartOfMessage && currentMessageStartLine !== null) {
      // Add the *original* untrimmed line
      currentMessageLines.push(line);
    }
    // Ignore lines before the first valid message starts
  });

  // Finalize the very last message after the loop
  finalizeCurrentMessage();

  return messages;
};

// Error message helper
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

// Component for the Chat List Page (/)
function ChatListPage({ user }: { user: User }) {
  const [chatFolders, setChatFolders] = useState<string[]>([]);
  const [loadingFolders, setLoadingFolders] = useState<boolean>(true);
  const [listError, setListError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Debug states
  const [files, setFiles] = useState<string[]>([]);
  const [extractedFiles, setExtractedFiles] = useState<string[]>([]);
  const [chatFiles, setChatFiles] = useState<string[]>([]);

  // Fetch chat folders and debug file lists
  const fetchLists = async (userId: string) => {
    setLoadingFolders(true);
    setListError(null);
    const chatsListRef = ref(storage, `user/${userId}/chats`);
    const uploadsListRef = ref(storage, `user/${userId}/uploads`);
    const extractedListRef = ref(storage, `user/${userId}/extracted`);

    try {
      // Fetch folders
      const resFolders = await listAll(chatsListRef);
      const folders = resFolders.prefixes.map((prefixRef) => prefixRef.name);
      setChatFolders(folders);

      // Fetch debug lists (consider making these optional/on-demand)
      const [debugUploads, debugExtracted, debugChats] = await Promise.all([
        listAllFilesHelper(uploadsListRef),
        listAllFilesHelper(extractedListRef),
        listAllFilesHelper(chatsListRef),
      ]);
      setFiles(debugUploads);
      setExtractedFiles(debugExtracted);
      setChatFiles(debugChats);
    } catch (err) {
      console.error("Failed to list folders/files:", err);
      setListError(getErrorMessage(err));
      setChatFolders([]);
      // Clear debug lists on error too
      setFiles([]);
      setExtractedFiles([]);
      setChatFiles([]);
    } finally {
      setLoadingFolders(false);
    }
  };

  useEffect(() => {
    fetchLists(user.uid);
  }, [user.uid]); // Fetch lists when component mounts or user changes

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) {
      return;
    }
    const file = event.target.files[0];
    const storagePath = `user/${user.uid}/uploads/${file.name}`;
    const storageRef = ref(storage, storagePath);

    setUploading(true);
    setUploadError(null);
    try {
      await uploadBytes(storageRef, file);
      console.log("File uploaded successfully!");
      // Optionally trigger a refresh of lists after upload, though function handles processing
      // fetchLists(user.uid); // Or maybe just show a success message
    } catch (err) {
      console.error("File upload failed:", err);
      setUploadError(getErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="page-container">
      <h2>Available Chats</h2>
      {loadingFolders && <p>Loading chats...</p>}
      {listError && (
        <p style={{ color: "red" }}>Error loading chats: {listError}</p>
      )}
      {!loadingFolders && chatFolders.length === 0 && (
        <p>No chats found. Upload an exported chat zip file below.</p>
      )}
      {chatFolders.length > 0 && (
        <ul>
          {chatFolders.map((folderName) => (
            <li key={folderName}>
              <Link to={`/chats/${encodeURIComponent(folderName)}`}>
                {folderName}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Upload Section */}
      <div className="file-section">
        <h2>Upload Exported Chat (.zip)</h2>
        <input
          type="file"
          onChange={handleFileUpload}
          disabled={uploading}
          accept=".zip"
        />
        {uploading && <p>Uploading...</p>}
        {uploadError && (
          <p style={{ color: "red" }}>Upload failed: {uploadError}</p>
        )}
      </div>

      {/* Collapsible Debug Panel */}
      <details className="debug-panel">
        <summary>Debug Information</summary>
        <div className="debug-content">
          <div className="file-section debug-section">
            <h2>Your Uploaded Files (Debug)</h2>
            {files.length > 0 ? (
              <ul>
                {files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              <p>None</p>
            )}
            <button onClick={() => fetchLists(user.uid)}>
              Refresh Debug Lists
            </button>
          </div>
          <div className="file-section debug-section">
            <h2>Extracted Files (Debug)</h2>
            {extractedFiles.length > 0 ? (
              <ul>
                {extractedFiles.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              <p>None</p>
            )}
          </div>
          <div className="file-section debug-section">
            <h2>Processed Chats File List (Debug)</h2>
            {chatFiles.length > 0 ? (
              <ul>
                {chatFiles.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              <p>None</p>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

// Component for Viewing a Single Chat (/chats/:chatFolderName)
function ChatViewPage({ user }: { user: User }) {
  const { chatFolderName: encodedChatFolderName } = useParams<{
    chatFolderName: string;
  }>();
  const chatFolderName = encodedChatFolderName
    ? decodeURIComponent(encodedChatFolderName)
    : null;
  const navigate = useNavigate();

  const [parsedMessages, setParsedMessages] = useState<ParsedMessage[]>([]);
  const [participants, setParticipants] = useState<string[]>([]);
  const [myUsername, setMyUsername] = useState<string>("");
  const [parsingError, setParsingError] = useState<string | null>(null);
  const [loadingChat, setLoadingChat] = useState<boolean>(true);

  // Fetch and Parse function
  const fetchAndParseChat = async (userId: string, folderName: string) => {
    const chatFilePath = `user/${userId}/chats/${folderName}/_chat.txt`;
    const chatFileRef = ref(storage, chatFilePath);
    setParsedMessages([]);
    setParsingError(null);
    setLoadingChat(true);

    console.log(`Fetching and parsing: ${chatFilePath}`);
    try {
      const fileBytes = await getBytes(chatFileRef);
      const rawContent = new TextDecoder().decode(fileBytes);
      console.log(`Fetched ${rawContent.length} characters.`);
      const parsed = parseChatTxt(rawContent);
      console.log(`Parsed into ${parsed.length} messages.`);
      setParsedMessages(parsed);

      // Derive participants from parsed messages
      const uniqueSenders = Array.from(
        new Set(parsed.map((msg) => msg.sender).filter(Boolean))
      ) as string[];
      setParticipants(uniqueSenders);
    } catch (err) {
      console.error(`Failed to fetch or parse ${chatFilePath}:`, err);
      setParsingError(
        `Failed to load chat '${folderName}': ${getErrorMessage(err)}`
      );
      setParsedMessages([]);
      setParticipants([]);
    } finally {
      setLoadingChat(false);
    }
  };

  useEffect(() => {
    if (chatFolderName && user) {
      fetchAndParseChat(user.uid, chatFolderName);
    } else {
      // Redirect if folder name is missing?
      // navigate("/"); // Consider this
      setLoadingChat(false);
      setParsingError("Chat folder name missing in URL.");
    }
    // Clear state if chatFolderName changes (e.g., navigating back/forward)
    return () => {
      setParsedMessages([]);
      setParticipants([]);
      setParsingError(null);
      // myUsername persists between chats
    };
  }, [chatFolderName, user]); // Rerun on folder change or user change

  return (
    <div className="page-container">
      <button onClick={() => navigate("/")}>&larr; Back to Chat List</button>
      <h2>Viewing Chat: {chatFolderName || "..."}</h2>

      {/* Username Input */}
      <div className="config-section">
        <label htmlFor="usernameInput">Your Username: </label>
        <input
          id="usernameInput"
          type="text"
          value={myUsername}
          onChange={(e) => setMyUsername(e.target.value)}
          placeholder="Enter your exact chat name"
          list="participantsList"
        />
        <datalist id="participantsList">
          {participants.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>

      {loadingChat && <p>Loading chat content...</p>}
      {parsingError && <p style={{ color: "red" }}>{parsingError}</p>}
      {!loadingChat && parsedMessages.length === 0 && !parsingError && (
        <p>
          No messages found in this chat file, or the file is empty/invalid.
        </p>
      )}
      {parsedMessages.length > 0 && (
        <div className="message-list">
          {parsedMessages.map((message) => {
            const isMyMessage =
              message.sender === myUsername && myUsername !== "";
            const messageClass = isMyMessage
              ? "message-item my-message"
              : "message-item other-message";
            return (
              <div key={message.startLine} className={messageClass}>
                <div className="message-bubble">
                  <div className="message-meta">
                    <span className="sender">{message.sender || "System"}</span>
                    <span className="timestamp">{message.timestamp}</span>
                  </div>
                  <div className="message-content">
                    <p>{message.content}</p>
                    {message.attachment && (
                      <p className="attachment">
                        📎 Attached: {message.attachment}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Main App Component (Layout & Routing) ---
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (currentUser) => {
        setUser(currentUser);
        setLoadingAuth(false);
        setAuthError(null);
      },
      (error) => {
        console.error("Auth state error:", error);
        setAuthError(getErrorMessage(error));
        setUser(null);
        setLoadingAuth(false);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    setAuthError(null);
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login failed:", err);
      setAuthError(getErrorMessage(err));
    }
  };

  const handleLogout = async () => {
    setAuthError(null);
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Logout failed:", err);
      setAuthError(getErrorMessage(err));
    }
  };

  if (loadingAuth) {
    return <div>Loading authentication...</div>;
  }

  return (
    <div className="App">
      <header className="app-header">
        <h1>WhatsApp History Viewer</h1>
        {user && <p>Welcome, {user.displayName || user.email}!</p>}
        {user ? (
          <button onClick={handleLogout}>Logout</button>
        ) : (
          <button onClick={handleLogin}>Login with Google</button>
        )}
        {authError && <p style={{ color: "red" }}>Auth Error: {authError}</p>}
      </header>

      <main>
        {user ? (
          <Routes>
            <Route path="/" element={<ChatListPage user={user} />} />
            <Route
              path="/chats/:chatFolderName"
              element={<ChatViewPage user={user} />}
            />
            {/* Add other routes here if needed */}
            <Route path="*" element={<div>Page Not Found</div>} />{" "}
            {/* Catch-all */}
          </Routes>
        ) : (
          <div>
            <p>Please log in to view and upload your chat history.</p>
            {/* Optionally show login button again here if header isn't prominent */}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
