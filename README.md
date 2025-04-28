# Firebase Project Setup (for New Contributors / New Projects)

A webapp where you can upload your exported whatsapp conversations and view them in a comfortable way.

## Screenshots

<img width="850" alt="image" src="https://github.com/user-attachments/assets/8d9890bf-158e-4b55-a0a9-b48b1cea9f4b" />

## Security

This project was almost entirely vibe coded, I wouldn't trust the security with private chats.

## Dev

This guide explains how to set up a new Firebase project to run this application.

**1. Prerequisites:**

- **Node.js & npm:** Install from [nodejs.org](https://nodejs.org/).
- **Firebase CLI:** Install globally: `npm install -g firebase-tools`
- **Google Cloud SDK (gcloud):** Install from [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install).

**2. Create Firebase Project:**

- Go to the [Firebase Console](https://console.firebase.google.com/).
- Click "Add project" and follow the steps to create a new project.
- Choose a unique Project ID (e.g., `my-whatsapp-history-app`). You'll need this ID later.
- Enable Google Analytics if desired (not strictly required for this app's core features).

**3. Connect Local Project:**

- Log in to Firebase: `firebase login`
- Log in to Google Cloud: `gcloud auth login`
- In your local project directory (`whatsapp_history3`), connect to your Firebase project (replace `YOUR_PROJECT_ID` with the ID you created):
  ```bash
  firebase use --add YOUR_PROJECT_ID
  gcloud config set project YOUR_PROJECT_ID
  ```

**4. Enable Google Cloud APIs:**

- Go to the [Google Cloud Console API Library](https://console.cloud.google.com/apis/library) for your project.
- Search for and **Enable** the following APIs:
  - Cloud Firestore API (`firestore.googleapis.com`) _(Even if not used yet, good practice)_
  - Cloud Storage (`storage.googleapis.com`)
  - Cloud Functions API (`cloudfunctions.googleapis.com`)
  - Cloud Build API (`cloudbuild.googleapis.com`)
  - Artifact Registry API (`artifactregistry.googleapis.com`)
  - Cloud Run Admin API (`run.googleapis.com`)
  - Eventarc API (`eventarc.googleapis.com`)
  - Pub/Sub API (`pubsub.googleapis.com`)

**5. Set IAM Permissions:**

- Cloud Functions (especially 2nd gen) require specific permissions for their service accounts to interact with other services. Run the following `gcloud` commands in your terminal (replace `YOUR_PROJECT_ID` and ensure your logged-in `gcloud` user has sufficient project permissions, like Project Owner, to grant these roles):

  ```bash
  # Get your Google Cloud project number
  PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')

  # Grant Cloud Storage agent permission to publish Pub/Sub topics
  gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
      --member="serviceAccount:service-${PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com" \
      --role="roles/pubsub.publisher"

  # Grant Pub/Sub agent permission to create tokens for authenticated push
  gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
      --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
      --role="roles/iam.serviceAccountTokenCreator"

  # Grant Compute Engine default service account permission to be invoked by Cloud Run/Eventarc
  gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
      --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
      --role="roles/run.invoker"

  # Grant Compute Engine default service account permission to receive Eventarc events
  gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
      --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
      --role="roles/eventarc.eventReceiver"
  ```

**6. Install Dependencies:**

- Install frontend dependencies:
  ```bash
  npm install
  ```
- Install Cloud Functions dependencies (inside the `functions` directory):
  ```bash
  cd functions
  python3 -m venv venv # Or use your preferred Python version
  source venv/bin/activate # Or .env\Scripts\activate on Windows
  pip install -r requirements.txt
  deactivate
  cd ..
  ```

**7. Run Locally (Frontend):**

- Start the Vite development server:
  ```bash
  npm run dev
  ```
- Open your browser to the URL provided (usually `http://localhost:5173`).

**8. Deploy to Firebase:**

- Deploy all configured Firebase features (Hosting, Storage Rules, Functions):
  ```bash
  firebase deploy
  ```

Now your Firebase project should be fully configured and the application deployed.
