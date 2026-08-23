import type { JobItem } from '../types.js';

export interface EvoRequest {
  endpoint: string;
  body: Record<string, unknown>;
}

/**
 * Map one queue item to an Evolution API request. This mirrors the SPA's
 * buildJobItemBody() — the item shapes are the SPA's wire format, so behavior
 * here must match what the frontend produces.
 */
export function buildEvoRequest(item: JobItem, number: string, instance: string): EvoRequest {
  const { type } = item;
  const data = (item.data ?? {}) as Record<string, any>;

  if (type === 'text') {
    if (!data.text) throw new Error('Text message is empty');
    const body: Record<string, unknown> = { number, text: data.text };
    if (data.quotedId) body.quoted = { key: { id: data.quotedId } };
    return { endpoint: `/message/sendText/${instance}`, body };
  }

  if (type === 'media' || type === 'image') {
    const media = data.base64 || data.url || data.media;
    if (!media) throw new Error('Media: no URL or file');
    if (!data.mimetype) throw new Error('Media: MIME type required');
    const body: Record<string, unknown> = {
      number,
      mediatype: data.mediatype || 'image',
      media,
      mimetype: data.mimetype,
    };
    if (data.filename) body.fileName = data.filename;
    if (data.caption) body.caption = data.caption;
    return { endpoint: `/message/sendMedia/${instance}`, body };
  }

  if (type === 'voice') {
    const audio = data.base64 || data.url;
    if (!audio) throw new Error('Voice: no URL or file');
    return {
      endpoint: `/message/sendWhatsAppAudio/${instance}`,
      body: { number, audio, encoding: data.encoding },
    };
  }

  if (type === 'poll') {
    // Trim the question and options: a vote is transmitted as a hash of the
    // option name, and voting clients disagree on whether to hash it trimmed
    // (iOS) or verbatim (others) — so an option with stray whitespace makes
    // part of the votes unmatchable for every reader, INCLUDING the WhatsApp
    // mobile app (option names are immutable once sent; confirmed on prod).
    const question = String(data.question ?? '').trim();
    if (!question) throw new Error('Poll: question required');
    const values = (Array.isArray(data.options) ? data.options : [])
      .map((o: unknown) => String(o ?? '').trim())
      .filter(Boolean);
    if (values.length < 2) throw new Error('Poll: at least 2 options');
    // WhatsApp's poll `selectableOptionsCount` is only ever 1 (single answer)
    // or 0 (multiple answers). An earlier build sent the option COUNT for
    // multi-answer polls (e.g. 4) — an out-of-spec value that makes votes
    // undecryptable for EVERYONE, including the WhatsApp mobile app itself
    // (confirmed on prod: ~8% vote-decode rate vs ~96% for `0`). Normalize so
    // anything that isn't an explicit single-answer poll becomes multiple (0).
    const selectableCount = data.selectable === 1 ? 1 : 0;
    return {
      endpoint: `/message/sendPoll/${instance}`,
      body: { number, name: question, values, selectableCount },
    };
  }

  if (type === 'location') {
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
      throw new Error('Location: latitude and longitude required');
    const body: Record<string, unknown> = { number, latitude, longitude };
    if (data.name) body.name = data.name;
    if (data.address) body.address = data.address;
    return { endpoint: `/message/sendLocation/${instance}`, body };
  }

  if (type === 'contact') {
    if (!data.fullName || !data.phoneNumber) throw new Error('Contact: name and phone required');
    return {
      endpoint: `/message/sendContact/${instance}`,
      body: {
        number,
        contact: [
          {
            fullName: data.fullName,
            wuid: data.wuid || data.phoneNumber,
            phoneNumber: data.phoneNumber,
          },
        ],
      },
    };
  }

  if (type === 'reaction') {
    if (!data.messageId || !data.reaction) throw new Error('Reaction: messageId and emoji required');
    return {
      endpoint: `/message/sendReaction/${instance}`,
      body: {
        key: { remoteJid: number, fromMe: !!data.fromMe, id: data.messageId },
        reaction: data.reaction,
      },
    };
  }

  if (type === 'list') {
    if (!data.title || !data.buttonText) throw new Error('List: title and button text required');
    if (!Array.isArray(data.sections) || !data.sections.length)
      throw new Error('List: at least one section required');
    const body: Record<string, unknown> = {
      number,
      title: data.title,
      buttonText: data.buttonText,
      sections: data.sections,
    };
    if (data.description) body.description = data.description;
    if (data.footerText) body.footerText = data.footerText;
    return { endpoint: `/message/sendList/${instance}`, body };
  }

  // Status/story broadcast — has no single recipient; `number` is ignored.
  if (type === 'status') {
    if (!data.content) throw new Error('Status: content required');
    const body: Record<string, unknown> = {
      type: data.statusType || 'text',
      content: data.content,
      allContacts: !!data.allContacts,
    };
    if (!data.allContacts && Array.isArray(data.statusJidList) && data.statusJidList.length)
      body.statusJidList = data.statusJidList;
    if (body.type === 'text') {
      if (data.backgroundColor) body.backgroundColor = data.backgroundColor;
      if (data.font != null) body.font = data.font;
    } else if (data.caption) {
      body.caption = data.caption;
    }
    return { endpoint: `/message/sendStatus/${instance}`, body };
  }

  if (type === 'buttons') {
    if (!data.title) throw new Error('Buttons: title required');
    if (!Array.isArray(data.buttons) || !data.buttons.length)
      throw new Error('Buttons: add at least one button');
    const buttons = data.buttons.map((b: any) => ({
      type: 'reply',
      reply: { id: b.id, title: b.label },
    }));
    const body: Record<string, unknown> = { number, title: data.title, buttons };
    if (data.description) body.description = data.description;
    if (data.footer) body.footer = data.footer;
    return { endpoint: `/message/sendButtons/${instance}`, body };
  }

  throw new Error(`Unknown item type: ${type}`);
}
