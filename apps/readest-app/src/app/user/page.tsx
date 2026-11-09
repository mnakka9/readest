'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAppRouter } from '@/hooks/useAppRouter';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/hooks/useTheme';
import { useThemeStore } from '@/store/themeStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useUserActions } from '@/hooks/useUserActions';
import { navigateBackFromProfile } from '@/utils/nav';
import LegalLinks from '@/components/LegalLinks';
import { Toast } from '@/components/Toast';
import ProfileHeader from './components/Header';
import UserInfo from './components/UserInfo';
import AccountActions from './components/AccountActions';
import { SyncPassphraseSection } from './components/SyncPassphraseSection';
import { SyncCategoriesSection } from './components/SyncCategoriesSection';

const ProfilePage = () => {
  const _ = useTranslation();
  const router = useAppRouter();
  const searchParams = useSearchParams();
  const { appService } = useEnv();
  const { token, user } = useAuth();
  const { safeAreaInsets, isRoundedWindow } = useThemeStore();
  const [mounted, setMounted] = useState(false);
  const [showSyncManager, setShowSyncManager] = useState(
    () => searchParams?.get('section') === 'sync',
  );
  const {
    handleLogout,
    handleResetPassword,
    handleUpdateEmail,
    handleConfirmDelete,
    handleDeleteAllBooks,
  } = useUserActions();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted || (user && token && appService)) return;
    const timer = setTimeout(() => {
      const redirect = searchParams?.get('redirect') || '/library';
      router.push(`/auth?redirect=${encodeURIComponent(redirect)}`);
    }, 1000);
    return () => clearTimeout(timer);
  }, [mounted, user, token, appService, router, searchParams]);

  useTheme({ systemUIVisible: false });

  const handleGoBack = () => {
    if (showSyncManager) {
      setShowSyncManager(false);
      return;
    }
    navigateBackFromProfile(router, searchParams?.get('redirect'));
  };

  if (!mounted) return null;

  if (!user || !token || !appService) {
    return (
      <div className='mx-auto max-w-4xl px-4 py-8'>
        <div className='overflow-hidden rounded-lg shadow-md'>
          <div className='flex min-h-[300px] items-center justify-center p-6'>
            <div className='text-base-content animate-pulse'>{_('Loading profile...')}</div>
          </div>
        </div>
      </div>
    );
  }

  const avatarUrl = user.user_metadata?.['picture'] || user.user_metadata?.['avatar_url'];
  const userFullName = user.user_metadata?.['full_name'] || '-';
  const userEmail = user.email || '';

  return (
    <div
      className={clsx(
        'bg-base-100 full-height inset-0 select-none overflow-hidden',
        appService.hasRoundedWindow && isRoundedWindow && 'window-border rounded-window',
      )}
    >
      <div
        className='flex h-full w-full flex-col items-center overflow-y-auto'
        style={{ paddingTop: `${safeAreaInsets?.top || 0}px` }}
      >
        <ProfileHeader onGoBack={handleGoBack} />
        <div className='w-full min-w-60 max-w-4xl py-10'>
          <div className='sm:bg-base-200 overflow-hidden rounded-lg sm:p-6 sm:shadow-md'>
            <div className='flex flex-col gap-y-8'>
              <div className='flex flex-col gap-y-8 px-6'>
                <UserInfo avatarUrl={avatarUrl} userFullName={userFullName} userEmail={userEmail} />
              </div>
              {showSyncManager ? (
                <div className='flex flex-col gap-y-8 px-6'>
                  <SyncCategoriesSection />
                  <SyncPassphraseSection />
                </div>
              ) : (
                <div className='flex flex-col gap-y-8 px-6'>
                  <AccountActions
                    userEmail={userEmail}
                    onLogout={handleLogout}
                    onResetPassword={handleResetPassword}
                    onUpdateEmail={handleUpdateEmail}
                    onConfirmDelete={() =>
                      handleConfirmDelete(_('Failed to delete user. Please try again later.'))
                    }
                    onConfirmDeleteAllBooks={() =>
                      handleDeleteAllBooks(
                        _('All books deleted.'),
                        _('Failed to delete books. Please try again later.'),
                      )
                    }
                    onManageSync={() => setShowSyncManager(true)}
                  />
                </div>
              )}
              <LegalLinks />
            </div>
          </div>
        </div>
        <Toast />
      </div>
    </div>
  );
};

export default ProfilePage;
