import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportVideoToVault } from '@core/export/export-to-vault';
import type { LearningSession, VideoMetadata } from '@core/types';

const mocks = vi.hoisted(() => ({
  checkVaultPermission: vi.fn(),
  close: vi.fn(),
  exportRecordPut: vi.fn(),
  getDirectoryHandle: vi.fn(),
  getFileHandle: vi.fn(),
  readVaultSettings: vi.fn(),
  write: vi.fn(),
}));

vi.mock('@core/storage/db', () => ({
  db: {
    exportRecords: {
      put: mocks.exportRecordPut,
    },
  },
}));

vi.mock('@core/storage/vault-settings', () => ({
  checkVaultPermission: mocks.checkVaultPermission,
  readVaultSettings: mocks.readVaultSettings,
}));

const metadata: VideoMetadata = {
  platform: 'youtube',
  videoId: 'video-1',
  title: '导出测试',
  author: '作者',
  url: 'https://example.com/watch?v=video-1',
};

const learningSession: LearningSession = {
  id: 'youtube:video-1',
  schemaVersion: 2,
  platform: 'youtube',
  videoId: 'video-1',
  goal: { mode: 'adaptive', focus: '理解论证' },
  coach: { enabled: true, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  review: {
    coreSummary: '核心总结',
    keyIdeas: [{ title: '关键观点', explanation: '解释' }],
    personalInsights: [],
    openQuestions: [],
    actionItems: [],
    finalReflection: '学习总结',
    generatedAt: 1,
    modelUsed: 'model',
  },
  createdAt: 1,
  updatedAt: 1,
};

describe('exportVideoToVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
    mocks.write.mockResolvedValue(undefined);
    mocks.getFileHandle.mockImplementation((_, options?: FileSystemGetFileOptions) => {
      if (!options?.create) {
        const error = new Error('not found');
        error.name = 'NotFoundError';
        return Promise.reject(error);
      }
      return Promise.resolve({
        createWritable: vi.fn().mockResolvedValue({
          write: mocks.write,
          close: mocks.close,
        }),
      });
    });
    mocks.getDirectoryHandle.mockResolvedValue({
      getFileHandle: mocks.getFileHandle,
    });
    mocks.readVaultSettings.mockResolvedValue({
      id: 'default',
      directoryName: 'Vault',
      directoryHandle: {
        getDirectoryHandle: mocks.getDirectoryHandle,
      },
      updatedAt: 1,
    });
    mocks.checkVaultPermission.mockResolvedValue('granted');
    mocks.exportRecordPut.mockResolvedValue(undefined);
  });

  it('writes one Markdown file under bAI directory', async () => {
    const record = await exportVideoToVault({
      metadata,
      analysis: null,
      learningSession,
    });

    expect(mocks.getDirectoryHandle).toHaveBeenCalledWith('bAI', { create: true });
    expect(mocks.getFileHandle.mock.calls[1]?.[0]).toMatch(/\.md$/);
    expect(mocks.write).toHaveBeenCalledWith(expect.stringContaining('## 基本信息'));
    expect(record.folderName).toMatch(/^bAI\/.+\.md$/);
    expect(mocks.exportRecordPut).toHaveBeenCalledWith(
      expect.objectContaining({ folderName: record.folderName }),
    );
  });

  it('同名文件已存在时先确认，用户取消则不覆盖', async () => {
    mocks.getFileHandle.mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write: mocks.write,
        close: mocks.close,
      }),
    });

    await expect(
      exportVideoToVault({
        metadata,
        analysis: null,
        learningSession,
        confirmOverwrite: () => false,
      }),
    ).rejects.toThrow('已取消导出，未覆盖原文件');

    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.exportRecordPut).not.toHaveBeenCalled();
  });

  it('同名文件已存在且用户确认后覆盖写入', async () => {
    mocks.getFileHandle.mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write: mocks.write,
        close: mocks.close,
      }),
    });
    const confirmOverwrite = vi.fn().mockReturnValue(true);

    await exportVideoToVault({
      metadata,
      analysis: null,
      learningSession,
      confirmOverwrite,
    });

    expect(confirmOverwrite).toHaveBeenCalledWith(expect.stringMatching(/^bAI\/.+\.md$/));
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it('写入失败时仍关闭 writable，并保留原始错误', async () => {
    mocks.write.mockRejectedValue(new Error('disk full'));

    await expect(
      exportVideoToVault({
        metadata,
        analysis: null,
        learningSession,
      }),
    ).rejects.toThrow('disk full');

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.exportRecordPut).not.toHaveBeenCalled();
  });

  it('maps stale directory handle errors to actionable text', async () => {
    const notFound = new Error(
      'A requested file or directory could not be found at the time an operation was processed.',
    );
    notFound.name = 'NotFoundError';
    mocks.checkVaultPermission.mockRejectedValue(notFound);

    await expect(
      exportVideoToVault({
        metadata,
        analysis: null,
        learningSession,
      }),
    ).rejects.toThrow('已保存的 Markdown Vault 目录不可用，请到设置页重新选择目录后再导出');
  });

  it('maps stale directory handle errors to English when exporting English artifacts', async () => {
    const notFound = new Error(
      'A requested file or directory could not be found at the time an operation was processed.',
    );
    notFound.name = 'NotFoundError';
    mocks.checkVaultPermission.mockRejectedValue(notFound);

    await expect(
      exportVideoToVault({
        metadata,
        analysis: null,
        learningSession,
        outputLocale: 'en-US',
      }),
    ).rejects.toThrow(
      'The saved Markdown Vault folder is unavailable. Choose the folder again in Settings before exporting.',
    );
  });

  it('maps stale IndexedDB directory handle read errors to actionable text', async () => {
    const notFound = new Error(
      'A requested file or directory could not be found at the time an operation was processed.',
    );
    notFound.name = 'NotFoundError';
    mocks.readVaultSettings.mockRejectedValue(notFound);

    await expect(
      exportVideoToVault({
        metadata,
        analysis: null,
        learningSession,
      }),
    ).rejects.toThrow('已保存的 Markdown Vault 目录不可用，请到设置页重新选择目录后再导出');
  });
});
