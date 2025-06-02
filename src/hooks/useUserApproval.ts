import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { AppUser, isLocalUser } from '../userTypes';

export function useUserApproval(user: AppUser | null): boolean {
  const [isUserApproved, setIsUserApproved] = useState<boolean>(false);

  useEffect(() => {
    if (!user) {
      setIsUserApproved(false);
      return;
    }

    if (isLocalUser(user)) {
      // Local users are always approved
      setIsUserApproved(true);
      return;
    }

    // For Firebase users, check approval status in Firestore
    console.log("Looking for approval status for uid=", user.uid);
    const settingsDocRef = doc(db, `userSettings/${user.uid}`);
    const unsubscribe = onSnapshot(
      settingsDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const settingsData = docSnap.data();
          const firestoreApproval = settingsData.isApproved === true; // Check for explicit true
          console.log("Got user approval status", firestoreApproval);
          setIsUserApproved(firestoreApproval);
        } else {
          // Reset if settings doc doesn't exist
          console.log("User settings not found - not approved");
          setIsUserApproved(false);
        }
      },
      (error) => {
        console.error("Error listening to user approval status:", error);
        setIsUserApproved(false);
      }
    );
    return () => unsubscribe();
  }, [user]);

  return isUserApproved;
}