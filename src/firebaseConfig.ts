import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";
import { getFirestore } from "firebase/firestore";

// TODO: Replace with your actual Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyAMlyvXJQU3wQyDSqoSNbhwfbmzmFPEBQI",
  authDomain: "whatsapp-history3.firebaseapp.com",
  projectId: "whatsapp-history3",
  storageBucket: "gs://whatsapp-history3.firebasestorage.app",
  messagingSenderId: "126624187925",
  appId: "1:126624187925:web:6ced0f088627b350ecf01c",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Get Firebase services
const auth = getAuth(app);
const storage = getStorage(app);
const db = getFirestore(app, "whatsapp-history3-firestore");

export { app, auth, storage, db };
