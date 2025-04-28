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

  // --- Parsing function ---
  const parseChatTxt = (rawContent: string): ParsedMessage[] => {
    const lines = rawContent.split("\n");
    const messages: ParsedMessage[] = [];
    let currentMessageLines: string[] = [];
    let currentMessageStartLine: number | null = null;

    // Regex to check if a line starts a new message
    const messageStartRegex =
      /^(\u200E)?\[\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}\]/;

    const finalizeCurrentMessage = () => {
      if (currentMessageStartLine !== null && currentMessageLines.length > 0) {
        messages.push({
          startLine: currentMessageStartLine,
          rawText: currentMessageLines.join("\n").trimEnd(),
        });
        currentMessageLines = [];
        currentMessageStartLine = null;
      }
    };

    lines.forEach((line, index) => {
      const lineNumber = index + 1; // 1-based line number
      const trimmedLine = line.trimEnd(); // Keep leading whitespace, remove trailing

      if (messageStartRegex.test(line)) {
        // Finalize the previous message before starting a new one
        finalizeCurrentMessage();

        // Start a new message
        currentMessageStartLine = lineNumber;
        currentMessageLines.push(trimmedLine);
      } else if (currentMessageStartLine !== null) {
        // If it's a continuation line for an active message
        currentMessageLines.push(trimmedLine);
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

          <div className="file-section">
            <h2>Parsed Chat: {selectedChatFolder || "(No Chat Selected)"}</h2>
            {parsingError && <p style={{ color: "red" }}>{parsingError}</p>}
            {selectedChatFolder &&
              parsedMessages.length === 0 &&
              !parsingError && <p>Loading or parsing chat...</p>}
            {parsedMessages.length > 0 && (
              <div className="message-list">
                {parsedMessages.map((message) => (
                  <pre key={message.startLine} className="message-item">
                    {message.rawText}
                  </pre>
                ))}
              </div>
            )}
            {!selectedChatFolder && chatFolders.length === 0 && (
              <p>Upload a zip containing a '_chat.txt' file to get started.</p>
            )}
          </div>

          <div className="file-section">
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
