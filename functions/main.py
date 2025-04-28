# Welcome to Cloud Functions for Firebase for Python!
# To get started, simply uncomment the below code or create your own.
# Deploy with `firebase deploy`

# --- Removed generic functions_framework ---
# import functions_framework
import firebase_admin
# --- Added firebase_functions and storage_fn ---
from firebase_functions import storage_fn #, options
from firebase_admin import storage, firestore
# --- Added google.cloud.firestore Client import --- 
from google.cloud.firestore import Client as FirestoreClient 
import os
import zipfile
import tempfile
import logging

# options.set_global_options(region=options.SupportedRegion.EUROPE_WEST1) # Example: Set region if needed

# Initialize Firebase Admin SDK only once
try:
    firebase_admin.initialize_app()
except ValueError:
    pass # App already initialized

# --- Replaced decorator with Firebase Storage trigger ---
# @functions_framework.cloud_event
@storage_fn.on_object_finalized()
def extract_zip(event: storage_fn.CloudEvent[storage_fn.StorageObjectData]):
    """This function is triggered when a file is finalized in the Cloud Storage bucket.
    It checks if the file is a zip file in the 'user/[uid]/uploads/' directory and extracts its contents
    to the 'user/[uid]/extracted/' directory.
    """
    # --- Access event data using the specific event type ---
    # data = cloud_event.data
    bucket_name = event.data.bucket
    file_path = event.data.name
    content_type = event.data.content_type or "" # Access content type directly

    logging.info(f"Processing file: gs://{bucket_name}/{file_path}")

    # Ensure the file is in the user's uploads/ directory and is a zip file
    # Check for 'user/' prefix and '/uploads/' segment
    parts = file_path.split("/")
    if not file_path.startswith("user/") or len(parts) < 4 or parts[2] != "uploads" or not file_path.lower().endswith(".zip"):
        logging.info(f"Skipping file {file_path}: Not a zip file in user/[uid]/uploads/.")
        return

    # Extract the user ID and filename from the path
    # parts = file_path.split("/") # Already split above
    # if len(parts) < 4: # Need at least user/{uid}/uploads/file.zip
    #    logging.warning(f"Skipping file {file_path}: Unexpected path structure.")
    #    return
    user_id = parts[1] # Path is user/{user_id}/uploads/{filename}.zip
    zip_filename = parts[-1]
    # --- Get zip filename without extension for subfolder ---
    zip_name_base = os.path.splitext(zip_filename)[0]

    # Prevent infinite loops by ignoring files processed into the extracted directory
    # or the chats directory
    if parts[2] == "extracted" or parts[2] == "chats":
        logging.info(f"Skipping file {file_path}: File is in an intermediate or final directory.")
        return

    storage_client = storage.bucket(bucket_name)
    source_blob = storage_client.blob(file_path)

    # Create a temporary directory for extraction
    with tempfile.TemporaryDirectory() as temp_dir:
        local_zip_path = os.path.join(temp_dir, zip_filename)

        # Download the zip file
        try:
            logging.info(f"Downloading {file_path} to {local_zip_path}")
            source_blob.download_to_filename(local_zip_path)
            logging.info(f"Downloaded {file_path} successfully.")
        except Exception as e:
            logging.error(f"Failed to download {file_path}: {e}")
            return # Stop processing if download fails

        # Extract the zip file
        try:
            logging.info(f"Extracting {local_zip_path} into {temp_dir}")
            with zipfile.ZipFile(local_zip_path, "r") as zip_ref:
                zip_ref.extractall(temp_dir)
            logging.info(f"Extracted {local_zip_path} successfully.")
        except zipfile.BadZipFile:
            logging.error(f"Failed to extract {local_zip_path}: Not a valid zip file or corrupted.")
            # Optionally, move the bad zip file elsewhere or delete it
            # source_blob.copy(storage_client.blob(f"bad_zips/{user_id}/{zip_filename}"))
            # source_blob.delete()
            return
        except Exception as e:
            logging.error(f"Failed to extract {local_zip_path}: {e}")
            return

        # Upload extracted files
        logging.info(f"Uploading extracted files to user/{user_id}/extracted/{zip_name_base}/")
        upload_count = 0
        for root, _, files in os.walk(temp_dir):
            for filename in files:
                if filename == zip_filename: # Don't re-upload the original zip
                    continue

                local_file_path = os.path.join(root, filename)
                # Create relative path for storage to maintain directory structure within the zip
                relative_path = os.path.relpath(local_file_path, temp_dir)
                # --- Adjusted destination path with zip name subfolder ---
                destination_blob_name = f"user/{user_id}/extracted/{zip_name_base}/{relative_path}"

                destination_blob = storage_client.blob(destination_blob_name)
                try:
                    destination_blob.upload_from_filename(local_file_path)
                    # logging.info(f"Uploaded {local_file_path} to {destination_blob_name}") # Too verbose
                    upload_count += 1
                except Exception as e:
                    logging.error(f"Failed to upload {local_file_path} to {destination_blob_name}: {e}")

        logging.info(f"Finished extracting {file_path}. Uploaded {upload_count} files to user/{user_id}/extracted/{zip_name_base}/")

        # --- Check for _chat.txt and copy if exists ---
        extracted_chat_file_path = f"user/{user_id}/extracted/{zip_name_base}/_chat.txt"
        chat_file_blob = storage_client.blob(extracted_chat_file_path)

        if chat_file_blob.exists():
            logging.info(f"Found _chat.txt. Copying contents to chats/{zip_name_base}/")
            copy_count = 0
            source_prefix = f"user/{user_id}/extracted/{zip_name_base}/"
            destination_prefix = f"user/{user_id}/chats/{zip_name_base}/"

            # Copy blobs - Allow exceptions to propagate
            blobs_to_copy = list(storage_client.list_blobs(prefix=source_prefix))
            if not blobs_to_copy:
                logging.warning(f"_chat.txt exists but no blobs found under prefix {source_prefix}.")
            else:
                for blob in blobs_to_copy:
                    # Calculate destination path
                    relative_blob_path = blob.name[len(source_prefix):] # Get path relative to source prefix
                    destination_blob_path = f"{destination_prefix}{relative_blob_path}"
                    destination_blob = storage_client.blob(destination_blob_path)

                    # Perform the copy
                    # Rewrite preserves metadata like content type
                    token, bytes_rewritten, total_bytes = destination_blob.rewrite(blob)
                    while token is not None:
                         # Handle large files that require multiple rewrite calls (though unlikely for chat files)
                        token, bytes_rewritten, total_bytes = destination_blob.rewrite(blob, token=token)

                    # logging.info(f"Copied {blob.name} to {destination_blob_path}") # Too verbose
                    copy_count += 1

                logging.info(f"Finished copying {copy_count} files to {destination_prefix}")

                # --- Write to Firestore cache AFTER successful copy ---
                logging.info(f"Updating Firestore cache for user {user_id}, folder {zip_name_base}")
                db = FirestoreClient(database='whatsapp-history3-firestore')
                doc_ref = db.collection('users').document(user_id).collection('chatFoldersCache').document(zip_name_base)
                doc_ref.set({'updated_at': firestore.SERVER_TIMESTAMP})
                logging.info(f"Firestore cache updated successfully for {zip_name_base}.")
        else:
            logging.info(f"Did not find {extracted_chat_file_path}. No copy to chats/ performed.")

    # Optionally delete the original zip file after successful extraction
    # logging.info(f"Deleting original zip file: {file_path}")
    # try:
    #     source_blob.delete()
    #     logging.info(f"Deleted {file_path}.")
    # except Exception as e:
    #     logging.error(f"Failed to delete {file_path}: {e}")

    return # Explicitly return None or a success message

# Removed old example code
# initialize_app()
#
#
# @https_fn.on_request()
# def on_request_example(req: https_fn.Request) -> https_fn.Response:
#     return https_fn.Response("Hello world!")