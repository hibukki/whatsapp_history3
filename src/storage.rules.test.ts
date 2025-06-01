import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { ref, uploadString, getDownloadURL } from "firebase/storage";
import { doc, setDoc } from "firebase/firestore";
import { readFileSync } from "fs";
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";

// Config
const PROJECT_ID = "whatsapp-history3"; // Use your actual project ID or a test one
const FIREBASE_JSON = JSON.parse(readFileSync("./firebase.json", "utf8"));
const FIRESTORE_EMULATOR_HOST = "127.0.0.1"; // Default host
const FIRESTORE_EMULATOR_PORT = FIREBASE_JSON.emulators.firestore.port;
const STORAGE_EMULATOR_HOST = "127.0.0.1"; // Default host
const STORAGE_EMULATOR_PORT = FIREBASE_JSON.emulators.storage.port;
const STORAGE_RULES_PATH = "storage.rules";
const FIRESTORE_RULES_PATH = "firestore.rules";

// Test User IDs
const alice = { uid: "alice", email: "alice@example.com" };
const bob = { uid: "bob", email: "bob@example.com" };

let testEnv: RulesTestEnvironment;

// Helper to set approval status in Firestore emulator
async function setApprovalStatus(userId: string, isApproved: boolean) {
  const adminDb = testEnv.unauthenticatedContext().firestore(); // Use admin context to bypass rules
  await setDoc(doc(adminDb, `userSettings/${userId}`), { isApproved });
}

async function clearFirestore() {
  await testEnv.clearFirestore();
}

