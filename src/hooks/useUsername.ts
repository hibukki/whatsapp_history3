import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { AppUser, isLocalUser } from '../userTypes';
import { LocalStorageManager } from '../localStorageUtils';

export function useUsername(user: AppUser | null): string {
  const [username, setUsername] = useState<string>('');

  useEffect(() => {
    if (!user) {
      setUsername('');
      return;
    }

    if (isLocalUser(user)) {
      // For local users, get username from local storage
      const localStorageManager = LocalStorageManager.getInstance();
      const localUsername = localStorageManager.getUsername();
      setUsername(localUsername);
      return;
    }

    // For Firebase users, use Firestore listener
    const settingsDocRef = doc(db, `userSettings/${user.uid}`);
    const unsubscribe = onSnapshot(
      settingsDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          setUsername(docSnap.data().selectedUsername || '');
        } else {
          setUsername(''); // Reset if settings doc doesn't exist
        }
      },
      (error) => {
        console.error('Error listening to user settings:', error);
        setUsername(''); // Reset on error
      }
    );

    return () => unsubscribe();
  }, [user]);

  return username;
}