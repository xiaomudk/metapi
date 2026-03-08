function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function splitBase64DataUrl(value: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value.trim());
  if (!match) return null;
  return {
    mimeType: match[1].trim().toLowerCase(),
    data: match[2].trim(),
  };
}

export type NormalizedInputFile = {
  sourceType?: 'file' | 'input_file';
  fileId?: string;
  fileData?: string;
  filename?: string;
  mimeType?: string | null;
  hadDataUrl?: boolean;
};

export function inferInputFileMimeType(input: Pick<NormalizedInputFile, 'filename' | 'mimeType'>): string | null {
  const explicit = asTrimmedString(input.mimeType);
  if (explicit) return explicit.toLowerCase();

  const filename = asTrimmedString(input.filename).toLowerCase();
  if (!filename) return null;
  if (filename.endsWith('.pdf')) return 'application/pdf';
  if (filename.endsWith('.txt')) return 'text/plain';
  if (filename.endsWith('.md') || filename.endsWith('.markdown')) return 'text/markdown';
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
  if (filename.endsWith('.gif')) return 'image/gif';
  if (filename.endsWith('.webp')) return 'image/webp';
  if (filename.endsWith('.wav')) return 'audio/wav';
  if (filename.endsWith('.mp3')) return 'audio/mpeg';
  return null;
}

export function normalizeInputFileBlock(item: Record<string, unknown>): NormalizedInputFile | null {
  const type = asTrimmedString(item.type).toLowerCase();

  if (type === 'input_file') {
    const fileId = asTrimmedString(item.file_id);
    const fileData = asTrimmedString(item.file_data);
    const filename = asTrimmedString(item.filename);
    let mimeType = asTrimmedString(item.mime_type ?? item.mimeType) || null;
    if (!fileId && !fileData) return null;
    const parsedDataUrl = fileData ? splitBase64DataUrl(fileData) : null;
    if (parsedDataUrl) {
      mimeType = mimeType || parsedDataUrl.mimeType;
    }
    return {
      sourceType: 'input_file',
      fileId: fileId || undefined,
      fileData: fileData || undefined,
      filename: filename || undefined,
      mimeType,
      hadDataUrl: /^data:[^;,]+;base64,/i.test(fileData),
    };
  }

  if (type === 'file') {
    const file = isRecord(item.file) ? item.file : item;
    const fileId = asTrimmedString(file.file_id ?? item.file_id);
    const fileData = asTrimmedString(file.file_data ?? item.file_data);
    const filename = asTrimmedString(file.filename ?? item.filename);
    let mimeType = asTrimmedString(file.mime_type ?? file.mimeType ?? item.mime_type ?? item.mimeType) || null;
    if (!fileId && !fileData) return null;
    const parsedDataUrl = fileData ? splitBase64DataUrl(fileData) : null;
    if (parsedDataUrl) {
      mimeType = mimeType || parsedDataUrl.mimeType;
    }
    return {
      sourceType: 'file',
      fileId: fileId || undefined,
      fileData: fileData || undefined,
      filename: filename || undefined,
      mimeType,
      hadDataUrl: /^data:[^;,]+;base64,/i.test(fileData),
    };
  }

  return null;
}

export function toResponsesInputFileBlock(file: NormalizedInputFile): Record<string, unknown> {
  const parsedDataUrl = file.fileData ? splitBase64DataUrl(file.fileData) : null;
  const block: Record<string, unknown> = { type: 'input_file' };
  if (file.fileId) block.file_id = file.fileId;
  if (file.fileData) block.file_data = parsedDataUrl?.data || file.fileData;
  if (file.filename) block.filename = file.filename;
  if (file.mimeType) block.mime_type = file.mimeType;
  else if (parsedDataUrl?.mimeType) block.mime_type = parsedDataUrl.mimeType;
  return block;
}

export function toOpenAiChatFileBlock(file: NormalizedInputFile): Record<string, unknown> {
  const parsedDataUrl = file.fileData ? splitBase64DataUrl(file.fileData) : null;
  const payload: Record<string, unknown> = {};
  if (file.fileId) payload.file_id = file.fileId;
  if (file.fileData) payload.file_data = parsedDataUrl?.data || file.fileData;
  if (file.filename) payload.filename = file.filename;
  if (file.mimeType) payload.mime_type = file.mimeType;
  else if (parsedDataUrl?.mimeType) payload.mime_type = parsedDataUrl.mimeType;
  const block: Record<string, unknown> = { type: 'file' };
  block.file = payload;
  return block;
}

export function toAnthropicDocumentBlock(file: NormalizedInputFile): Record<string, unknown> | null {
  if (!file.fileData) return null;
  const parsedDataUrl = splitBase64DataUrl(file.fileData);
  const mimeType = parsedDataUrl?.mimeType || inferInputFileMimeType(file);
  if (!mimeType) return null;
  return {
    type: 'document',
    ...(file.hadDataUrl ? { cache_control: { type: 'ephemeral' } } : {}),
    source: {
      type: 'base64',
      media_type: mimeType,
      data: parsedDataUrl?.data || file.fileData,
    },
    ...(file.filename ? { title: file.filename } : {}),
  };
}
