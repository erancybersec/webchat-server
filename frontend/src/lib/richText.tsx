/**
 * WhatsApp-style message text: clickable links plus *bold*, _italic_,
 * ~strikethrough~ and ```monospace``` markers, nested one inside another
 * the way WhatsApp renders them.
 */

const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+\.[^\s]{2,})/g;

type Marker = { re: RegExp; render: (inner: React.ReactNode, key: number) => React.ReactNode };

// each marker requires non-space next to the delimiters, single line, non-greedy
const MARKERS: Marker[] = [
  {
    re: /```([^`\n][\s\S]*?)```/,
    render: (inner, key) => (
      <code key={key} className="font-mono text-[0.92em]">
        {inner}
      </code>
    ),
  },
  {
    re: /\*([^\s*](?:[^*\n]*[^\s*])?)\*/,
    render: (inner, key) => <strong key={key}>{inner}</strong>,
  },
  {
    re: /_([^\s_](?:[^_\n]*[^\s_])?)_/,
    render: (inner, key) => <em key={key}>{inner}</em>,
  },
  {
    re: /~([^\s~](?:[^~\n]*[^\s~])?)~/,
    render: (inner, key) => <s key={key}>{inner}</s>,
  },
];

let keySeq = 0;

function applyMarkers(text: string, depth: number): React.ReactNode[] {
  if (depth >= MARKERS.length) return [text];
  const marker = MARKERS[depth]!;
  const out: React.ReactNode[] = [];
  let rest = text;
  for (;;) {
    const m = marker.re.exec(rest);
    if (!m) break;
    if (m.index > 0) out.push(...applyMarkers(rest.slice(0, m.index), depth + 1));
    out.push(marker.render(applyMarkers(m[1]!, depth + 1), keySeq++));
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(...applyMarkers(rest, depth + 1));
  return out;
}

/** Render message text with links + formatting. Safe: never injects HTML. */
export function renderRichText(text: string): React.ReactNode {
  if (!text) return text;
  const parts = text.split(URL_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    if (i % 2 === 1) {
      // odd indexes are the URL captures from the split
      const href = part.startsWith('http') ? part : `https://${part}`;
      return (
        <a
          key={`u${i}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-blue-600 underline"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </a>
      );
    }
    return <span key={`t${i}`}>{applyMarkers(part, 0)}</span>;
  });
}
