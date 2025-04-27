import { useState, useEffect, ChangeEvent } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  User,
} from "firebase/auth";
import { ref, uploadBytes, listAll } from "firebase/storage";
import { auth, storage } from "./firebaseConfig"; // Make sure this path is correct
import "./App.css";

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [files, setFiles] = useState<string[]>([]);
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
    } else {
      setFiles([]); // Clear files when logged out
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
      // Potentially fetch download URLs if needed, for now just list names
      const fileNames = res.items.map((itemRef) => itemRef.name);
      setFiles(fileNames);
      setError(null); // Clear previous errors
    } catch (err) {
      console.error("Failed to list files:", err);
      setError(getErrorMessage(err));
      setFiles([]); // Clear files on error
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
            />
            {uploading && <p>Uploading...</p>}
          </div>

          <div className="file-section">
            <h2>Your Files</h2>
            {files.length > 0 ? (
              <ul>
                {files.map((fileName) => (
                  <li key={fileName}>{fileName}</li>
                  // Optional: Add download link if you fetch URLs
                  // <li key={fileName}><a href={/* downloadURL */} target="_blank" rel="noopener noreferrer">{fileName}</a></li>
                ))}
              </ul>
            ) : (
              <p>No files uploaded yet.</p>
            )}
            <button onClick={() => fetchUserFiles(user.uid)}>
              Refresh Files
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
