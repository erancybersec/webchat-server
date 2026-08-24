import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useConfirm } from '../components/Confirm';
import { NotificationPrefsCard } from '../components/NotificationPrefsCard';
import { ToolbarPrefsCard } from '../components/ToolbarPrefsCard';
import { useToast } from '../components/Toast';
import { api } from '../lib/api';
import { fileToBase64 } from '../lib/voice';

const PRIVACY_FIELDS: Array<{ key: string; label: string; options: string[] }> = [
  { key: 'last', label: 'Last Seen', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
  { key: 'online', label: 'Online', options: ['all', 'match_last_seen'] },
  { key: 'profile', label: 'Profile Photo', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
  { key: 'status', label: 'About / Status', options: ['all', 'contacts', 'contact_blacklist', 'none'] },
  { key: 'readreceipts', label: 'Read Receipts', options: ['all', 'none'] },
  { key: 'groupadd', label: 'Who can add me to groups', options: ['all', 'contacts', 'contact_blacklist'] },
];

const input = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm';

export default function ProfilePage() {
  const confirmDlg = useConfirm();
  const toast = useToast();
  const [feedback, setFeedback] = useState('');
  const [newName, setNewName] = useState('');
  const [newStatus, setNewStatus] = useState('');
  const [picUrl, setPicUrl] = useState('');
  const [privacy, setPrivacy] = useState<Record<string, string>>({});

  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile.fetch, retry: 1 });

  const done = (msg: string) => () => {
    setFeedback('');
    toast(msg);
    void profile.refetch();
  };
  const fail = (e: unknown) => setFeedback(`✗ ${String((e as Error).message)}`);

  const setName = useMutation({ mutationFn: () => api.profile.setName(newName), onSuccess: done('Name updated'), onError: fail });
  const setStatus = useMutation({ mutationFn: () => api.profile.setStatus(newStatus), onSuccess: done('Status updated'), onError: fail });
  const setPicture = useMutation({ mutationFn: () => api.profile.setPicture(picUrl), onSuccess: done('Picture updated'), onError: fail });
  const removePicture = useMutation({ mutationFn: api.profile.removePicture, onSuccess: done('Picture removed'), onError: fail });
  const savePrivacy = useMutation({ mutationFn: () => api.profile.setPrivacy(privacy), onSuccess: done('Privacy updated'), onError: fail });

  const picFileInput = useRef<HTMLInputElement>(null);
  const setPictureData = useMutation({
    mutationFn: (dataUrl: string) => api.profile.setPicture(dataUrl),
    onSuccess: done('Picture updated'),
    onError: fail,
  });

  async function uploadPicture(f: File) {
    try {
      const b64 = await fileToBase64(f);
      setPictureData.mutate(`data:${f.type || 'image/jpeg'};base64,${b64}`);
    } catch {
      setFeedback('✗ Could not read the image file');
    }
  }

  async function confirmRemovePicture() {
    const ok = await confirmDlg({
      title: 'Remove your profile picture?',
      body: 'Everyone sees the default avatar afterwards.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) removePicture.mutate();
  }

  async function loadPrivacy() {
    try {
      const data = await api.profile.privacy();
      const p = (data?.privacy ?? data ?? {}) as Record<string, string>;
      const next: Record<string, string> = {};
      for (const f of PRIVACY_FIELDS) if (p[f.key]) next[f.key] = p[f.key]!;
      setPrivacy(next);
      setFeedback('Privacy loaded');
    } catch (e) {
      fail(e);
    }
  }

  const p = (profile.data ?? {}) as Record<string, any>;

  return (
    <div className="mx-auto max-w-2xl space-y-5 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Profile Settings</h2>
        <p className="text-sm text-gray-500">View and update this WhatsApp account's profile.</p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        {profile.isLoading && <div className="text-sm text-gray-400">Loading profile…</div>}
        {profile.isError && <div className="text-sm text-red-500">{String(profile.error)}</div>}
        {profile.isSuccess && (
          <div className="flex items-center gap-4">
            {p.profilePicUrl && (
              <img src={p.profilePicUrl} alt="" className="h-16 w-16 rounded-full border-2 border-green-200 object-cover" />
            )}
            <div>
              <p className="text-sm font-semibold text-gray-800" dir="auto">{p.profileName || '—'}</p>
              <p className="mt-0.5 text-xs text-gray-500" dir="auto">{p.status ?? ''}</p>
              <p className="mt-0.5 text-xs text-gray-400">
                {String(p.ownerJid ?? '').split('@')[0]}
                {p.connectionStatus ? ` · ${p.connectionStatus}` : ''}
              </p>
            </div>
          </div>
        )}
      </div>

      <NotificationPrefsCard />

      <ToolbarPrefsCard />

      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-800">Update Display Name</h3>
        <div className="flex gap-2">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} dir="auto" placeholder="New name" className={input} />
          <button onClick={() => setName.mutate()} disabled={!newName.trim() || setName.isPending} className="shrink-0 rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Update
          </button>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-800">Update Status / Bio</h3>
        <div className="flex gap-2">
          <input value={newStatus} onChange={(e) => setNewStatus(e.target.value)} dir="auto" placeholder="Available for booking…" className={input} />
          <button onClick={() => setStatus.mutate()} disabled={!newStatus.trim() || setStatus.isPending} className="shrink-0 rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Update
          </button>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-800">Profile Picture</h3>
        <input
          ref={picFileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadPicture(f);
            e.target.value = '';
          }}
        />
        <input value={picUrl} onChange={(e) => setPicUrl(e.target.value)} placeholder="https://example.com/photo.jpg" className={input} />
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setPicture.mutate()} disabled={!picUrl.trim() || setPicture.isPending} className="flex-1 rounded-lg bg-wa py-2 text-sm font-semibold text-white disabled:opacity-50">
            Set from URL
          </button>
          <button
            onClick={() => picFileInput.current?.click()}
            disabled={setPictureData.isPending}
            className="flex-1 rounded-lg border border-green-300 py-2 text-sm font-semibold text-wa-dark hover:bg-green-50 disabled:opacity-50"
          >
            {setPictureData.isPending ? 'Uploading…' : '📁 Upload Image'}
          </button>
          <button
            onClick={() => void confirmRemovePicture()}
            className="flex-1 rounded-lg border border-red-300 py-2 text-sm font-semibold text-red-500 hover:bg-red-50"
          >
            Remove
          </button>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800">Privacy Settings</h3>
          <button onClick={() => void loadPrivacy()} className="rounded-lg border border-green-300 px-3 py-1.5 text-xs font-medium text-wa-dark hover:bg-green-50">
            Load Current
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PRIVACY_FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="text-xs font-medium text-gray-600">{f.label}</span>
              <select
                value={privacy[f.key] ?? ''}
                onChange={(e) => setPrivacy({ ...privacy, [f.key]: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  —
                </option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <button
          onClick={() => savePrivacy.mutate()}
          disabled={!Object.keys(privacy).length || savePrivacy.isPending}
          className="w-full rounded-lg bg-wa py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save Privacy Settings
        </button>
      </div>

      {feedback && (
        <div role="alert" className="text-sm text-gray-600">
          {feedback}
        </div>
      )}
    </div>
  );
}
