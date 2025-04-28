import { useState, useEffect, ChangeEvent } from "react";
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
import { auth, storage } from "./firebaseConfig"; // Make sure this path is correct
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

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [extractedFiles, setExtractedFiles] = useState<string[]>([]);
  const [chatFiles, setChatFiles] = useState<string[]>([]);
  const [chatFolders, setChatFolders] = useState<string[]>([]); // State for chat folder names
  const [selectedChatFolder, setSelectedChatFolder] = useState<string | null>(
    null
  ); // State for selected chat
  const [parsedMessages, setParsedMessages] = useState<ParsedMessage[]>([]); // State for parsed messages
  const [participants, setParticipants] = useState<string[]>([]); // State for chat participants
  const [myUsername, setMyUsername] = useState<string>(""); // State for user's own username in chat
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [parsingError, setParsingError] = useState<string | null>(null); // Separate error state for parsing

  // Helper function to recursively list all files (used by fetchExtractedFiles and fetchChatFiles for debug list)
  const listAllFilesHelper = async (
    ref: StorageReference
  ): Promise<string[]> => {
    let files: string[] = [];
    const result = await listAll(ref);
    files = files.concat(result.items.map((item) => item.fullPath));
    for (const prefixRef of result.prefixes) {
      const subFiles = await listAllFilesHelper(prefixRef);
      files = files.concat(subFiles);
    }
    return files;
  };

  // Listen for auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
      if (!currentUser) {
        // Clear all user-specific data on logout
        setFiles([]);
        setExtractedFiles([]);
        setChatFiles([]);
        setChatFolders([]);
        setSelectedChatFolder(null);
        setParsedMessages([]);
        setError(null);
        setParsingError(null);
      }
    });
    return () => unsubscribe(); // Cleanup subscription on unmount
  }, []);

  // Fetch file lists when user logs in
  useEffect(() => {
    if (user) {
      fetchUserFiles(user.uid);
      fetchExtractedFiles(user.uid);
      fetchChatFiles(user.uid);
    } else {
      // State clearing is handled in onAuthStateChanged listener
    }
  }, [user]); // Re-run when user state changes

  // Auto-select first chat folder when available
  useEffect(() => {
    if (chatFolders.length > 0 && !selectedChatFolder) {
      setSelectedChatFolder(chatFolders[0]);
    }
    // Clear messages if no folders are available
    if (chatFolders.length === 0) {
      setSelectedChatFolder(null);
      // Parsed messages cleared via selectedChatFolder effect
    }
  }, [chatFolders]); // Re-run when chatFolders change

  // Fetch and parse chat when selectedChatFolder changes
  useEffect(() => {
    if (selectedChatFolder && user) {
      fetchAndParseChat(user.uid, selectedChatFolder);
    } else {
      setParsedMessages([]); // Clear messages if no folder selected
      setParsingError(null);
    }
  }, [selectedChatFolder, user]);

  // Auto-select first chat folder and derive participants
  useEffect(() => {
    if (parsedMessages.length > 0) {
      const uniqueSenders = Array.from(
        new Set(parsedMessages.map((msg) => msg.sender).filter(Boolean))
      ) as string[];
      setParticipants(uniqueSenders);
      // If myUsername isn't set or isn't in the list, maybe clear it or prompt?
      // For now, we just populate the list.
    }
  }, [parsedMessages]); // Update participants when messages change

  // --- Parsing function ---
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

  // --- Fetch and Parse function ---
  const fetchAndParseChat = async (userId: string, chatFolder: string) => {
    const chatFilePath = `user/${userId}/chats/${chatFolder}/_chat.txt`;
    const chatFileRef = ref(storage, chatFilePath);
    setParsedMessages([]); // Clear previous messages
    setParsingError(null);

    console.log(`Fetching and parsing: ${chatFilePath}`);

    try {
      const fileBytes = await getBytes(chatFileRef);
      const rawContent = new TextDecoder().decode(fileBytes);
      console.log(`Fetched ${rawContent.length} characters.`);
      const parsed = parseChatTxt(rawContent);
      console.log(`Parsed into ${parsed.length} messages.`);
      setParsedMessages(parsed);
    } catch (err) {
      console.error(`Failed to fetch or parse ${chatFilePath}:`, err);
      setParsingError(
        `Failed to load chat '${chatFolder}': ${getErrorMessage(err)}`
      );
      setParsedMessages([]); // Ensure messages are cleared on error
    }
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
      setError(null); // Clear previous errors
    } catch (err) {
      console.error("Login failed:", err);
      setError(getErrorMessage(err));
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setError(null); // Clear previous errors
    } catch (err) {
      console.error("Logout failed:", err);
      setError(getErrorMessage(err));
    }
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0 || !user) {
      return;
    }
    const file = event.target.files[0];
    const storagePath = `user/${user.uid}/uploads/${file.name}`;
    const storageRef = ref(storage, storagePath);

    setUploading(true);
    setError(null); // Clear previous errors
    try {
      await uploadBytes(storageRef, file);
      console.log("File uploaded successfully!");
      // Refresh file list after upload
      fetchUserFiles(user.uid);
      // Note: Extracted files list will update automatically via the cloud function trigger,
      // but a manual refresh button is also provided.
    } catch (err) {
      console.error("File upload failed:", err);
      setError(getErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const fetchUserFiles = async (userId: string) => {
    const listRef = ref(storage, `user/${userId}/uploads`);
    try {
      const res = await listAll(listRef);
      // Use fullPath to show the relative path within the bucket
      const filePaths = res.items.map((itemRef) => itemRef.fullPath);
      setFiles(filePaths);
      setError(null); // Clear previous errors
    } catch (err) {
      console.error("Failed to list files:", err);
      setError(getErrorMessage(err));
      setFiles([]); // Clear files on error
    }
  };

  const fetchExtractedFiles = async (userId: string) => {
    const listRef = ref(storage, `user/${userId}/extracted`);
    try {
      // const res = await listAll(listRef); // Removed unused variable

      // Helper function to recursively list all files
      const listAllFiles = async (ref: StorageReference): Promise<string[]> => {
        let files: string[] = [];
        const result = await listAll(ref);
        files = files.concat(result.items.map((item) => item.fullPath));
        for (const prefixRef of result.prefixes) {
          const subFiles = await listAllFiles(prefixRef);
          files = files.concat(subFiles);
        }
        return files;
      };

      const allExtractedFiles = await listAllFiles(listRef);
      setExtractedFiles(allExtractedFiles);
      setError(null); // Clear previous errors
    } catch (err) {
      console.error("Failed to list extracted files:", err);
      setError(getErrorMessage(err)); // Optionally show error for extracted files specifically
      setExtractedFiles([]); // Clear extracted files on error
    }
  };

  const fetchChatFiles = async (userId: string) => {
    const listRef = ref(storage, `user/${userId}/chats`);
    let allFiles: string[] = [];
    let folders: string[] = [];

    try {
      // Get folders (prefixes)
      const resFolders = await listAll(listRef);
      folders = resFolders.prefixes.map((prefixRef) => prefixRef.name);
      setChatFolders(folders);

      // Get all files recursively for debug view
      allFiles = await listAllFilesHelper(listRef);
      setChatFiles(allFiles);

      setError(null); // Clear general error if this fetch succeeds
    } catch (err) {
      console.error("Failed to list chat folders/files:", err);
      setError(getErrorMessage(err));
      setChatFiles([]);
      setChatFolders([]);
    }
  };

  // Helper to get a user-friendly error message
  const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="App">
      <h1>WhatsApp History Viewer</h1>
      {error && (
        <p style={{ color: "red" }}>Error loading file lists: {error}</p>
      )}
      {user ? (
        <div>
          <p>Welcome, {user.displayName || user.email}!</p>
          <button onClick={handleLogout}>Logout</button>

          {/* --- User Input Section --- */}
          <div className="config-section">
            <label htmlFor="usernameInput">Your Username in Chat: </label>
            <input
              id="usernameInput"
              type="text"
              value={myUsername}
              onChange={(e) => setMyUsername(e.target.value)}
              placeholder="Enter your exact username"
              list="participantsList"
            />
            {/* Optional: Datalist for suggestions */}
            <datalist id="participantsList">
              {participants.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>

          <div className="file-section">
            <h2>Upload File</h2>
            <input
              type="file"
              onChange={handleFileUpload}
              disabled={uploading}
              accept=".zip"
            />
            {uploading && <p>Uploading...</p>}
          </div>

          <div className="file-section">
            <h2>Your Uploaded Files</h2>
            {files.length > 0 ? (
              <ul>
                {files.map((filePath) => (
                  <li key={filePath}>{filePath}</li>
                ))}
              </ul>
            ) : (
              <p>No files uploaded yet.</p>
            )}
            <button onClick={() => fetchUserFiles(user.uid)}>
              Refresh Uploaded Files
            </button>
          </div>

          <div className="file-section">
            <h2>Extracted Files</h2>
            {extractedFiles.length > 0 ? (
              <ul>
                {extractedFiles.map((filePath) => (
                  <li key={filePath}>{filePath}</li>
                ))}
              </ul>
            ) : (
              <p>No files extracted yet (or refresh needed).</p>
            )}
            <button onClick={() => fetchExtractedFiles(user.uid)}>
              Refresh Extracted Files
            </button>
          </div>

          {/* --- Parsed Chat Display --- */}
          <div className="file-section">
            <h2>Parsed Chat: {selectedChatFolder || "(No Chat Selected)"}</h2>
            {parsingError && <p style={{ color: "red" }}>{parsingError}</p>}
            {selectedChatFolder &&
              parsedMessages.length === 0 &&
              !parsingError && <p>Loading or parsing chat...</p>}
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
                          <span className="sender">
                            {message.sender || "System"}
                          </span>
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
            {!selectedChatFolder && chatFolders.length === 0 && (
              <p>Upload a zip containing a '_chat.txt' file to get started.</p>
            )}
          </div>

          {/* Debug Sections */}
          <div className="file-section debug-section">
            <h2>Your Uploaded Files (Debug)</h2>
            {files.length > 0 ? (
              <ul>
                {files.map((filePath) => (
                  <li key={filePath}>{filePath}</li>
                ))}
              </ul>
            ) : (
              <p>No files uploaded yet.</p>
            )}
            <button onClick={() => fetchUserFiles(user.uid)}>
              Refresh Uploaded Files
            </button>
          </div>

          <div className="file-section debug-section">
            <h2>Extracted Files (Debug)</h2>
            {extractedFiles.length > 0 ? (
              <ul>
                {extractedFiles.map((filePath) => (
                  <li key={filePath}>{filePath}</li>
                ))}
              </ul>
            ) : (
              <p>No files extracted yet (or refresh needed).</p>
            )}
            <button onClick={() => fetchExtractedFiles(user.uid)}>
              Refresh Extracted Files
            </button>
          </div>

          <div className="file-section debug-section">
            <h2>Processed Chats File List (Debug)</h2>
            {chatFiles.length > 0 ? (
              <ul>
                {chatFiles.map((filePath) => (
                  <li key={filePath}>{filePath}</li>
                ))}
              </ul>
            ) : (
              <p>
                No chats processed yet (or requires a Zip containing
                '_chat.txt').
              </p>
            )}
            <button onClick={() => fetchChatFiles(user.uid)}>
              Refresh Processed Chats List (Debug)
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p>Please log in to manage your files.</p>
          <button onClick={handleLogin}>Login with Google</button>
        </div>
      )}
    </div>
  );
}

export default App;
