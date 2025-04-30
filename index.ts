#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
 } from "@modelcontextprotocol/sdk/types.js";
import { Resend } from "resend";
import { readFileSync, existsSync } from "fs";
import dotenv from "dotenv";
dotenv.config();

// Get API key from environment variable
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
if (!RESEND_API_KEY) {
  console.error("Error: RESEND_API_KEY environment variable is required");
  process.exit(1);
}

// Get sender email from environment variable
const SENDER_EMAIL_ADDRESS = process.env.SENDER_EMAIL_ADDRESS;
if (!SENDER_EMAIL_ADDRESS) {
  console.error("Error: SENDER_EMAIL_ADDRESS environment variable is required");
  process.exit(1);
}

// Get optional reply-to emails from environment variable
const REPLY_TO_EMAIL_ADDRESSES = process.env.REPLY_TO_EMAIL_ADDRESSES ?
  process.env.REPLY_TO_EMAIL_ADDRESSES.split(",").map(e => e.trim()).filter(Boolean) : [];

// Initialize Resend client
const resend = new Resend(RESEND_API_KEY.trim());

// Define email sending tool
const SEND_EMAIL_TOOL: Tool = {
  name: "send_email",
  description:
    "Sends an email using the Resend API. " +
    "Supports plain text content, attachments and optional scheduling. " +
    "Can specify custom sender and reply-to addresses.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        format: "email",
        description: "Recipient email address"
      },
      subject: {
        type: "string",
        description: "Email subject line"
      },
      content: {
        type: "string",
        description: "Plain text email content"
      },
      from: {
        type: "string",
        format: "email",
        description: "Optional. If provided, uses this as the sender email address; otherwise uses SENDER_EMAIL_ADDRESS environment variable"
      },
      replyTo: {
        type: "array",
        items: {
          type: "string",
          format: "email"
        },
        description: "Optional. If provided, uses these as the reply-to email addresses; otherwise uses REPLY_TO_EMAIL_ADDRESSES environment variable"
      },
      scheduledAt: {
        type: "string",
        description: "Optional parameter to schedule the email. This uses natural language. Examples would be 'tomorrow at 10am' or 'in 2 hours' or 'next day at 9am PST' or 'Friday at 3pm ET'."
      },
      attachments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "Name of the attachment file"
            },
            localPath: {
              type: "string",
              description: "Absolute path to a local file on user's computer. Required if remoteUrl is not provided."
            },
            remoteUrl: {
              type: "string",
              description: "URL to a file on the internet. Required if localPath is not provided."
            }
          },
          required: ["filename"],
          oneOf: [
            { required: ["localPath"] },
            { required: ["remoteUrl"] }
          ]
        },
        description: "Optional. List of attachments. Each attachment must have a filename and either localPath (path to a local file) or remoteUrl (URL to a file on the internet)."
      }
    },
    required: ["to", "subject", "content"]
  }
};

// Type guard for email args
interface Attachment {
  filename: string;
  localPath?: string;
  remoteUrl?: string;
}

function isAttachment(arg: unknown): arg is Attachment {
  if (typeof arg !== "object" || arg === null) return false;

  const attachment = arg as Attachment;
  if (typeof attachment.filename !== "string") return false;

  // Must have either localPath or remoteUrl, but not both
  const hasLocalPath = "localPath" in attachment && typeof attachment.localPath === "string";
  const hasRemoteUrl = "remoteUrl" in attachment && typeof attachment.remoteUrl === "string";
  return hasLocalPath !== hasRemoteUrl; // XOR operation
}

function isEmailArgs(args: unknown): args is {
  to: string;
  subject: string;
  content: string;
  from?: string;
  replyTo?: string[];
  scheduledAt?: string;
  attachments?: Attachment[];
} {
  if (
    typeof args !== "object" ||
    args === null
  ) {
    return false;
  }

  const emailArgs = args as {
    to: unknown;
    subject: unknown;
    content: unknown;
    attachments?: unknown[];
  };

  if (
    !("to" in emailArgs) ||
    typeof emailArgs.to !== "string" ||
    !("subject" in emailArgs) ||
    typeof emailArgs.subject !== "string" ||
    !("content" in emailArgs) ||
    typeof emailArgs.content !== "string"
  ) {
    return false;
  }

  // Check optional attachments if present
  if ("attachments" in emailArgs) {
    if (!Array.isArray(emailArgs.attachments)) return false;
    if (!emailArgs.attachments.every(isAttachment)) return false;
  }

  return true;
}

// Server implementation
const server = new Server(
  {
    name: "resend-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SEND_EMAIL_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    switch (name) {
      case SEND_EMAIL_TOOL.name: {
        if (!isEmailArgs(args)) {
          throw new Error("Invalid arguments for send_email tool");
        }

        const fromEmail = args.from || SENDER_EMAIL_ADDRESS.trim();
        if (!fromEmail) {
          throw new Error("Sender email must be provided either via args or SENDER_EMAIL_ADDRESS environment variable");
        }

        const replyToEmails = args.replyTo || REPLY_TO_EMAIL_ADDRESSES;

        // Convert attachments to Resend API format
        const attachments = args.attachments?.map(attachment => {
          if (attachment.localPath) {
            // Check if file exists
            if (!existsSync(attachment.localPath)) {
              throw new Error(`Attachment file not found: ${attachment.localPath}`);
            }
            // Try to read the file
            try {
              // readFileSync can read any file format as it reads files in binary mode
              const content = readFileSync(attachment.localPath).toString('base64');
              return {
                filename: attachment.filename,
                content,
                path: undefined
              };
            } catch (error) {
              throw new Error(`Failed to read attachment file: ${attachment.localPath}. Error: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          // If using remoteUrl
          return {
            filename: attachment.filename,
            content: undefined,
            path: attachment.remoteUrl
          };
        });

        const response = await resend.emails.send({
          to: args.to,
          from: fromEmail,
          subject: args.subject,
          text: args.content,
          replyTo: replyToEmails,
          scheduledAt: args.scheduledAt,
          attachments,
        });

        if (response.error) {
          throw new Error(`Failed to send email: ${JSON.stringify(response.error)}`);
        }

        return {
          content: [{
            type: "text",
            text: `Email sent successfully! ${JSON.stringify(response.data)}`
          }]
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Resend MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
