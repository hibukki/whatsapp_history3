import React, { useState, useEffect } from "react";
import { ref, getDownloadURL } from "firebase/storage";
import { storage } from "../firebaseConfig"; // Adjust path as needed

interface AttachmentPreviewProps {
  attachmentName: string | null;
  userId: string; // Need user ID
  chatFolderName: string; // Need folder name
  // Consider passing getDownloadURL function or using context if preferred
}

// Helper to check if filename is an image (could be moved to utils)
const isImageFile = (filename: string | null): boolean => {
  if (!filename) return false;
  const extension = filename.split(".").pop()?.toLowerCase();
  return (
    !!extension && ["jpg", "jpeg", "png", "gif", "webp"].includes(extension)
  );
};

export const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({
  attachmentName,
  userId,
  chatFolderName,
}) => {
  const [url, setUrl] = useState<string | null | undefined>(undefined); // undefined = not yet fetched
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true; // Prevent state update on unmounted component
    if (!attachmentName || !userId || !chatFolderName) {
      setUrl(null); // Nothing to fetch
      return;
    }

    const storagePath = `user/${userId}/chats/${chatFolderName}/${attachmentName}`;
    setUrl(undefined); // Reset on new attachment name
    setIsLoading(true);
    setError(null);
    console.log(`AttachmentPreview: Fetching ${storagePath}`);

    const fetchUrl = async () => {
      try {
        const attachmentRef = ref(storage, storagePath);
        const downloadUrl = await getDownloadURL(attachmentRef);
        if (isMounted) {
          setUrl(downloadUrl);
        }
      } catch (err) {
        console.error(`Failed to get download URL for ${storagePath}:`, err);
        if (isMounted) {
          setError(getErrorMessage(err)); // Using global getErrorMessage for now
          setUrl(null); // Indicate error
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    fetchUrl();

    return () => {
      isMounted = false;
    }; // Cleanup function
  }, [attachmentName, userId, chatFolderName]);

  if (!attachmentName) return null;

  if (url === undefined || isLoading) {
    return (
      <p className="attachment-loading">
        📎 Loading attachment: {attachmentName}...
      </p>
    );
  }

  if (url === null) {
    // Error fetching URL
    return (
      <p className="attachment-error">
        📎 Error loading attachment: {error || attachmentName}
      </p>
    );
  }

  if (isImageFile(attachmentName)) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={`View ${attachmentName}`}
      >
        <img
          src={url}
          alt={attachmentName}
          className="attachment-image-preview"
        />
      </a>
    );
  } else {
    // Link for non-image files
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="attachment-link"
      >
        📎 Download: {attachmentName}
      </a>
    );
  }
};

// Simple error helper (consider moving to utils)
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    // Customize Firebase storage error messages if needed
    if ("code" in error && typeof error.code === "string") {
      if (error.code.includes("storage/object-not-found")) {
        return "File not found.";
      }
      // Add more specific error codes here
    }
    return error.message;
  }
  return String(error);
};
