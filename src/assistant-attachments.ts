import type { Attachment, AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/core";

export const TEXT_ATTACHMENT_ACCEPT =
  "text/plain,text/html,text/markdown,text/csv,text/xml,text/json,text/css,.txt,.md,.markdown,.js,.mjs,.cjs,.ts,.tsx,.jsx,.json,.css,.html,.svg,.xml,.csv,.yml,.yaml,.sh,.py,.go,.rs,.java";

export class WorkspaceTextAttachmentAdapter implements AttachmentAdapter {
  public accept = TEXT_ATTACHMENT_ACCEPT;

  public async add({ file }: { file: File }): Promise<PendingAttachment> {
    return {
      id: `${file.name}-${file.size}-${file.lastModified}`,
      type: "document",
      name: file.name,
      contentType: file.type || "text/plain",
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  public async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const text = await attachment.file.text();
    return {
      ...attachment,
      status: { type: "complete" },
      content: [
        {
          type: "file",
          filename: attachment.name,
          mimeType: attachment.contentType || "text/plain",
          data: text,
        },
      ],
    };
  }

  public async remove(_attachment: Attachment): Promise<void> {
    // no-op
  }
}
