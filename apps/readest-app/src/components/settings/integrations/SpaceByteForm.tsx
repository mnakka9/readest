import clsx from 'clsx';
import React, { useState } from 'react';
import { MdVisibility, MdVisibilityOff } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import {
  createSpaceByteProvider,
  createSpaceByteRootFolder,
} from '@/services/sync/providers/spacebyte/SpaceByteProvider';
import { FileSyncError } from '@/services/sync/file/provider';
import { SectionTitle } from '../primitives';
import FileSyncForm from './FileSyncForm';
import { persistCloudProviderEnabled } from './cloudSync';

const SpaceByteForm: React.FC = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const stored = settings.spacebyte;
  const [apiKey, setApiKey] = useState(stored?.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setIsConnecting(true);
    try {
      let rootFolderId =
        stored?.apiKey === key && stored.rootFolderId ? stored.rootFolderId : undefined;
      if (rootFolderId) {
        await createSpaceByteProvider({ apiKey: key, rootFolderId }).list('/');
      } else {
        rootFolderId = await createSpaceByteRootFolder(key);
      }
      await persistCloudProviderEnabled(envConfig, 'spacebyte', true, (current) => ({
        ...current,
        spacebyte: {
          ...current.spacebyte,
          apiKey: key,
          rootFolderId,
        },
      }));
      eventDispatcher.dispatch('toast', { type: 'info', message: _('Connected') });
    } catch (error) {
      const message =
        error instanceof FileSyncError && error.code === 'AUTH_FAILED'
          ? _('Authentication failed')
          : _('Failed to connect');
      eventDispatcher.dispatch('toast', { type: 'error', message });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await persistCloudProviderEnabled(envConfig, 'spacebyte', false);
    setShowKey(false);
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Disconnected') });
  };

  const persistSpaceByte = async (patch: Partial<typeof stored>) => {
    const latest = useSettingsStore.getState().settings;
    const next = { ...latest, spacebyte: { ...latest.spacebyte, ...patch } };
    setSettings(next);
    await saveSettings(envConfig, next);
  };

  if (stored?.enabled) {
    return (
      <div className='space-y-5'>
        <FileSyncForm kind='spacebyte' stored={stored} persist={persistSpaceByte} />
        <div className='flex justify-end'>
          <button
            type='button'
            onClick={handleDisconnect}
            className={clsx(
              'eink-bordered',
              'h-10 rounded-lg px-4 text-sm font-medium',
              'text-error hover:bg-error/10',
              'transition-colors duration-150',
              'focus-visible:ring-error/40 focus-visible:outline-hidden focus-visible:ring-2',
            )}
          >
            {_('Disconnect')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className='space-y-4'
      onSubmit={(event) => {
        event.preventDefault();
        void handleConnect();
      }}
    >
      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='spacebyte-api-key' className='block'>
          {_('API Key')}
        </SectionTitle>
        <div className='relative'>
          <input
            id='spacebyte-api-key'
            type={showKey ? 'text' : 'password'}
            placeholder={_('Your API Key')}
            className='input eink-bordered h-11 w-full pe-11 text-sm focus:outline-hidden'
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete='off'
          />
          <button
            type='button'
            onClick={() => setShowKey((visible) => !visible)}
            className={clsx(
              'absolute end-2 top-1/2 -translate-y-1/2',
              'flex h-8 w-8 items-center justify-center rounded-sm',
              'text-base-content/60 hover:text-base-content',
              'hover:bg-base-200/60 transition-colors duration-150',
              'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2',
            )}
            aria-label={showKey ? _('Hide password') : _('Show password')}
            title={showKey ? _('Hide password') : _('Show password')}
            tabIndex={-1}
          >
            {showKey ? (
              <MdVisibilityOff className='h-4 w-4' />
            ) : (
              <MdVisibility className='h-4 w-4' />
            )}
          </button>
        </div>
      </div>
      <p className='text-base-content/60 text-xs'>
        {_('A ReadestBackup folder will be created in SpaceByte when you connect.')}
      </p>
      <div className='flex justify-end pt-1'>
        <button
          type='submit'
          disabled={isConnecting || !apiKey.trim()}
          className={clsx(
            'btn btn-contrast',
            'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
            'focus-visible:ring-base-content/40 focus-visible:outline-hidden focus-visible:ring-2',
            isConnecting && 'opacity-60',
          )}
        >
          {isConnecting ? <span className='loading loading-spinner loading-sm' /> : _('Connect')}
        </button>
      </div>
    </form>
  );
};

export default SpaceByteForm;
