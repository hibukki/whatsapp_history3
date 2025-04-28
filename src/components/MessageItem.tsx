import React from "react";
import { ParsedMessage } from "../chatParser";
import { AttachmentPreview } from "./AttachmentPreview"; // Assuming AttachmentPreview is also extracted

interface MessageItemProps {
  message: ParsedMessage;
  myUsername: string;
  onClick?: () => void; // Make onClick optional
  isClickable?: boolean; // Explicit prop to control cursor/title
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  myUsername,
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
              // Pass necessary props for URL fetching if AttachmentPreview needs them directly
              // Alternatively, AttachmentPreview might use context or global state
            />
          )}
        </div>
      </div>
    </div>
  );
};
