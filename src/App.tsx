import { useState, useEffect, ChangeEvent } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  User,
} from "firebase/auth";
import { ref, uploadBytes, listAll, StorageReference } from "firebase/storage";
import { auth, storage } from "./firebaseConfig"; // Make sure this path is correct
import "./App.css";

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [extractedFiles, setExtractedFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Listen for auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe(); // Cleanup subscription on unmount
  }, []);

  // Fetch files when user logs in
  useEffect(() => {
    if (user) {
      fetchUserFiles(user.uid);
      fetchExtractedFiles(user.uid);
    } else {
      setFiles([]);
      setExtractedFiles([]);
    }
  }, [user]); // Re-run when user state changes

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
      <h1>Firebase File Manager</h1>
      {error && <p style={{ color: "red" }}>Error: {error}</p>}
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
