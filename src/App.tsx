import {
  useState,
  useEffect,
  ChangeEvent,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { Routes, Route, Link, useParams, useNavigate } from "react-router-dom"; // Import Router components
import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from "firebase/auth";
import { LocalStorageManager } from './localStorageUtils';
import { AppUser, wrapFirebaseUser, isLocalUser, isFirebaseUser } from './userTypes';
import { useUsername } from './hooks/useUsername';
import { useUserApproval } from './hooks/useUserApproval';
import { useUsernameInput } from './hooks/useUsernameInput';
import {
  ref,
  listAll,
  StorageReference,
  getBytes,
  uploadBytesResumable,
  UploadTaskSnapshot,
} from "firebase/storage";
import {
  collection,
  query,
  onSnapshot,
  QuerySnapshot,
  DocumentData,
} from "firebase/firestore"; // Import Firestore functions
import { auth, storage, db } from "./firebaseConfig"; // Import db
import "./App.css";
import { parseChatTxt, ParsedMessage } from "./chatParser"; // Import parser
import { searchMessages } from "./chatSearchUtils"; // Import search utility
import { MessageItem } from "./components/MessageItem"; // Import MessageItem
import { getErrorMessage } from "./utils/errorUtils";

// --- Helper Functions ---
const getAllFilePathsRecursive = async (
  ref: StorageReference
): Promise<string[]> => {
  let filePaths: string[] = [];
  const result = await listAll(ref);
  filePaths = filePaths.concat(result.items.map((item) => item.fullPath));
  for (const prefixRef of result.prefixes) {
    const subPaths = await getAllFilePathsRecursive(prefixRef);
    filePaths = filePaths.concat(subPaths);
  }
  return filePaths;
};

// Note: Using shared errorUtils.getErrorMessage instead

// --- Type Definitions ---
// Added optional chatFolderName
type GlobalSearchResult = ParsedMessage & { chatFolderName: string };

// Component for the Chat List Page (/)
function ChatListPage({ user }: { user: AppUser }) {
  const [chatFolders, setChatFolders] = useState<string[]>([]);
  const [loadingFolders, setLoadingFolders] = useState<boolean>(true);
  const [isRefreshingFolders, setIsRefreshingFolders] =
    useState<boolean>(false);
  const [folderListError, setFolderListError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [currentUploadFile, setCurrentUploadFile] = useState<string | null>(
    null
  );
  const [totalFilesToUpload, setTotalFilesToUpload] = useState<number>(0);
  const [filesUploaded, setFilesUploaded] = useState<number>(0);
  const navigate = useNavigate();

  // Chat List Filter State
  const [chatListFilter, setChatListFilter] = useState<string>("");

  // Renamed debug states to clarify they hold full paths
  const [debugUploadedFilePaths, setDebugUploadedFilePaths] = useState<
    string[]
  >([]);
  const [debugExtractedFilePaths, setDebugExtractedFilePaths] = useState<
    string[]
  >([]);
  const [debugChatFilePaths, setDebugChatFilePaths] = useState<string[]>([]);

  // Global Search State
  const [globalSearchTerm, setGlobalSearchTerm] = useState<string>("");
  const [isGlobalSearching, setIsGlobalSearching] = useState<boolean>(false);
  const [globalSearchResults, setGlobalSearchResults] = useState<
    GlobalSearchResult[]
  >([]);
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(
    null
  );
  // Store all messages fetched for global search to avoid refetching unless necessary
  const [allParsedMessages, setAllParsedMessages] = useState<
    GlobalSearchResult[]
  >([]);
  const myUsername = useUsername(user); // Use custom hook
  const isUserApproved = useUserApproval(user); // Use custom hook
  const { inputValue: usernameInputValue, handleUsernameChange } = useUsernameInput(user, myUsername);

  const listenerFetchInProgress = useRef(false);
  const prevChatFoldersString = useRef<string | null>(null); // Store previous folders string

  // --- Derived State for Autocomplete ---
  const allParticipants = useMemo(() => {
    if (allParsedMessages.length === 0) return [];
    // Get all unique senders from all loaded messages
    const senders = allParsedMessages.map((msg) => msg.sender).filter(Boolean); // Filter out null/empty
    return Array.from(new Set(senders as string[])).sort(); // Unique and sorted
  }, [allParsedMessages]); // Recompute only when all messages change

  // --- Function to fetch Folders from STORAGE ---
  const fetchFoldersFromStorage = useCallback(async (user: AppUser) => {
    setLoadingFolders(true);
    setIsRefreshingFolders(true);

    try {
      let newFolders: string[] = [];
      
      if (isLocalUser(user)) {
        // Fetch from local storage
        const localStorageManager = LocalStorageManager.getInstance();
        newFolders = localStorageManager.getChatFolderNames();
      } else {
        // Fetch from Firebase storage
        const chatsListRef = ref(storage, `user/${user.uid}/chats`);
        const resFolders = await listAll(chatsListRef);
        newFolders = resFolders.prefixes
          .map((prefixRef) => prefixRef.name)
          .sort();
      }

      setChatFolders(newFolders);
      setFolderListError(null);
    } catch (err) {
      console.error("Failed to list folders from Storage:", err);
      setFolderListError(getErrorMessage(err));
    } finally {
      setLoadingFolders(false);
      setIsRefreshingFolders(false);
      listenerFetchInProgress.current = false;
    }
  }, []); // Empty deps is correct - this function doesn't need to read any state, only sets it

  // --- Initial Fetch folders from Storage ---
  useEffect(() => {
    if (user) {
      fetchFoldersFromStorage(user);
    }
    return () => {
      setChatFolders([]);
      setLoadingFolders(true);
      setFolderListError(null);
      setIsRefreshingFolders(false);
      listenerFetchInProgress.current = false;
    };
  }, [user, fetchFoldersFromStorage]);

  // --- Firestore Listener for REFRESH Trigger (Firebase users only) ---
  useEffect(() => {
    if (!user || isLocalUser(user)) return;
    const cacheCollectionRef = collection(
      db,
      `users/${user.uid}/chatFoldersCache`
    );
    const q = query(cacheCollectionRef);
    const unsubscribe = onSnapshot(
      q,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_querySnapshot: QuerySnapshot<DocumentData>) => {
        if (listenerFetchInProgress.current) {
          return;
        }
        listenerFetchInProgress.current = true;
        fetchFoldersFromStorage(user);
      },
      (error) => {
        console.error("Firestore listener error (refresh trigger):", error);
      }
    );
    return () => {
      unsubscribe();
      listenerFetchInProgress.current = false;
    };
  }, [user, fetchFoldersFromStorage]);

  // --- Function to fetch DEBUG file lists (Moved to component scope) ---
  const fetchDebugLists = async (userId: string) => {
    const uploadsListRef = ref(storage, `user/${userId}/uploads`);
    const extractedListRef = ref(storage, `user/${userId}/extracted`);
    const chatsListRef = ref(storage, `user/${userId}/chats`); // For the _chat.txt etc lists
    try {
      console.log("Fetching debug file lists...");
      const [debugUploads, debugExtracted, debugChats] = await Promise.all([
        getAllFilePathsRecursive(uploadsListRef),
        getAllFilePathsRecursive(extractedListRef),
        getAllFilePathsRecursive(chatsListRef),
      ]);
      setDebugUploadedFilePaths(debugUploads);
      setDebugExtractedFilePaths(debugExtracted);
      setDebugChatFilePaths(debugChats);
      console.log("Debug lists fetched.");
    } catch (err) {
      console.error("Failed to fetch debug lists:", err);
      // Handle debug list error separately, maybe just log it
    }
  };

  // Fetch and parse *all* chats for global search
  const fetchAndParseAllChats = useCallback(
    async (user: AppUser, folders: string[]) => {
      setIsGlobalSearching(true);
      setGlobalSearchError(null);
      setGlobalSearchResults([]); // Clear previous results
      const allMessages: GlobalSearchResult[] = [];

      try {
        const promises = folders.map(async (folderName) => {
          try {
            let rawContent: string;
            
            if (isLocalUser(user)) {
              // Fetch from local storage
              const localStorageManager = LocalStorageManager.getInstance();
              rawContent = await localStorageManager.getChatFileContent(folderName);
            } else {
              // Fetch from Firebase storage
              const chatFilePath = `user/${user.uid}/chats/${folderName}/_chat.txt`;
              const chatFileRef = ref(storage, chatFilePath);
              const fileBytes = await getBytes(chatFileRef);
              rawContent = new TextDecoder().decode(fileBytes);
            }
            
            const parsed = parseChatTxt(rawContent);
            // Add folderName to each message
            return parsed.map((msg) => ({
              ...msg,
              chatFolderName: folderName,
            }));
          } catch (err) {
            console.error(`Failed to fetch/parse ${folderName}:`, err);
            // Return empty array for this chat on error, maybe show partial error?
            return [];
          }
        });

        const results = await Promise.all(promises);
        results.forEach((chatMessages) => allMessages.push(...chatMessages));
        setAllParsedMessages(allMessages); // Cache all messages
        console.log(
          `Fetched and parsed ${allMessages.length} total messages from ${folders.length} chats.`
        );
      } catch (err) {
        // Catch errors from Promise.all itself (unlikely here)
        console.error("Error fetching all chats:", err);
        setGlobalSearchError(
          "An unexpected error occurred while fetching all chats."
        );
      } finally {
        setIsGlobalSearching(false);
      }
    },
    [] // Remove globalSearchTerm dependency to prevent loops
  );

  // Fetch all chats effect - check for folder content change
  useEffect(() => {
    const currentFoldersString = JSON.stringify(chatFolders.sort());

    if (
      user &&
      chatFolders.length > 0 &&
      !isGlobalSearching &&
      currentFoldersString !== prevChatFoldersString.current
    ) {
      fetchAndParseAllChats(user, chatFolders);
      prevChatFoldersString.current = currentFoldersString;
    } else if (
      chatFolders.length === 0 &&
      prevChatFoldersString.current !== "[]"
    ) {
      console.log("Chat folders are now empty, clearing all parsed messages.");
      setAllParsedMessages([]);
      prevChatFoldersString.current = "[]";
    }
  }, [chatFolders, user, isGlobalSearching, fetchAndParseAllChats]);

  // Update search results when term changes
  useEffect(() => {
    if (!globalSearchTerm) {
      setGlobalSearchResults([]);
      return;
    }
    if (allParsedMessages.length > 0) {
      // Generic function preserves the GlobalSearchResult type
      setGlobalSearchResults(
        searchMessages(allParsedMessages, globalSearchTerm)
      );
    }
  }, [globalSearchTerm, allParsedMessages]);

  // Filtered Chat Folders List
  const filteredChatFolders = useMemo(() => {
    if (!chatListFilter) {
      return chatFolders;
    }
    const lowerCaseFilter = chatListFilter.toLowerCase();
    return chatFolders.filter((folderName) =>
      folderName.toLowerCase().includes(lowerCaseFilter)
    );
  }, [chatFolders, chatListFilter]);


  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) {
      return;
    }
    const filesToUpload = event.target.files;
    const totalFiles = filesToUpload.length;

    setUploading(true);
    setUploadError(null);
    setUploadProgress(0);
    setCurrentUploadFile(null);
    setTotalFilesToUpload(totalFiles);
    setFilesUploaded(0);

    try {
      if (isLocalUser(user)) {
        // Handle local storage upload
        setCurrentUploadFile(`Processing ${totalFiles} file(s) locally...`);
        const localStorageManager = LocalStorageManager.getInstance();
        await localStorageManager.uploadChatFiles(filesToUpload);
        setFilesUploaded(totalFiles);
        setUploadProgress(100);
        console.log("All files processed and stored locally!");
        // Refresh the folder list
        await fetchFoldersFromStorage(user);
      } else {
        // Handle Firebase storage upload
        for (let i = 0; i < totalFiles; i++) {
          const file = filesToUpload[i];
          const currentFileNumber = i + 1;
          setCurrentUploadFile(`${file.name} (${currentFileNumber}/${totalFiles})`);
          console.log(
            `Uploading file ${currentFileNumber}/${totalFiles}: ${file.name}`
          );

          const storagePath = `user/${user.uid}/uploads/${file.name}`;
          const storageRef = ref(storage, storagePath);
          const uploadTask = uploadBytesResumable(storageRef, file);

          // Use a promise to wait for each upload to complete
          await new Promise<void>((resolve, reject) => {
            uploadTask.on(
              "state_changed",
              (snapshot: UploadTaskSnapshot) => {
                // Calculate overall progress based on files completed + current file progress
                const overallProgress =
                  ((filesUploaded +
                    snapshot.bytesTransferred / snapshot.totalBytes) /
                    totalFiles) *
                  100;
                setUploadProgress(overallProgress);
              },
              (error) => {
                // Handle unsuccessful uploads for this file
                console.error(`Upload failed for ${file.name}:`, error);
                setUploadError(
                  `Upload failed for ${file.name}: ${getErrorMessage(error)}`
                );
                setCurrentUploadFile(null);
                setUploading(false);
                reject(error);
              },
              () => {
                // Handle successful uploads on complete
                console.log(`${file.name} uploaded successfully.`);
                setFilesUploaded((prev) => prev + 1);
                resolve();
              }
            );
          });

          // If an error occurred in the promise, stop the loop
          if (uploadError) {
            break;
          }
        }
      }

      // After the loop finishes (or breaks due to error)
      if (!uploadError) {
        console.log("All files uploaded successfully!");
        setCurrentUploadFile(null);
      }
    } catch (error) {
      console.error("Upload failed:", error);
      setUploadError(`Upload failed: ${getErrorMessage(error)}`);
    } finally {
      setUploading(false);
    }
  };

  // Handle clicking on a global search result
  const handleGlobalResultClick = (message: GlobalSearchResult) => {
    navigate(
      `/chats/${encodeURIComponent(message.chatFolderName)}/messages/${
        message.startLine
      }`
    );
  };

  // --- Effect for Fetching Debug Lists (Optional) ---
  // We keep this separate from the Firestore listener
  useEffect(() => {
    if (user) {
      // fetchDebugLists(user.uid); // Decide if you want to fetch these automatically
    }
  }, [user]);

  return (
    <div className="page-container">
      {/* Section for Username - needed for MessageItem */}
      <div className="config-section">
        <label htmlFor="usernameInputGlobal">Your Username: </label>
        <input
          id="usernameInputGlobal"
          type="text"
          value={usernameInputValue}
          onChange={handleUsernameChange}
          placeholder="Enter your exact chat name"
          list="allParticipantsList" // Add list attribute for datalist
        />
        {/* Add datalist for autocomplete suggestions */}
        <datalist id="allParticipantsList">
          {allParticipants.map((participant) => (
            <option key={participant} value={participant} />
          ))}
        </datalist>
      </div>

      {/* Global Search Section */}
      <div className="global-search-section file-section">
        <h2>Search All Chats</h2>
        <input
          type="search"
          value={globalSearchTerm}
          onChange={(e) => setGlobalSearchTerm(e.target.value)}
          placeholder="Search across all chats..."
          disabled={
            isGlobalSearching ||
            (allParsedMessages.length === 0 && chatFolders.length > 0)
          }
        />
        {isGlobalSearching && <p>Loading all chat data for search...</p>}
        {globalSearchError && (
          <p style={{ color: "red" }}>{globalSearchError}</p>
        )}
        {globalSearchTerm && !isGlobalSearching && (
          <p>
            {globalSearchResults.length} results found across{" "}
            {chatFolders.length} chats for "{globalSearchTerm}"
          </p>
        )}
      </div>

      {/* Global Search Results */}
      {globalSearchResults.length > 0 && (
        <div className="message-list global-search-results">
          {globalSearchResults.map((message) => (
            <div
              key={`${message.chatFolderName}-${message.startLine}`}
              className="global-result-item"
            >
              <small>
                From:{" "}
                <Link
                  to={`/chats/${encodeURIComponent(message.chatFolderName)}`}
                >
                  {message.chatFolderName}
                </Link>
              </small>
              <MessageItem
                message={message}
                myUsername={myUsername}
                userId={user.uid}
                chatFolderName={message.chatFolderName}
                user={user}
                onClick={() => handleGlobalResultClick(message)}
                isClickable={true}
              />
            </div>
          ))}
        </div>
      )}

      {/* Chat List Section */}
      <div className="chat-list-section file-section">
        <h2>
          Available Chats
          {/* Subtle refresh indicator */}
          {isRefreshingFolders && (
            <span style={{ fontSize: "0.8em", marginLeft: "10px" }}>
              (Refreshing...)
            </span>
          )}
        </h2>
        {/* Chat List Filter Input */}
        <div className="chat-list-filter">
          <input
            type="search"
            value={chatListFilter}
            onChange={(e) => setChatListFilter(e.target.value)}
            placeholder="Filter chats by name..."
          />
        </div>

        {/* Show initial loading OR error OR list */}
        {loadingFolders && chatFolders.length === 0 ? (
          <p>Loading chats...</p>
        ) : folderListError ? (
          <p style={{ color: "red" }}>Error loading chats: {folderListError}</p>
        ) : (
          <>
            {" "}
            {/* Fragment to hold list and empty messages */}
            {!loadingFolders &&
              chatFolders.length === 0 &&
              !folderListError && (
                <p>
                  No chats found. Upload an exported chat zip file and wait for
                  processing.
                </p>
              )}
            {!loadingFolders &&
              chatFolders.length > 0 &&
              filteredChatFolders.length === 0 && (
                <p>No chats match filter "{chatListFilter}".</p>
              )}
            {/* List is always rendered if chatFolders has items, even during refresh */}
            {chatFolders.length > 0 && (
              <ul className="chat-list">
                {filteredChatFolders.map((folderName) => (
                  <li key={folderName} className="chat-list-item">
                    <Link to={`/chats/${encodeURIComponent(folderName)}`}>
                      <span className="chat-name">{folderName}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Upload Section */}
      <div className="file-section">
        <h2>Upload Exported Chat (.zip)</h2>
        <input
          type="file"
          onChange={handleFileUpload}
          disabled={!isUserApproved || uploading}
          accept=".zip"
          multiple
          title={
            !isUserApproved
              ? "Uploads disabled: User not approved"
              : "Select one or more .zip files"
          }
        />
        {!isUserApproved && (
          <p style={{ color: "orange", marginTop: "10px" }}>
            Your user isn't approved for uploads: I don't want to have people's
            whatsapp history in a server I run while I don't feel comfortable
            about the security.
          </p>
        )}
        {uploading && (
          <div>
            <p>Uploading {totalFilesToUpload} file(s)...</p>
            {currentUploadFile && <p>Current: {currentUploadFile}</p>}
            <progress
              value={uploadProgress}
              max="100"
              style={{ width: "100%" }}
            />
            <p>
              {Math.round(uploadProgress)}% Complete ({filesUploaded}/
              {totalFilesToUpload})
            </p>
          </div>
        )}
        {uploadError &&
          (uploadError.includes("storage/unauthorized") ? (
            <p style={{ color: "red" }}>
              Upload failed: Permission denied. (Check approval status)
            </p>
          ) : (
            <p style={{ color: "red" }}>Upload failed: {uploadError}</p>
          ))}
        {!uploading &&
          filesUploaded > 0 &&
          totalFilesToUpload > 0 &&
          !uploadError && (
            <p style={{ color: "green" }}>
              Successfully uploaded {filesUploaded} file(s).
            </p>
          )}
      </div>

      {/* Collapsible Debug Panel */}
      <details className="debug-panel">
        <summary>Debug Information</summary>
        <div className="debug-content">
          <button
            onClick={() => user && fetchDebugLists(user.uid)}
            disabled={!user}
          >
            Fetch Debug File Lists
          </button>
          <div className="file-section debug-section">
            <h2>Your Uploaded Files (Debug)</h2>
            {debugUploadedFilePaths.length > 0 ? (
              <ul>
                {debugUploadedFilePaths.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              <p>None</p>
            )}
          </div>
          <div className="file-section debug-section">
            <h2>Extracted Files (Debug)</h2>
            {debugExtractedFilePaths.length > 0 ? (
              <ul>
                {debugExtractedFilePaths.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : (
              <p>None</p>
            )}
          </div>
          <div className="file-section debug-section">
            <h2>Processed Chats File List (Debug)</h2>
            {debugChatFilePaths.length > 0 ? (
              <ul>
                {debugChatFilePaths.map((f) => (
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

// --- ChatViewPage Component (Restored) ---
function ChatViewPage({ user }: { user: AppUser }) {
  const { chatFolderName: encodedChatFolderName, startLineParam } = useParams<{
    chatFolderName: string;
    startLineParam?: string;
  }>();
  const chatFolderName = encodedChatFolderName
    ? decodeURIComponent(encodedChatFolderName)
    : null;
  const navigate = useNavigate();
  const [parsedMessages, setParsedMessages] = useState<ParsedMessage[]>([]);
  const myUsername = useUsername(user); // Use custom hook
  const [parsingError, setParsingError] = useState<string | null>(null);
  const [loadingChat, setLoadingChat] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const messageListRef = useRef<HTMLDivElement>(null);

  const fetchAndParseChat = useCallback(
    async (user: AppUser, folderName: string) => {
      setParsedMessages([]);
      setParsingError(null);
      setLoadingChat(true);
      console.log(`Fetching and parsing chat: ${folderName}`);
      try {
        let rawContent: string;
        
        if (isLocalUser(user)) {
          // Fetch from local storage
          const localStorageManager = LocalStorageManager.getInstance();
          rawContent = await localStorageManager.getChatFileContent(folderName);
        } else {
          // Fetch from Firebase storage
          const chatFilePath = `user/${user.uid}/chats/${folderName}/_chat.txt`;
          const chatFileRef = ref(storage, chatFilePath);
          const fileBytes = await getBytes(chatFileRef);
          rawContent = new TextDecoder().decode(fileBytes);
        }
        
        const parsed = parseChatTxt(rawContent);
        
        setParsedMessages(parsed);
      } catch (err) {
        console.error(`Failed to fetch or parse ${folderName}:`, err);
        setParsingError(
          `Failed to load chat '${folderName}': ${getErrorMessage(err)}`
        );
        setParsedMessages([]);
      } finally {
        setLoadingChat(false);
      }
    },
    []
  );

  useEffect(() => {
    if (chatFolderName && user) {
      fetchAndParseChat(user, chatFolderName);
    } else {
      setLoadingChat(false);
      setParsingError("Chat folder name missing in URL.");
    }
    return () => {
      setParsedMessages([]);
      setParsingError(null);
    };
  }, [chatFolderName, user, fetchAndParseChat]);


  const messagesToDisplay = useMemo(() => {
    if (startLineParam) return parsedMessages;
    return searchMessages(parsedMessages, searchTerm);
  }, [parsedMessages, searchTerm, startLineParam]);

  useEffect(() => {
    if (startLineParam && messagesToDisplay.length > 0) {
      const targetLine = parseInt(startLineParam, 10);
      if (!isNaN(targetLine)) {
        const timer = setTimeout(() => {
          const element = document.getElementById(`message-${targetLine}`);
          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "center" });
            element.classList.add("highlighted-message");
            setTimeout(
              () => element.classList.remove("highlighted-message"),
              2000
            );
          }
        }, 100);
        return () => clearTimeout(timer);
      }
    }
  }, [startLineParam, messagesToDisplay]);

  const handleMessageClick = (message: ParsedMessage) => {
    if (searchTerm && chatFolderName) {
      navigate(
        `/chats/${encodeURIComponent(chatFolderName)}/messages/${
          message.startLine
        }`
      );
    }
  };

  return (
    <div className="page-container">
      <button onClick={() => navigate("/")}>&larr; Back to Chat List</button>
      <h2>Viewing Chat: {chatFolderName || "..."}</h2>

      {/* Search Input - Keep this part */}
      <div
        className="search-input config-section"
        style={{ marginBottom: "20px" }}
      >
        {" "}
        {/* Added config-section style and margin */}
        <label htmlFor="searchInput">Search Chat: </label>
        <input
          id="searchInput"
          type="search"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Filter messages..."
        />
      </div>

      {loadingChat && <p>Loading chat content...</p>}
      {parsingError && <p style={{ color: "red" }}>{parsingError}</p>}
      {!loadingChat && parsedMessages.length > 0 && searchTerm && (
        <p>
          {messagesToDisplay.length} of {parsedMessages.length} messages
          matching "{searchTerm}".
        </p>
      )}
      {!loadingChat && parsedMessages.length === 0 && !parsingError && (
        <p>
          No messages found in this chat file, or the file is empty/invalid.
        </p>
      )}
      {messagesToDisplay.length > 0 && (
        <div className="message-list" ref={messageListRef}>
          {messagesToDisplay.map((message) => {
            return (
              <MessageItem
                key={message.startLine}
                message={message}
                myUsername={myUsername}
                userId={user.uid}
                chatFolderName={chatFolderName || ""}
                user={user}
                onClick={() => handleMessageClick(message)}
                isClickable={!!searchTerm}
              />
            );
          })}
        </div>
      )}
      {!loadingChat &&
        parsedMessages.length > 0 &&
        messagesToDisplay.length === 0 &&
        searchTerm && <p>No messages match your search term "{searchTerm}".</p>}
    </div>
  );
}

// --- Main App Component (Restored) ---
function App() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loadingAuth, setLoadingAuth] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<'select' | 'firebase' | 'local'>('select');

  useEffect(() => {
    // Check for existing local user
    const localStorageManager = LocalStorageManager.getInstance();
    const existingLocalUser = localStorageManager.getLocalUser();
    
    if (existingLocalUser) {
      setUser(existingLocalUser);
      setAuthMode('local');
      setLoadingAuth(false);
      return;
    }

    // Set up Firebase auth listener
    const unsubscribe = onAuthStateChanged(
      auth,
      (currentUser) => {
        if (currentUser && authMode === 'firebase') {
          setUser(wrapFirebaseUser(currentUser));
        } else if (!currentUser) {
          setUser(null);
        }
        setLoadingAuth(false);
        setAuthError(null);
        console.log("Auth state changed:", currentUser);
      },
      (error) => {
        console.error("Auth state error:", error);
        setAuthError(getErrorMessage(error));
        setUser(null);
        setLoadingAuth(false);
      }
    );
    return () => unsubscribe();
  }, [authMode]);

  const handleFirebaseLogin = async () => {
    const provider = new GoogleAuthProvider();
    setAuthError(null);
    setAuthMode('firebase');
    try {
      const result = await signInWithPopup(auth, provider);
      setUser(wrapFirebaseUser(result.user));
    } catch (err) {
      console.error("Login failed:", err);
      setAuthError(getErrorMessage(err));
      setAuthMode('select');
    }
  };

  const handleLocalLogin = async (displayName: string) => {
    setAuthError(null);
    try {
      const localStorageManager = LocalStorageManager.getInstance();
      const localUser = localStorageManager.createLocalUser(displayName);
      setUser(localUser);
      setAuthMode('local');
    } catch (err) {
      console.error("Local login failed:", err);
      setAuthError(getErrorMessage(err));
    }
  };

  const handleLogout = async () => {
    setAuthError(null);
    try {
      if (user && isFirebaseUser(user)) {
        await signOut(auth);
      } else if (user && isLocalUser(user)) {
        const localStorageManager = LocalStorageManager.getInstance();
        localStorageManager.clearLocalUser();
      }
      setUser(null);
      setAuthMode('select');
    } catch (err) {
      console.error("Logout failed:", err);
      setAuthError(getErrorMessage(err));
    }
  };

  const ModeSelection = () => {
    const [localUserName, setLocalUserName] = useState('');
    
    return (
      <div style={{ maxWidth: '500px', margin: '50px auto', padding: '20px' }}>
        <h2>Choose How to Use WhatsApp History Viewer</h2>
        
        <div style={{ 
          border: '1px solid #ccc', 
          borderRadius: '8px', 
          padding: '20px', 
          margin: '20px 0',
          backgroundColor: '#f8f9fa'
        }}>
          <h3>🏠 Local Mode (Recommended for Privacy)</h3>
          <p>Your chat files stay on your device. No data is uploaded to any server.</p>
          <ul>
            <li>✅ Maximum privacy - files never leave your device</li>
            <li>✅ No server approval needed</li>
            <li>⚠️ Data only available on this device/browser</li>
            <li>⚠️ Limited by browser storage capacity</li>
          </ul>
          <div style={{ marginTop: '15px' }}>
            <input
              type="text"
              placeholder="Enter your name"
              value={localUserName}
              onChange={(e) => setLocalUserName(e.target.value)}
              style={{ padding: '8px', marginRight: '10px', width: '200px' }}
            />
            <button 
              onClick={() => handleLocalLogin(localUserName)}
              disabled={!localUserName.trim()}
              style={{ padding: '8px 16px' }}
            >
              Use Local Mode
            </button>
          </div>
        </div>

        <div style={{ 
          border: '1px solid #ccc', 
          borderRadius: '8px', 
          padding: '20px', 
          margin: '20px 0' 
        }}>
          <h3>☁️ Cloud Mode (Firebase)</h3>
          <p>Upload files to Firebase storage for access from any device.</p>
          <ul>
            <li>✅ Access from any device</li>
            <li>✅ No storage limits</li>
            <li>⚠️ Files uploaded to Firebase servers</li>
            <li>⚠️ Requires server approval for uploads</li>
          </ul>
          <button 
            onClick={handleFirebaseLogin}
            style={{ padding: '8px 16px', marginTop: '10px' }}
          >
            Sign in with Google
          </button>
        </div>
        
        {authError && (
          <p style={{ color: 'red', marginTop: '10px' }}>
            Error: {authError}
          </p>
        )}
      </div>
    );
  };

  if (loadingAuth) {
    return <div>Loading authentication...</div>;
  }

  return (
    <div className="App">
      <header className="app-header">
        <h1>WhatsApp History Viewer</h1>
        {user && (
          <div>
            <p>Welcome, {user.displayName}! 
              {isLocalUser(user) ? ' (Local Mode)' : ' (Cloud Mode)'}
            </p>
            <button onClick={handleLogout}>Logout</button>
          </div>
        )}
        {authError && user && <p style={{ color: "red" }}>Auth Error: {authError}</p>}
      </header>
      <main>
        {user ? (
          <Routes>
            <Route path="/" element={<ChatListPage user={user} />} />
            <Route
              path="/chats/:chatFolderName"
              element={<ChatViewPage user={user} />}
            />
            <Route
              path="/chats/:chatFolderName/messages/:startLineParam"
              element={<ChatViewPage user={user} />}
            />
            <Route path="*" element={<div>Page Not Found</div>} />
          </Routes>
        ) : (
          <ModeSelection />
        )}
      </main>
    </div>
  );
}

export default App;
