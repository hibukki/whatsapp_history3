import React from "react";
import { ParsedMessage } from "../chatParser";
import { AttachmentPreview } from "./AttachmentPreview"; // Assuming AttachmentPreview is also extracted
import { AppUser } from "../userTypes";

interface MessageItemProps {
  message: ParsedMessage;
  myUsername: string;
  userId: string; // Added userId
  chatFolderName: string; // Added chatFolderName
  user: AppUser; // Add user object for attachment handling
  onClick?: () => void; // Make onClick optional
  isClickable?: boolean; // Explicit prop to control cursor/title
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  myUsername,
  userId, // Destructure added prop
  chatFolderName, // Destructure added prop
  user, // Destructure user prop
  onClick,
  isClickable,
}) => {
  const isMyMessage = message.sender === myUsername && myUsername !== "";
  const messageClass = isMyMessage
    ? "message-item my-message"
    : "message-item other-message";
  const directionClass = `direction-${message.direction}`;

  return (
    <div
      id={`message-${message.startLine}`}
      className={messageClass}
      onClick={onClick}
      title={isClickable ? "Go to this message in full chat" : ""}
      style={{ cursor: isClickable ? "pointer" : "default" }}
    >
      <div className="message-bubble">
        <div className="message-meta">
          <span className="sender">{message.sender || "System"}</span>
          <span className="timestamp">{message.timestamp}</span>
        </div>
        <div className={`message-content ${directionClass}`}>
          {message.content && <p>{message.content}</p>}
          {message.attachment && (
            <AttachmentPreview
              attachmentName={message.attachment}
              userId={userId} // Pass userId down
              chatFolderName={chatFolderName} // Pass chatFolderName down
              user={user} // Pass user object down
            />
          )}
        </div>
      </div>
    </div>
  );
};
