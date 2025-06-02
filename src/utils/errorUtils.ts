/**
 * Converts any error type to a user-friendly string message
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Handle specific Firebase error codes if needed
    if ('code' in error && typeof error.code === 'string') {
      if (error.code.includes('storage/object-not-found')) {
        return 'File not found.';
      }
      if (error.code.includes('storage/unauthorized')) {
        return 'Permission denied.';
      }
      // Add more specific error codes as needed
    }
    return error.message;
  }
  return String(error);
}