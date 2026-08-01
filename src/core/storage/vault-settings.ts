import { db, type VaultSettingsRecord } from './db';

const VAULT_SETTINGS_ID = 'default';
const READWRITE_PERMISSION: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };

export type VaultPermissionState = PermissionState | 'missing' | 'unsupported';

export async function readVaultSettings(): Promise<VaultSettingsRecord | null> {
  return (await db.vaultSettings.get(VAULT_SETTINGS_ID)) ?? null;
}

export async function requestVaultDirectory(): Promise<VaultSettingsRecord> {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('当前浏览器不支持本地目录授权');
  }

  const directoryHandle = await window.showDirectoryPicker({
    mode: 'readwrite',
  });
  const record: VaultSettingsRecord = {
    id: VAULT_SETTINGS_ID,
    directoryName: directoryHandle.name,
    directoryHandle,
    updatedAt: Date.now(),
  };

  await db.vaultSettings.put(record);
  return record;
}

export async function checkVaultPermission(input?: {
  readonly request?: boolean;
}): Promise<VaultPermissionState> {
  const settings = await readVaultSettings();

  if (!settings) {
    return 'missing';
  }

  const queried = await settings.directoryHandle.queryPermission(READWRITE_PERMISSION);

  if (queried === 'granted' || !input?.request) {
    return queried;
  }

  return settings.directoryHandle.requestPermission(READWRITE_PERMISSION);
}
