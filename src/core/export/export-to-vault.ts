import { db, type ExportRecord } from '@core/storage/db';
import { checkVaultPermission, readVaultSettings } from '@core/storage/vault-settings';
import type { LearningSession, VideoAnalysis, VideoMetadata } from '@core/types';
import { createVideoMarkdownExport } from './markdown-exporter';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';

export async function exportVideoToVault(input: {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis | null;
  readonly learningSession: LearningSession;
  readonly outputLocale?: UiLocale;
  readonly confirmOverwrite?: (folderName: string) => boolean | Promise<boolean>;
}): Promise<ExportRecord> {
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const settings = await readVaultSettingsSafely(outputLocale);

  if (!settings) {
    throw new Error(
      outputLocale === 'en-US'
        ? 'Choose a Markdown Vault directory in Settings first'
        : '请先在设置页选择 Markdown Vault 目录',
    );
  }

  const permission = await readVaultPermission(outputLocale);

  if (permission !== 'granted') {
    throw new Error(
      outputLocale === 'en-US'
        ? 'Markdown Vault write permission is not granted'
        : '没有 Markdown Vault 写入权限',
    );
  }

  const exportedAt = Date.now();
  const output = createVideoMarkdownExport({ ...input, exportedAt });
  const folderName = `bAI/${output.fileName}`;

  try {
    const baiDirectory = await settings.directoryHandle.getDirectoryHandle('bAI', { create: true });
    const exists = await fileExists(baiDirectory, output.fileName);
    if (exists && input.confirmOverwrite) {
      const shouldOverwrite = await input.confirmOverwrite(folderName);
      if (!shouldOverwrite) {
        throw new Error(
          outputLocale === 'en-US'
            ? 'Export cancelled. Existing file was not overwritten.'
            : '已取消导出，未覆盖原文件',
        );
      }
    }
    await writeTextFile(baiDirectory, output.fileName, output.content);
  } catch (error) {
    throw mapVaultWriteError(error, outputLocale);
  }

  const record: ExportRecord = {
    id: `${input.metadata.platform}:${input.learningSession.videoId}`,
    platform: input.metadata.platform,
    videoId: input.learningSession.videoId,
    folderName,
    exportedAt,
  };

  await db.exportRecords.put(record);
  return record;
}

async function fileExists(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> {
  try {
    await directory.getFileHandle(fileName, { create: false });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function readVaultSettingsSafely(
  outputLocale: UiLocale,
): Promise<Awaited<ReturnType<typeof readVaultSettings>>> {
  try {
    return await readVaultSettings();
  } catch (error) {
    throw mapVaultWriteError(error, outputLocale);
  }
}

async function readVaultPermission(
  outputLocale: UiLocale,
): Promise<Awaited<ReturnType<typeof checkVaultPermission>>> {
  try {
    return await checkVaultPermission({ request: true });
  } catch (error) {
    throw mapVaultWriteError(error, outputLocale);
  }
}

async function writeTextFile(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  content: string,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  let writeError: unknown;
  try {
    await writable.write(content);
  } catch (error) {
    writeError = error;
  }
  try {
    await writable.close();
  } catch (closeError) {
    if (!writeError) {
      throw closeError;
    }
  }
  if (writeError) {
    throw writeError;
  }
}

function mapVaultWriteError(error: unknown, outputLocale: UiLocale): Error {
  if (isMissingFileSystemHandleError(error)) {
    return new Error(
      outputLocale === 'en-US'
        ? 'The saved Markdown Vault folder is unavailable. Choose the folder again in Settings before exporting.'
        : '已保存的 Markdown Vault 目录不可用，请到设置页重新选择目录后再导出',
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isMissingFileSystemHandleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'NotFoundError' ||
    error.message.includes('A requested file or directory could not be found')
  );
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'NotFoundError';
}
