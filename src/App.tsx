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
  User,
} from "firebase/auth";
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
  doc,
  setDoc,
} from "firebase/firestore"; // Import Firestore functions
import { auth, storage, db } from "./firebaseConfig"; // Import db
import "./App.css";
import { parseChatTxt, ParsedMessage } from "./chatParser"; // Import parser
import { searchMessages } from "./chatSearchUtils"; // Import search utility
import { MessageItem } from "./components/MessageItem"; // Import MessageItem

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

const errorMessageToString = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

// --- Type Definitions ---
// Added optional chatFolderName
type GlobalSearchResult = ParsedMessage & { chatFolderName: string };

// Component for the Chat List Page (/)
function ChatListPage({ user }: { user: User }) {
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
  const [myUsername, setMyUsername] = useState<string>("");

  // Ref for debouncing Firestore writes
  const usernameWriteTimeout = useRef<NodeJS.Timeout | null>(null);

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
  const fetchFoldersFromStorage = useCallback(async (userId: string) => {
    const wasInitiallyEmpty = chatFolders.length === 0;
    if (wasInitiallyEmpty) {
      setLoadingFolders(true);
    } else {
      setIsRefreshingFolders(true);
    }

    const chatsListRef = ref(storage, `user/${userId}/chats`);
    try {
      const resFolders = await listAll(chatsListRef);
      const newFolders = resFolders.prefixes
        .map((prefixRef) => prefixRef.name)
        .sort();

      const currentFoldersString = JSON.stringify(chatFolders.sort());
      const newFoldersString = JSON.stringify(newFolders);

      if (newFoldersString !== currentFoldersString) {
        setChatFolders(newFolders);
      }
      setFolderListError(null);
    } catch (err) {
      console.error("Failed to list folders from Storage:", err);
      setFolderListError(errorMessageToString(err));
    } finally {
      if (wasInitiallyEmpty) setLoadingFolders(false);
      setIsRefreshingFolders(false);
      listenerFetchInProgress.current = false;
    }
  }, []);

  // --- Initial Fetch folders from Storage ---
  useEffect(() => {
    if (user) {
      fetchFoldersFromStorage(user.uid);
    }
    return () => {
      setChatFolders([]);
      setLoadingFolders(true);
      setFolderListError(null);
      setIsRefreshingFolders(false);
      listenerFetchInProgress.current = false;
    };
  }, [user, fetchFoldersFromStorage]);

  // --- Firestore Listener for REFRESH Trigger ---
  useEffect(() => {
    if (!user) return;

    const cacheCollectionRef = collection(
      db,
      `users/${user.uid}/chatFoldersCache`
    );
    const q = query(cacheCollectionRef);

    const unsubscribe = onSnapshot(
      q,
      // Use underscore prefix for unused parameter (tsc build error)
      (_querySnapshot: QuerySnapshot<DocumentData>) => {
        if (listenerFetchInProgress.current) {
          return;
        }
        listenerFetchInProgress.current = true;
        fetchFoldersFromStorage(user.uid);
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
    async (userId: string, folders: string[]) => {
      setIsGlobalSearching(true);
      setGlobalSearchError(null);
      setGlobalSearchResults([]); // Clear previous results
      const allMessages: GlobalSearchResult[] = [];

      try {
        const promises = folders.map(async (folderName) => {
          const chatFilePath = `user/${userId}/chats/${folderName}/_chat.txt`;
          const chatFileRef = ref(storage, chatFilePath);
          try {
            const fileBytes = await getBytes(chatFileRef);
            const rawContent = new TextDecoder().decode(fileBytes);
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
        // Trigger initial search if term already exists
        if (globalSearchTerm) {
          setGlobalSearchResults(searchMessages(allMessages, globalSearchTerm));
        }
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
    [globalSearchTerm]
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
      fetchAndParseAllChats(user.uid, chatFolders);
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

  // --- Username Fetch/Update Logic ---
  useEffect(() => {
    if (!user) return;

    const settingsDocRef = doc(db, `userSettings/${user.uid}`);

    // Listener for real-time updates
    const unsubscribe = onSnapshot(
      settingsDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const settingsData = docSnap.data();
          const firestoreUsername = settingsData.selectedUsername || "";
          // Update local state ONLY if it differs from Firestore
          // This prevents overwriting user input during typing before debounce fires
          setMyUsername((currentLocalUsername) => {
            if (currentLocalUsername !== firestoreUsername) {
              console.log(
                "Updating local username from Firestore:",
                firestoreUsername
              );
              return firestoreUsername;
            }
            return currentLocalUsername; // No change needed
          });
        } else {
          // Document doesn't exist, maybe set initial empty state if needed
          console.log("User settings document does not exist.");
          setMyUsername(""); // Reset if doc deleted
        }
      },
      (error) => {
        console.error("Error listening to user settings:", error);
        // Handle listener error appropriately (e.g., show a message)
      }
    );

    // Cleanup listener on unmount
    return () => unsubscribe();
  }, [user]);

  // Handle username input change with debounced Firestore write
  const handleUsernameChange = (event: ChangeEvent<HTMLInputElement>) => {
    const newUsername = event.target.value;
    setMyUsername(newUsername); // Update local state immediately

    // Clear existing debounce timeout
    if (usernameWriteTimeout.current) {
      clearTimeout(usernameWriteTimeout.current);
    }

    // Set new timeout to write to Firestore after delay (e.g., 500ms)
    usernameWriteTimeout.current = setTimeout(async () => {
      if (!user) return;
      console.log(`Debounced: Writing username "${newUsername}" to Firestore`);
      const settingsDocRef = doc(db, `userSettings/${user.uid}`);
      try {
        await setDoc(
          settingsDocRef,
          { selectedUsername: newUsername },
          { merge: true }
        );
        console.log("Username updated in Firestore.");
      } catch (error) {
        console.error("Failed to update username in Firestore:", error);
        // Optionally notify user of the error
      }
    }, 750); // 750ms debounce delay
  };

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
            // Calculate progress for the current file (optional to display granularly)
            // const fileProgress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100; // Removed unused variable
            // console.log(`Upload progress for ${file.name}: ${fileProgress}%`);

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
            // We could collect errors and show them at the end
            // For now, we'll set a general error and stop further uploads
            setUploadError(
              `Upload failed for ${file.name}: ${errorMessageToString(error)}`
            );
            setCurrentUploadFile(null); // Clear current file
            setUploading(false); // Stop overall upload process on first error
            reject(error); // Reject the promise to break the loop
          },
          () => {
            // Handle successful uploads on complete
            console.log(`${file.name} uploaded successfully.`);
            setFilesUploaded((prev) => prev + 1); // Increment completed count *after* success
            resolve(); // Resolve the promise to continue to the next file
          }
        );
      });

      // If an error occurred in the promise, stop the loop
      if (uploadError) {
        break;
      }
    }

    // After the loop finishes (or breaks due to error)
    if (!uploadError) {
      console.log("All files uploaded successfully!");
      setCurrentUploadFile(null);
      // Optionally trigger a refresh or show a success message
      // fetchLists(user.uid);
    }
    setUploading(false);
    // Reset progress slightly after completion/error
    // setTimeout(() => {
    //    setUploadProgress(0);
    //    setTotalFilesToUpload(0);
    //    setFilesUploaded(0);
    // }, 3000); // Clear after 3 seconds
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
          value={myUsername}
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
          disabled={uploading}
          accept=".zip"
          multiple
        />
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
        {uploadError && (
          <p style={{ color: "red" }}>Upload failed: {uploadError}</p>
        )}
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
function ChatViewPage({ user }: { user: User }) {
  const { chatFolderName: encodedChatFolderName, startLineParam } = useParams<{
    chatFolderName: string;
    startLineParam?: string;
  }>();
  const chatFolderName = encodedChatFolderName
    ? decodeURIComponent(encodedChatFolderName)
    : null;
  const navigate = useNavigate();
  const [parsedMessages, setParsedMessages] = useState<ParsedMessage[]>([]);
  const [myUsername, setMyUsername] = useState<string>("");
  const [parsingError, setParsingError] = useState<string | null>(null);
  const [loadingChat, setLoadingChat] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const messageListRef = useRef<HTMLDivElement>(null);

  const fetchAndParseChat = useCallback(
    async (userId: string, folderName: string) => {
      const chatFilePath = `user/${userId}/chats/${folderName}/_chat.txt`;
      const chatFileRef = ref(storage, chatFilePath);
      setParsedMessages([]);
      setParsingError(null);
      setLoadingChat(true);
      console.log(`Fetching and parsing: ${chatFilePath}`);
      try {
        const fileBytes = await getBytes(chatFileRef);
        const rawContent = new TextDecoder().decode(fileBytes);
        const parsed = parseChatTxt(rawContent);
        setParsedMessages(parsed);
      } catch (err) {
        console.error(`Failed to fetch or parse ${chatFilePath}:`, err);
        setParsingError(
          `Failed to load chat '${folderName}': ${errorMessageToString(err)}`
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
      fetchAndParseChat(user.uid, chatFolderName);
    } else {
      setLoadingChat(false);
      setParsingError("Chat folder name missing in URL.");
    }
    return () => {
      setParsedMessages([]);
      setParsingError(null);
    };
  }, [chatFolderName, user, fetchAndParseChat]);

  // --- Username Listener ---
  useEffect(() => {
    if (!user) return;

    const settingsDocRef = doc(db, `userSettings/${user.uid}`);
    const unsubscribe = onSnapshot(
      settingsDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          setMyUsername(docSnap.data().selectedUsername || "");
        } else {
          setMyUsername(""); // Reset if settings doc doesn't exist
        }
      },
      (error) => {
        console.error(
          "Error listening to user settings in ChatViewPage:",
          error
        );
        setMyUsername(""); // Reset on error maybe?
      }
    );

    // Cleanup listener
    return () => unsubscribe();
  }, [user]); // Depend only on user

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
        setAuthError(errorMessageToString(error));
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
      setAuthError(errorMessageToString(err));
    }
  };

  const handleLogout = async () => {
    setAuthError(null);
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Logout failed:", err);
      setAuthError(errorMessageToString(err));
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
            <Route
              path="/chats/:chatFolderName/messages/:startLineParam"
              element={<ChatViewPage user={user} />}
            />
            <Route path="*" element={<div>Page Not Found</div>} />
          </Routes>
        ) : (
          <div>
            <p>Please log in to view and upload your chat history.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
