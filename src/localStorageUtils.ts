import JSZip from 'jszip';

export interface LocalUser {
  uid: string;
  displayName: string;
  email: string;
  isLocal: true;
}

export interface ChatFolder {
  name: string;
  extractedContent: string; // Store extracted chat content as string
  attachments: { [fileName: string]: string }; // Store attachments as base64 strings
}

export interface LocalUserData {
  username: string;
  chatFolders: { [folderName: string]: ChatFolder };
}

const LOCAL_STORAGE_KEY = 'whatsapp_local_user_data';
const LOCAL_USER_KEY = 'whatsapp_local_user';

export class LocalStorageManager {
  private static instance: LocalStorageManager;
  
  private constructor() {}
  
  static getInstance(): LocalStorageManager {
    if (!LocalStorageManager.instance) {
      LocalStorageManager.instance = new LocalStorageManager();
    }
    return LocalStorageManager.instance;
  }

  createLocalUser(displayName: string): LocalUser {
    const localUser: LocalUser = {
      uid: 'local-user-' + Date.now(),
      displayName,
      email: 'local@user.local',
      isLocal: true
    };
    localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(localUser));
    this.initializeUserData();
    return localUser;
  }

  getLocalUser(): LocalUser | null {
    const userData = localStorage.getItem(LOCAL_USER_KEY);
    return userData ? JSON.parse(userData) : null;
  }

  clearLocalUser(): void {
    localStorage.removeItem(LOCAL_USER_KEY);
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }

  private initializeUserData(): void {
    if (!localStorage.getItem(LOCAL_STORAGE_KEY)) {
      const initialData: LocalUserData = {
        username: '',
        chatFolders: {}
      };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(initialData));
    }
  }

  private getUserData(): LocalUserData {
    const data = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!data) {
      this.initializeUserData();
      return this.getUserData();
    }
    const userData = JSON.parse(data);
    
    // Ensure attachments field exists for all folders (backward compatibility)
    Object.values(userData.chatFolders).forEach((folder: any) => {
      if (!folder.attachments) {
        folder.attachments = {};
      }
    });
    
    return userData;
  }

  private saveUserData(data: LocalUserData): void {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
  }

  setUsername(username: string): void {
    const userData = this.getUserData();
    userData.username = username;
    this.saveUserData(userData);
  }

  getUsername(): string {
    return this.getUserData().username;
  }

  getChatFolderNames(): string[] {
    const userData = this.getUserData();
    return Object.keys(userData.chatFolders).sort();
  }

  async uploadChatFiles(files: FileList): Promise<void> {
    const userData = this.getUserData();
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.name.endsWith('.zip')) {
        const folderName = file.name.replace('.zip', '');
        const arrayBuffer = await file.arrayBuffer();
        
        try {
          // Extract the chat content and attachments
          const { chatContent, attachments } = await this.extractChatAndAttachmentsFromZip(arrayBuffer);
          
          // Store extracted content and attachments
          userData.chatFolders[folderName] = {
            name: folderName,
            extractedContent: chatContent,
            attachments: attachments
          };
          
        } catch (error) {
          console.error(`Failed to process zip file ${file.name}:`, error);
          throw new Error(`Failed to process ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }
    
    this.saveUserData(userData);
  }

  async getChatFileContent(folderName: string, fileName: string = '_chat.txt'): Promise<string> {
    const userData = this.getUserData();
    const folder = userData.chatFolders[folderName];
    
    console.log(`[LocalStorage] Getting content for folder: ${folderName}, file: ${fileName}`);
    console.log(`[LocalStorage] Available folders:`, Object.keys(userData.chatFolders));
    
    if (!folder) {
      throw new Error(`Chat folder '${folderName}' not found`);
    }

    console.log(`[LocalStorage] Folder found, has extractedContent:`, !!folder.extractedContent);
    console.log(`[LocalStorage] ExtractedContent length:`, folder.extractedContent?.length || 0);

    // We only support _chat.txt for local storage now
    if (fileName === '_chat.txt') {
      if (folder.extractedContent) {
        console.log(`[LocalStorage] Returning content (first 100 chars):`, folder.extractedContent.substring(0, 100));
        return folder.extractedContent;
      }
      throw new Error(`No chat content found for folder '${folderName}'`);
    }

    throw new Error(`File '${fileName}' not supported in local storage mode`);
  }

  private async extractChatAndAttachmentsFromZip(zipBuffer: ArrayBuffer): Promise<{ chatContent: string; attachments: { [fileName: string]: string } }> {
    try {
      const zip = await JSZip.loadAsync(zipBuffer);
      const fileNames = Object.keys(zip.files);
      
      // Find chat file
      let chatContent = '';
      const chatFile = zip.file('_chat.txt') || zip.files[fileNames.find(name => name.endsWith('_chat.txt')) || ''];
      
      if (chatFile && !chatFile.dir) {
        chatContent = await chatFile.async('text');
      } else {
        // Fallback: look for any .txt file
        const txtFiles = fileNames.filter(name => name.endsWith('.txt') && !zip.files[name].dir);
        if (txtFiles.length > 0) {
          const file = zip.file(txtFiles[0]);
          if (file) {
            chatContent = await file.async('text');
          }
        }
      }
      
      if (!chatContent) {
        throw new Error('No chat file found in the zip archive. Expected _chat.txt or similar.');
      }
      
      // Extract attachment files (images, videos, audio, etc.)
      const attachments: { [fileName: string]: string } = {};
      const attachmentExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'avi', 'mp3', 'aac', 'wav', 'pdf', 'doc', 'docx'];
      
      for (const fileName of fileNames) {
        const file = zip.files[fileName];
        if (!file.dir && fileName !== '_chat.txt') {
          const extension = fileName.split('.').pop()?.toLowerCase();
          if (extension && attachmentExtensions.includes(extension)) {
            try {
              // Convert to base64 for storage
              const arrayBuffer = await file.async('arraybuffer');
              const base64 = this.arrayBufferToBase64(arrayBuffer);
              const baseName = fileName.split('/').pop() || fileName; // Get just the filename without path
              attachments[baseName] = base64;
              console.log(`[LocalStorage] Extracted attachment: ${baseName} (${base64.length} chars)`);
            } catch (error) {
              console.warn(`[LocalStorage] Failed to extract attachment ${fileName}:`, error);
            }
          }
        }
      }
      
      console.log(`[LocalStorage] Extracted ${Object.keys(attachments).length} attachments`);
      return { chatContent, attachments };
      
    } catch (error) {
      console.error('Error extracting chat and attachments from zip:', error);
      throw new Error(`Failed to extract from zip: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  deleteChatFolder(folderName: string): void {
    const userData = this.getUserData();
    delete userData.chatFolders[folderName];
    this.saveUserData(userData);
  }

  getAttachmentBlob(folderName: string, fileName: string): Blob | null {
    const userData = this.getUserData();
    const folder = userData.chatFolders[folderName];
    
    if (!folder || !folder.attachments || !folder.attachments[fileName]) {
      return null;
    }
    
    try {
      const base64 = folder.attachments[fileName];
      const arrayBuffer = this.base64ToArrayBuffer(base64);
      
      // Determine MIME type based on file extension
      const extension = fileName.split('.').pop()?.toLowerCase();
      const mimeType = this.getMimeType(extension || '');
      
      return new Blob([arrayBuffer], { type: mimeType });
    } catch (error) {
      console.error(`Failed to create blob for ${fileName}:`, error);
      return null;
    }
  }

  createAttachmentURL(folderName: string, fileName: string): string | null {
    const blob = this.getAttachmentBlob(folderName, fileName);
    if (!blob) {
      return null;
    }
    
    return URL.createObjectURL(blob);
  }

  private getMimeType(extension: string): string {
    const mimeTypes: { [key: string]: string } = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'mp3': 'audio/mpeg',
      'aac': 'audio/aac',
      'wav': 'audio/wav',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    
    return mimeTypes[extension] || 'application/octet-stream';
  }

  // Get storage usage info
  getStorageInfo(): { folderCount: number; estimatedSizeKB: number; attachmentCount: number } {
    const userData = this.getUserData();
    const folderCount = Object.keys(userData.chatFolders).length;
    const dataStr = localStorage.getItem(LOCAL_STORAGE_KEY) || '{}';
    const estimatedSizeKB = Math.round((dataStr.length * 2) / 1024); // Rough estimate
    
    let attachmentCount = 0;
    Object.values(userData.chatFolders).forEach(folder => {
      if (folder.attachments) {
        attachmentCount += Object.keys(folder.attachments).length;
      }
    });
    
    return { folderCount, estimatedSizeKB, attachmentCount };
  }
}