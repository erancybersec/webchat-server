import { useState } from 'react';
import RecipientChips from '../components/RecipientChips';
import SendProgress from '../components/SendProgress';
import { api } from '../lib/api';
import { normalizeRecipientId } from '../lib/phone';
import { useJobSend } from '../lib/useJobSend';
import { useNeedsApproval } from '../lib/workbench';
import type { JobItem, Recipient } from '../types';

type Tool = 'location' | 'contact' | 'reaction' | 'list' | 'status';

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'location', label: '📍 Location' },
  { id: 'contact', label: '👤 Contact' },
  { id: 'reaction', label: '❤️ Reaction' },
  { id: 'list', label: '📋 List Message' },
  { id: 'status', label: '📢 Status / Story' },
];

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉'];

const input = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm';
const label = 'block text-xs font-medium text-gray-600';

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={label}>{title}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export default function ToolsPage() {
  const [tool, setTool] = useState<Tool>('location');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const { progress, setProgress, run } = useJobSend();
  const [feedback, setFeedback] = useState('');

  // location
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [locName, setLocName] = useState('');
  const [locAddress, setLocAddress] = useState('');
  // contact
  const [cName, setCName] = useState('');
  const [cPhone, setCPhone] = useState('');
  // reaction
  const [rMsgId, setRMsgId] = useState('');
  const [rFromMe, setRFromMe] = useState(false);
  const [rEmoji, setREmoji] = useState('❤️');
  // list
  const [lTitle, setLTitle] = useState('');
  const [lDesc, setLDesc] = useState('');
  const [lButton, setLButton] = useState('');
  const [lFooter, setLFooter] = useState('');
  const [lRows, setLRows] = useState<Array<{ title: string; description: string }>>([
    { title: '', description: '' },
  ]);
  // status
  const [sType, setSType] = useState<'text' | 'image' | 'video'>('text');
  const [sContent, setSContent] = useState('');
  const [sCaption, setSCaption] = useState('');
  const [sBg, setSBg] = useState('#25D366');
  const [sAll, setSAll] = useState(true);
  const [sJids, setSJids] = useState('');

  function buildItem(): JobItem | string {
    switch (tool) {
      case 'location': {
        if (!lat.trim() || !lng.trim()) return 'Latitude and longitude are required';
        if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)))
          return 'Latitude and longitude must be numbers';
        const data: Record<string, unknown> = { latitude: Number(lat), longitude: Number(lng) };
        if (locName.trim()) data.name = locName.trim();
        if (locAddress.trim()) data.address = locAddress.trim();
        return { type: 'location', data };
      }
      case 'contact':
        if (!cName.trim() || !cPhone.trim()) return 'Contact name and phone are required';
        return { type: 'contact', data: { fullName: cName.trim(), phoneNumber: cPhone.trim() } };
      case 'reaction':
        if (!rMsgId.trim() || !rEmoji.trim()) return 'Message ID and emoji are required';
        return { type: 'reaction', data: { messageId: rMsgId.trim(), reaction: rEmoji, fromMe: rFromMe } };
      case 'list': {
        if (!lTitle.trim() || !lButton.trim()) return 'Title and button text are required';
        const rows = lRows
          .filter((r) => r.title.trim() || r.description.trim())
          .map((r, i) => ({
            title: r.title.trim() || `Option ${i + 1}`,
            description: r.description.trim(),
            rowId: `row_${i + 1}`,
          }));
        if (!rows.length) return 'Add at least one option row';
        const data: Record<string, unknown> = {
          title: lTitle.trim(),
          buttonText: lButton.trim(),
          sections: [{ title: lTitle.trim(), rows }],
        };
        if (lDesc.trim()) data.description = lDesc.trim();
        if (lFooter.trim()) data.footerText = lFooter.trim();
        return { type: 'list', data };
      }
      case 'status': {
        if (!sContent.trim()) return sType === 'text' ? 'Status text is required' : 'Media URL is required';
        const data: Record<string, unknown> = {
          statusType: sType,
          content: sContent.trim(),
          allContacts: sAll,
        };
        if (!sAll) {
          // Evolution expects full JIDs — normalize bare phone numbers
          const jids = sJids
            .split('\n')
            .map((s) => normalizeRecipientId(s))
            .filter((s): s is string => !!s)
            .map((s) => (s.includes('@') ? s : `${s}@s.whatsapp.net`));
          if (!jids.length) return 'Add target JIDs or choose all contacts';
          data.statusJidList = jids;
        }
        if (sType === 'text') {
          data.backgroundColor = sBg;
          data.font = 1;
        } else if (sCaption.trim()) {
          data.caption = sCaption.trim();
        }
        return { type: 'status', data };
      }
    }
  }

  const needsRecipients = tool !== 'status';
  const { needed: willNeedApproval } = useNeedsApproval(needsRecipients ? recipients.length : 0);

  async function send() {
    setFeedback('');
    const item = buildItem();
    if (typeof item === 'string') {
      setFeedback(item);
      return;
    }
    if (tool === 'status') {
      // A status is one broadcast call, not a fan-out: there is no per-recipient
      // ledger to keep and nobody's first contact to ration, so it stays a
      // direct send rather than becoming a one-row job.
      setProgress(null);
      try {
        await api.send('status@broadcast', item, true);
        setFeedback('Status posted');
      } catch (e) {
        setFeedback(String((e as Error).message));
      }
      return;
    }
    if (!recipients.length) {
      setFeedback('Add at least one recipient');
      return;
    }
    try {
      const result = await run(recipients, [item]);
      setFeedback(
        result.held
          ? 'Submitted for approval — it sends once an approver releases it (Scheduled tab)'
          : result.paused
            ? 'Stopped short — the campaign card in History says why, and continues it'
            : 'Done — full record in the History tab',
      );
    } catch (e) {
      setFeedback(String((e as Error).message));
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Send Tools</h2>
        <p className="text-sm text-gray-500">One-off sends: location, contact card, reaction, list message, status.</p>
      </div>

      <div className="flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition-all ${
              tool === t.id ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        {needsRecipients && (
          <Field title={tool === 'reaction' ? 'Chat (number or JID)' : 'Recipient(s)'}>
            <RecipientChips value={recipients} onChange={setRecipients} />
          </Field>
        )}

        {tool === 'location' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field title="Latitude *">
                <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="32.0853" className={input} />
              </Field>
              <Field title="Longitude *">
                <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="34.7818" className={input} />
              </Field>
            </div>
            <Field title="Place name">
              <input value={locName} onChange={(e) => setLocName(e.target.value)} dir="auto" className={input} />
            </Field>
            <Field title="Address">
              <input value={locAddress} onChange={(e) => setLocAddress(e.target.value)} dir="auto" className={input} />
            </Field>
          </>
        )}

        {tool === 'contact' && (
          <>
            <Field title="Contact full name *">
              <input value={cName} onChange={(e) => setCName(e.target.value)} dir="auto" className={input} />
            </Field>
            <Field title="Contact phone *">
              <input value={cPhone} onChange={(e) => setCPhone(e.target.value)} placeholder="972501234567" className={input} />
            </Field>
          </>
        )}

        {tool === 'reaction' && (
          <>
            <Field title="Message ID *">
              <input value={rMsgId} onChange={(e) => setRMsgId(e.target.value)} placeholder="3EB0…" className={`${input} font-mono`} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={rFromMe} onChange={(e) => setRFromMe(e.target.checked)} className="h-4 w-4 accent-(--color-wa)" />
              The message is mine (fromMe)
            </label>
            <Field title="Emoji *">
              <div className="flex flex-wrap gap-1.5">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setREmoji(e)}
                    className={`rounded-lg px-2.5 py-1.5 text-lg ${rEmoji === e ? 'bg-green-100 ring-2 ring-wa' : 'bg-gray-50 hover:bg-gray-100'}`}
                  >
                    {e}
                  </button>
                ))}
                <input value={rEmoji} onChange={(e) => setREmoji(e.target.value)} className="w-16 rounded-lg border border-gray-300 px-2 py-1 text-center" />
              </div>
            </Field>
          </>
        )}

        {tool === 'list' && (
          <>
            <Field title="Title *">
              <input value={lTitle} onChange={(e) => setLTitle(e.target.value)} dir="auto" className={input} />
            </Field>
            <Field title="Description">
              <input value={lDesc} onChange={(e) => setLDesc(e.target.value)} dir="auto" className={input} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field title="Button text *">
                <input value={lButton} onChange={(e) => setLButton(e.target.value)} dir="auto" className={input} />
              </Field>
              <Field title="Footer">
                <input value={lFooter} onChange={(e) => setLFooter(e.target.value)} dir="auto" className={input} />
              </Field>
            </div>
            <Field title="Options *">
              <div className="space-y-2">
                {lRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={row.title}
                      onChange={(e) =>
                        setLRows(lRows.map((r, j) => (j === i ? { ...r, title: e.target.value } : r)))
                      }
                      placeholder={`Option ${i + 1}`}
                      dir="auto"
                      className={input}
                    />
                    <input
                      value={row.description}
                      onChange={(e) =>
                        setLRows(
                          lRows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)),
                        )
                      }
                      placeholder="Description (optional)"
                      dir="auto"
                      className={input}
                    />
                    <button
                      onClick={() => setLRows(lRows.filter((_, j) => j !== i))}
                      disabled={lRows.length === 1}
                      title="Remove option"
                      aria-label={`Remove option ${i + 1}`}
                      className="shrink-0 rounded px-2 py-1 text-base leading-none text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setLRows([...lRows, { title: '', description: '' }])}
                  className="rounded-lg border border-green-300 px-3 py-1.5 text-xs font-medium text-wa-dark hover:bg-green-50"
                >
                  + Add option
                </button>
              </div>
            </Field>
          </>
        )}

        {tool === 'status' && (
          <>
            <Field title="Type">
              <select value={sType} onChange={(e) => setSType(e.target.value as never)} className={input}>
                <option value="text">Text</option>
                <option value="image">Image (URL)</option>
                <option value="video">Video (URL)</option>
              </select>
            </Field>
            <Field title={sType === 'text' ? 'Status text *' : 'Media URL *'}>
              {sType === 'text' ? (
                <textarea value={sContent} onChange={(e) => setSContent(e.target.value)} rows={3} dir="auto" className={input} />
              ) : (
                <input value={sContent} onChange={(e) => setSContent(e.target.value)} placeholder="https://…" className={input} />
              )}
            </Field>
            {sType === 'text' ? (
              <Field title="Background color">
                <input type="color" value={sBg} onChange={(e) => setSBg(e.target.value)} className="h-9 w-16 rounded border border-gray-300" />
              </Field>
            ) : (
              <Field title="Caption">
                <input value={sCaption} onChange={(e) => setSCaption(e.target.value)} dir="auto" className={input} />
              </Field>
            )}
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={sAll} onChange={(e) => setSAll(e.target.checked)} className="h-4 w-4 accent-(--color-wa)" />
              Send to all contacts
            </label>
            {!sAll && (
              <Field title="Target JIDs — one per line">
                <textarea value={sJids} onChange={(e) => setSJids(e.target.value)} rows={3} placeholder="972501234567@s.whatsapp.net" className={`${input} font-mono`} />
              </Field>
            )}
          </>
        )}

        <button
          onClick={() => void send()}
          disabled={progress?.running}
          className="w-full rounded-lg bg-wa py-2.5 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
        >
          {tool === 'status'
            ? 'Post Status'
            : willNeedApproval
              ? `Submit for approval (${recipients.length} recipients)`
              : `Send ${TOOLS.find((t) => t.id === tool)?.label}`}
        </button>
        {progress && <SendProgress progress={progress} />}
        {feedback && (
          <div role="alert" className="text-sm text-amber-600">
            {feedback}
          </div>
        )}
      </div>
    </div>
  );
}
