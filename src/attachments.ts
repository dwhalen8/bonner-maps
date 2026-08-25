export type AttachmentKind = "floor_plan" | "elevation" | "deed" | "fire_signoff" | "other";

export interface AttachmentMeta {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  bytes: number;
  created_at: string;
}

async function apiError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string };
    return new Error(body.error || res.statusText);
  } catch {
    return new Error(res.statusText || "Request failed");
  }
}

export async function listAttachments(planId: string): Promise<AttachmentMeta[]> {
  const res = await fetch(`/api/plans/${planId}/attachments`, { credentials: "include" });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as AttachmentMeta[];
}

export async function uploadAttachment(
  planId: string,
  kind: AttachmentKind,
  file: File,
): Promise<AttachmentMeta> {
  const body = new FormData();
  body.set("kind", kind);
  body.set("file", file);
  const res = await fetch(`/api/plans/${planId}/attachments`, {
    method: "POST",
    credentials: "include",
    body,
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as AttachmentMeta;
}

export async function deleteAttachment(planId: string, attId: string): Promise<void> {
  const res = await fetch(`/api/plans/${planId}/attachments/${attId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok && res.status !== 204) throw await apiError(res);
}

export async function downloadAttachmentsZip(planId: string): Promise<void> {
  const res = await fetch(`/api/plans/${planId}/attachments.zip`, { credentials: "include" });
  if (!res.ok) throw await apiError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "blp-attachments.zip";
  a.click();
  URL.revokeObjectURL(url);
}
