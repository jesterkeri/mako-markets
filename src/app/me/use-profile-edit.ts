'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { USER_QUERY_KEY, type AuthedUser } from '@/lib/use-user';

import { AVATAR_CLEAR_ERROR, avatarFileError, avatarUploadError, NETWORK_ERROR, nameSaveError, validateDisplayName } from './profile-rules';

type UserCache = AuthedUser | { authed: false } | undefined;

/// Me's name and photo edits, through the existing profile APIs. Each success is merged into the signed-in user's
/// cache entry, then the entry is refetched, as the profile page does.
export function useProfileEdit() {
  const queryClient = useQueryClient();
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState('');
  const [photo, setPhoto] = useState<'idle' | 'uploading' | 'removing'>('idle');
  const [photoError, setPhotoError] = useState('');

  const merge = async (patch: Partial<Pick<AuthedUser, 'displayName' | 'avatarUrl'>>) => {
    queryClient.setQueryData<UserCache>(USER_QUERY_KEY, (old) => (old && old.authed ? { ...old, ...patch } : old));
    await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
  };

  /// Saves the name; true once it is stored.
  const saveName = async (value: string): Promise<boolean> => {
    const invalid = validateDisplayName(value);
    if (invalid) {
      setNameError(invalid);
      return false;
    }
    setNameError('');
    setNameBusy(true);
    try {
      const res = await fetch('/api/user/profile/update', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: value.trim() }),
      });
      if (!res.ok) {
        setNameError(nameSaveError(res.status));
        return false;
      }
      const body = (await res.json()) as Partial<AuthedUser>;
      await merge({ displayName: body.displayName ?? null });
      return true;
    } catch {
      setNameError(NETWORK_ERROR);
      return false;
    } finally {
      setNameBusy(false);
    }
  };

  const uploadPhoto = async (file: File) => {
    const invalid = avatarFileError(file);
    if (invalid) {
      setPhotoError(invalid);
      return;
    }
    setPhotoError('');
    setPhoto('uploading');
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      const res = await fetch('/api/user/avatar/upload', { method: 'POST', credentials: 'same-origin', body: fd });
      if (!res.ok) {
        setPhotoError(avatarUploadError(res.status));
        return;
      }
      const body = (await res.json()) as Partial<AuthedUser>;
      await merge({ avatarUrl: body.avatarUrl ?? null });
    } catch {
      setPhotoError(NETWORK_ERROR);
    } finally {
      setPhoto('idle');
    }
  };

  const removePhoto = async () => {
    setPhotoError('');
    setPhoto('removing');
    try {
      const res = await fetch('/api/user/profile/update', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatarUrl: null }),
      });
      if (!res.ok) {
        setPhotoError(AVATAR_CLEAR_ERROR);
        return;
      }
      await merge({ avatarUrl: null });
    } catch {
      setPhotoError(NETWORK_ERROR);
    } finally {
      setPhoto('idle');
    }
  };

  return {
    nameBusy,
    nameError,
    clearNameError: () => setNameError(''),
    saveName,
    photo,
    photoError,
    clearPhotoError: () => setPhotoError(''),
    uploadPhoto,
    removePhoto,
  };
}

export type ProfileEdit = ReturnType<typeof useProfileEdit>;