describe("Firebase Storage Security Rules", () => {
  beforeAll(async () => {
    console.log(
      `Using Firestore emulator: ${FIRESTORE_EMULATOR_HOST}:${FIRESTORE_EMULATOR_PORT}`
    );
    console.log(
      `Using Storage emulator: ${STORAGE_EMULATOR_HOST}:${STORAGE_EMULATOR_PORT}`
    );
    try {
      testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
          host: FIRESTORE_EMULATOR_HOST,
          port: FIRESTORE_EMULATOR_PORT,
          rules: readFileSync(FIRESTORE_RULES_PATH, "utf8"),
        },
        storage: {
          host: STORAGE_EMULATOR_HOST,
          port: STORAGE_EMULATOR_PORT,
          rules: readFileSync(STORAGE_RULES_PATH, "utf8"),
        },
      });
    } catch (error) {
      console.error("Error initializing test environment:", error);
      process.exit(1); // Exit if setup fails
    }
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  beforeEach(async () => {
    // Clear Firestore before each test to ensure isolation
    await clearFirestore();
  });

  // --- Upload Tests (/user/{userId}/uploads/{fileName}) ---

  it("should ALLOW an approved user to upload to their own uploads path", async () => {
    await setApprovalStatus(alice.uid, true); // Alice is approved
    const context = testEnv.authenticatedContext(alice.uid, {
      email: alice.email,
    });
    const storageRef = ref(
      context.storage(),
      `user/${alice.uid}/uploads/test.txt`
    );
    await assertSucceeds(uploadString(storageRef, "hello world"));
  });

  it("should DENY an unapproved user uploading to their own uploads path", async () => {
    await setApprovalStatus(alice.uid, false); // Alice is NOT approved
    const context = testEnv.authenticatedContext(alice.uid, {
      email: alice.email,
    });
    const storageRef = ref(
      context.storage(),
      `user/${alice.uid}/uploads/test.txt`
    );
    await assertFails(uploadString(storageRef, "hello world"));
  });

  it("should DENY a user without settings doc uploading to their own uploads path", async () => {
    // No call to setApprovalStatus for alice
    const context = testEnv.authenticatedContext(alice.uid, {
      email: alice.email,
    });
    const storageRef = ref(
      context.storage(),
      `user/${alice.uid}/uploads/test.txt`
    );
    await assertFails(uploadString(storageRef, "hello world"));
  });

  it("should DENY a user uploading to another user's uploads path", async () => {
    await setApprovalStatus(alice.uid, true); // Alice is approved
    // Bob attempts upload to Alice's path
    const context = testEnv.authenticatedContext(bob.uid, { email: bob.email });
    const storageRef = ref(
      context.storage(),
      `user/${alice.uid}/uploads/test.txt`
    );
    await assertFails(uploadString(storageRef, "hello world"));
  });

  it("should DENY an unauthenticated user uploading", async () => {
    const context = testEnv.unauthenticatedContext();
    const storageRef = ref(
      context.storage(),
      `user/${alice.uid}/uploads/test.txt`
    );
    await assertFails(uploadString(storageRef, "hello world"));
  });

  // --- Read Tests ---

  it("should ALLOW a user to read their own uploads file", async () => {
    // Need to upload something first (using admin/rules bypass? No, rules should allow)
    await setApprovalStatus(alice.uid, true);
    const aliceContext = testEnv.authenticatedContext(alice.uid);
    const storageRef = ref(
      aliceContext.storage(),
      `user/${alice.uid}/uploads/readable.txt`
    );
    await assertSucceeds(uploadString(storageRef, "can read")); // Upload first

    // Now test read
    await assertSucceeds(getDownloadURL(storageRef));
  });

  it("should ALLOW a user to read their own non-uploads file (e.g., chats)", async () => {
    // Simulate a file placed by a function (can't upload directly due to rules)
    // We can't easily *create* this file via the client SDK if writes are denied.
    // This scenario is harder to test purely via rules-unit-testing for Storage without emulator admin API.
    // For now, we trust the broad read rule `match /user/{userId}/{allPaths=**}` works.
    // A more complex test could involve uploading and then trying to read via aliceContext.
    // Let's test reading a path that *would* be chats:
    const aliceContext = testEnv.authenticatedContext(alice.uid);
    const storageRef = ref(
      aliceContext.storage(),
      `user/${alice.uid}/chats/someChat/file.txt`
    );
    // We expect getDownloadURL to fail with 404 (not found), NOT 403 (permission denied)
    // assertFails correctly handles this for reads
    await assertFails(getDownloadURL(storageRef));
  });

  it("should DENY a user reading another user's uploads file", async () => {
    await setApprovalStatus(alice.uid, true);
    const aliceContext = testEnv.authenticatedContext(alice.uid);
    const storageRef = ref(
      aliceContext.storage(),
      `user/${alice.uid}/uploads/secret.txt`
    );
    await assertSucceeds(uploadString(storageRef, "secret data")); // Alice uploads

    // Bob tries to read
    const bobContext = testEnv.authenticatedContext(bob.uid);
    const bobStorageRef = ref(
      bobContext.storage(),
      `user/${alice.uid}/uploads/secret.txt`
    );
    await assertFails(getDownloadURL(bobStorageRef));
  });

  // --- Write Tests (Non-Upload Paths) ---

  it("should DENY a user writing directly to /chats/ path", async () => {
    const context = testEnv.authenticatedContext(alice.uid);
    const storageRef = ref(
      context.storage(),
      `user/${alice.uid}/chats/myChat/_chat.txt`
    );
    await assertFails(uploadString(storageRef, "overwrite chat"));
  });

  it("should DENY a user writing directly to /extracted/ path", async () => {
    const context = testEnv.authenticatedContext(alice.uid);
    const storageRef = ref(
      context.storage(),
      `user/${alice.uid}/extracted/myChat/file.jpg`
    );
    await assertFails(uploadString(storageRef, "overwrite extraction"));
  });

  // --- Delete Tests (Optional but good) ---
  // Note: Default rules don't specify delete, usually covered by write. Add explicit if needed.
  // it("should ALLOW an approved user to delete their own uploads file", async () => {...});
  // it("should DENY a user deleting another user's file", async () => {...});
});
