import { useState, useRef, useEffect, ChangeEvent } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { AppUser, isLocalUser } from '../userTypes';
import { LocalStorageManager } from '../localStorageUtils';

export function useUsernameInput(user: AppUser | null, currentUsername: string) {
  const [inputValue, setInputValue] = useState<string>(currentUsername);
  const usernameWriteTimeout = useRef<NodeJS.Timeout | null>(null);

  // Sync input value with current username when it changes
  useEffect(() => {
    setInputValue(currentUsername);
  }, [currentUsername]);

  const handleUsernameChange = (event: ChangeEvent<HTMLInputElement>) => {
    const newUsername = event.target.value;
    setInputValue(newUsername); // Update local state immediately

    // Clear existing debounce timeout
    if (usernameWriteTimeout.current) {
      clearTimeout(usernameWriteTimeout.current);
    }

    // Set new timeout to write after delay
    usernameWriteTimeout.current = setTimeout(async () => {
      if (!user) return;
      
      if (isLocalUser(user)) {
        // For local users, save to local storage
        const localStorageManager = LocalStorageManager.getInstance();
        localStorageManager.setUsername(newUsername);
        console.log(`Username "${newUsername}" saved to local storage.`);
      } else {
        // For Firebase users, save to Firestore
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
        }
      }
    }, 750); // 750ms debounce delay
  };

  return {
    inputValue,
    handleUsernameChange
  };
}